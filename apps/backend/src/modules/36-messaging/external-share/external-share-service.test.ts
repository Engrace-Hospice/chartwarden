// ADR-0096 - the external partner share service rules over fake stores: flag, validation, refused kinds, caps, budgets before any database work,
// the second factor, stages, and "a read that cannot be recorded returns nothing". The SQL (liveness, scope, guards) is proven in the live suite.
import { randomUUID } from "node:crypto";
import { EXTERNAL_PARTNERS_FLAG_KEY } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import {
  formatSessionToken,
  hashPartnerToken,
  hashVerificationCode,
  newPartnerToken,
} from "./external-share-secrets";
import { createExternalShareService } from "./external-share-service";
import type {
  LiveSession,
  PartnerTx,
  SharePartnerStore,
  ShareRow,
  ShareStaffStore,
  StaffTx,
} from "./external-share-store";

const ORG = randomUUID();
const USER = randomUUID();
const CHANNEL = randomUUID();
const actor = { organizationId: ORG, userId: USER };

const row = (over: Partial<ShareRow> = {}): ShareRow => ({
  id: randomUUID(),
  channelId: CHANNEL,
  channelTitle: "t",
  partnerName: "P",
  partnerKind: "pharmacy",
  sharedFrom: new Date(),
  expiresAt: new Date(Date.now() + 86_400_000),
  createdAt: new Date(),
  createdBy: USER,
  revokedAt: null,
  redeemed: false,
  codeAttempts: 0,
  dbNow: new Date(),
  ...over,
});

function staffFake(over: Partial<StaffTx> = {}) {
  const inserted: unknown[] = [];
  const tx: StaffTx = {
    raw: {},
    channelKind: async () => "discipline",
    lockTenant: async () => undefined,
    counts: async () => ({ live: 0, creatorDay: 0 }),
    insertShare: async (_u, input) => {
      inserted.push(input);
      return row({ channelId: input.channelId });
    },
    getShare: async () => row(),
    revoke: async () => row({ revokedAt: new Date() }),
    listShares: async () => [],
    ...over,
  };
  const store: ShareStaffStore = { run: async (_a, fn) => fn(tx) };
  return { store, inserted };
}

const outbox = () => ({ publish: vi.fn(async () => undefined) });
const validBody = {
  channelId: CHANNEL,
  partnerName: " Northside ",
  partnerKind: "pharmacy" as const,
  baaReference: "BAA-1",
};
const flags = (on: boolean) => ({ forOrg: async () => ({ [EXTERNAL_PARTNERS_FLAG_KEY]: on }) });

describe("staff side", () => {
  it("flag off or absent: create is the neutral 404 and touches nothing", async () => {
    const { store } = staffFake();
    const run = vi.spyOn(store, "run");
    for (const f of [flags(false), undefined]) {
      const svc = createExternalShareService({
        staffStore: store,
        partnerStore: {} as never,
        outbox: outbox(),
        flags: f,
      });
      await expect(svc.create(actor, validBody)).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("validates before any write: expiry, names, kind, uuid", async () => {
    const { store, inserted } = staffFake();
    const svc = createExternalShareService({
      staffStore: store,
      partnerStore: {} as never,
      outbox: outbox(),
      flags: flags(true),
    });
    for (const bad of [
      { ...validBody, expiresInDays: 31 },
      { ...validBody, expiresInDays: 0 },
      { ...validBody, expiresInDays: 1.5 },
      { ...validBody, partnerName: "  " },
      { ...validBody, baaReference: "" },
      { ...validBody, partnerKind: "hospital" as never },
      { ...validBody, channelId: "nope" },
    ]) {
      await expect(svc.create(actor, bad)).rejects.toMatchObject({ statusCode: 422 });
    }
    expect(inserted).toHaveLength(0);
  });

  it("creates with trimmed input, the 7 day default, hashes only, and returns the secrets once", async () => {
    const { store, inserted } = staffFake();
    const ob = outbox();
    const svc = createExternalShareService({
      staffStore: store,
      partnerStore: {} as never,
      outbox: ob,
      flags: flags(true),
    });
    const made = await svc.create(actor, validBody);
    expect(made.inviteToken).toHaveLength(43);
    expect(made.verificationCode).toMatch(/^\d{8}$/);
    const stored = inserted[0] as Record<string, unknown>;
    expect(stored).toMatchObject({ partnerName: "Northside", expiresInDays: 7 });
    expect(JSON.stringify(stored)).not.toContain(made.inviteToken);
    expect(JSON.stringify(stored)).not.toContain(made.verificationCode);
    expect(ob.publish).toHaveBeenCalledTimes(1);
  });

  it("a channel of a kind that may never be shared, and an unknown one, are the same 404", async () => {
    for (const kind of ["care_team", "bereavement", "announcement", null]) {
      const { store, inserted } = staffFake({ channelKind: async () => kind });
      const svc = createExternalShareService({
        staffStore: store,
        partnerStore: {} as never,
        outbox: outbox(),
        flags: flags(true),
      });
      await expect(svc.create(actor, validBody)).rejects.toMatchObject({
        statusCode: 404,
        message: "conversation not found",
      });
      expect(inserted).toHaveLength(0);
    }
  });

  it("the caps are 429: 10 live per tenant, 3 per creator per day", async () => {
    for (const counts of [
      { live: 10, creatorDay: 0 },
      { live: 0, creatorDay: 3 },
    ]) {
      const { store, inserted } = staffFake({ counts: async () => counts });
      const svc = createExternalShareService({
        staffStore: store,
        partnerStore: {} as never,
        outbox: outbox(),
        flags: flags(true),
      });
      await expect(svc.create(actor, validBody)).rejects.toMatchObject({
        statusCode: 429,
        code: "EXTERNAL_SHARE_LIMIT",
      });
      expect(inserted).toHaveLength(0);
    }
  });

  it("without an outbox nothing is written (fail closed), for create and revoke", async () => {
    const { store, inserted } = staffFake();
    const svc = createExternalShareService({
      staffStore: store,
      partnerStore: {} as never,
      flags: flags(true),
    });
    await expect(svc.create(actor, validBody)).rejects.toMatchObject({ statusCode: 503 });
    await expect(svc.revoke(actor, randomUUID())).rejects.toMatchObject({ statusCode: 503 });
    expect(inserted).toHaveLength(0);
  });

  it("revoke: unknown is 404, already revoked is 409, and it does not read the flag", async () => {
    const unknown = staffFake({ getShare: async () => null });
    const svcA = createExternalShareService({
      staffStore: unknown.store,
      partnerStore: {} as never,
      outbox: outbox(),
      flags: flags(false),
    });
    await expect(svcA.revoke(actor, randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    const done = staffFake({ revoke: async () => null });
    const svcB = createExternalShareService({
      staffStore: done.store,
      partnerStore: {} as never,
      outbox: outbox(),
      flags: flags(false),
    });
    await expect(svcB.revoke(actor, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    const ok = staffFake();
    const svcC = createExternalShareService({
      staffStore: ok.store,
      partnerStore: {} as never,
      outbox: outbox(),
      flags: flags(false),
    });
    expect((await svcC.revoke(actor, randomUUID())).status).toBe("revoked");
  });
});

// ── partner side ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const CODE = "12345678";
function partnerFake(live: Partial<LiveSession> | null, over: Partial<PartnerTx> = {}) {
  const calls = { attempts: 0, activated: 0, reads: [] as number[], runs: 0 };
  const session: LiveSession | null = live && {
    organizationId: ORG,
    sessionId: randomUUID(),
    shareId: live.shareId ?? randomUUID(),
    stage: "active",
    channelId: CHANNEL,
    channelKind: "discipline",
    partnerName: "P",
    shareExpiresAt: new Date(Date.now() + 1000),
    sharedFrom: new Date(),
    ...live,
  };
  const tx: PartnerTx = {
    raw: {},
    redeemInvite: async () => null,
    insertSession: async () => ({ sessionId: randomUUID() }),
    resolveSession: async () => session,
    takeCodeAttempt: async () => {
      calls.attempts += 1;
      return calls.attempts > 5 ? null : hashVerificationCode(CODE);
    },
    activate: async () => {
      calls.activated += 1;
    },
    visibleMessages: async () => [],
    recordRead: async (_l, n) => {
      calls.reads.push(n);
    },
    ...over,
  };
  const store: SharePartnerStore = {
    run: async (_o, fn) => {
      calls.runs += 1;
      return fn(tx);
    },
  };
  return { store, calls, session };
}
const bearerFor = () => formatSessionToken(ORG, newPartnerToken());

describe("partner side", () => {
  it("flag off: every partner entry point is the neutral 404 before any database work", async () => {
    const p = partnerFake({});
    const svc = createExternalShareService({
      staffStore: {} as never,
      partnerStore: p.store,
      flags: flags(false),
      cipher: { open: async () => "" },
    });
    const id = randomUUID();
    await expect(
      svc.redeem({ organizationId: ORG, token: newPartnerToken() }, { ip: "1.1.1.1" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.state(bearerFor(), id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.verify(bearerFor(), id, CODE, { ip: "x" })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(svc.messages(bearerFor(), id, {})).rejects.toMatchObject({ statusCode: 404 });
    expect(p.calls.runs).toBe(0);
  });

  it("the redeem budgets are spent before any database work: over budget is 429 with no query", async () => {
    const p = partnerFake({});
    const svc = createExternalShareService({
      staffStore: {} as never,
      partnerStore: p.store,
      flags: flags(true),
      redeemIpLimiter: { consume: async () => ({ allowed: false }) },
    });
    await expect(
      svc.redeem({ organizationId: ORG, token: newPartnerToken() }, { ip: "1.1.1.1" }),
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(p.calls.runs).toBe(0);
  });

  it("an unknown, used or revoked invitation is the neutral 404; a good one returns an org-bound bearer", async () => {
    const miss = partnerFake({});
    const svc = createExternalShareService({
      staffStore: {} as never,
      partnerStore: miss.store,
      flags: flags(true),
    });
    await expect(
      svc.redeem({ organizationId: ORG, token: newPartnerToken() }, { ip: "i" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const shareId = randomUUID();
    const hit = partnerFake(
      {},
      { redeemInvite: async () => ({ shareId, expiresAt: new Date(Date.now() + 1000) }) },
    );
    const svc2 = createExternalShareService({
      staffStore: {} as never,
      partnerStore: hit.store,
      flags: flags(true),
    });
    const out = await svc2.redeem({ organizationId: ORG, token: newPartnerToken() }, { ip: "i" });
    expect(out).toMatchObject({ shareId, stage: "enrolment" });
    expect(out.sessionToken.startsWith(`${ORG}.`)).toBe(true);
  });

  it("a bearer that is malformed, unknown, or for another share is the same 404", async () => {
    const own = randomUUID();
    const p = partnerFake({ shareId: own });
    const svc = createExternalShareService({
      staffStore: {} as never,
      partnerStore: p.store,
      flags: flags(true),
    });
    await expect(svc.state(null, own)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.state("garbage", own)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.state(bearerFor(), randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.state(bearerFor(), "not-a-uuid")).rejects.toMatchObject({ statusCode: 404 });
    expect((await svc.state(bearerFor(), own)).shareId).toBe(own);
    const gone = partnerFake(null);
    const svc2 = createExternalShareService({
      staffStore: {} as never,
      partnerStore: gone.store,
      flags: flags(true),
    });
    await expect(svc2.state(bearerFor(), own)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("verify: a wrong code is 422 and COUNTED; the right code activates; the sixth attempt is a 404", async () => {
    const shareId = randomUUID();
    const p = partnerFake({ shareId, stage: "enrolment" });
    const svc = createExternalShareService({
      staffStore: {} as never,
      partnerStore: p.store,
      flags: flags(true),
    });
    await expect(svc.verify(bearerFor(), shareId, "00000000", { ip: "i" })).rejects.toMatchObject({
      statusCode: 422,
      code: "EXTERNAL_SHARE_CODE_INVALID",
    });
    expect(p.calls).toMatchObject({ attempts: 1, activated: 0 });
    expect((await svc.verify(bearerFor(), shareId, CODE, { ip: "i" })).stage).toBe("active");
    expect(p.calls.activated).toBe(1);
    for (let i = 0; i < 4; i += 1)
      await svc.verify(bearerFor(), shareId, "00000000", { ip: "i" }).catch(() => undefined);
    await expect(svc.verify(bearerFor(), shareId, CODE, { ip: "i" })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("verify on an already active session spends no attempt", async () => {
    const shareId = randomUUID();
    const p = partnerFake({ shareId, stage: "active" });
    const svc = createExternalShareService({
      staffStore: {} as never,
      partnerStore: p.store,
      flags: flags(true),
    });
    expect((await svc.verify(bearerFor(), shareId, "00000000", { ip: "i" })).stage).toBe("active");
    expect(p.calls.attempts).toBe(0);
  });

  it("messages: enrolment stage and a never-shareable channel kind read nothing", async () => {
    const shareId = randomUUID();
    for (const live of [
      { shareId, stage: "enrolment" as const },
      { shareId, channelKind: "care_team" },
    ]) {
      const p = partnerFake(live);
      const svc = createExternalShareService({
        staffStore: {} as never,
        partnerStore: p.store,
        flags: flags(true),
        cipher: { open: async () => "x" },
      });
      await expect(svc.messages(bearerFor(), shareId, {})).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(p.calls.reads).toHaveLength(0);
    }
  });

  it("messages: decrypts, pages with a cursor, records ONE trail row with the count before returning", async () => {
    const shareId = randomUUID();
    const mk = (n: number) => ({
      id: randomUUID(),
      authorName: "Ann",
      bodyCipher: Buffer.from(`c${n}`),
      bodyKind: "plain",
      status: n === 2 ? "edited" : "sent",
      createdAtText: `2026-10-23 10:00:0${n}.000001+00`,
    });
    const rows = [mk(1), mk(2), mk(3)];
    const p = partnerFake(
      { shareId },
      { visibleMessages: async (_l, _a, limit) => rows.slice(0, limit) },
    );
    const svc = createExternalShareService({
      staffStore: {} as never,
      partnerStore: p.store,
      flags: flags(true),
      cipher: { open: async (_o, c) => `plain-${c.toString()}` },
    });
    const page = await svc.messages(bearerFor(), shareId, { limit: 2 });
    expect(page.messages.map((m) => m.body)).toEqual(["plain-c1", "plain-c2"]);
    expect(page.messages[1]?.edited).toBe(true);
    expect(page.nextCursor).toBe(`${rows[1]?.createdAtText}|${rows[1]?.id}`);
    expect(p.calls.reads).toEqual([2]);
    await expect(svc.messages(bearerFor(), shareId, { cursor: "junk" })).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it("messages: a trail row that cannot be written returns nothing (404); an undecryptable body is a 503; the read budget is 429", async () => {
    const shareId = randomUUID();
    const msg = {
      id: randomUUID(),
      authorName: null,
      bodyCipher: Buffer.from("c"),
      bodyKind: "plain",
      status: "sent",
      createdAtText: "2026-10-23 10:00:00+00",
    };
    const cipher = { open: async () => "hello" };
    const failing = partnerFake(
      { shareId },
      {
        visibleMessages: async () => [msg],
        recordRead: async () => {
          throw new Error("guard");
        },
      },
    );
    const a = createExternalShareService({
      staffStore: {} as never,
      partnerStore: failing.store,
      flags: flags(true),
      cipher,
    });
    await expect(a.messages(bearerFor(), shareId, {})).rejects.toMatchObject({ statusCode: 404 });
    const broken = partnerFake({ shareId }, { visibleMessages: async () => [msg] });
    const b = createExternalShareService({
      staffStore: {} as never,
      partnerStore: broken.store,
      flags: flags(true),
      cipher: {
        open: async () => {
          throw new Error("key");
        },
      },
    });
    await expect(b.messages(bearerFor(), shareId, {})).rejects.toMatchObject({ statusCode: 503 });
    expect(broken.calls.reads).toHaveLength(0);
    const limited = partnerFake({ shareId });
    const c = createExternalShareService({
      staffStore: {} as never,
      partnerStore: limited.store,
      flags: flags(true),
      cipher,
      readLimiter: { consume: async () => ({ allowed: false }) },
    });
    await expect(c.messages(bearerFor(), shareId, {})).rejects.toMatchObject({ statusCode: 429 });
    expect(limited.calls.reads).toHaveLength(0);
    expect(hashPartnerToken("x")).toHaveLength(64);
  });
});
