// ADR-0099 - the family CONTACT service rules over a fake store: budgets before any database work, the uniform 404, stages, the second factor (counted before it
// is compared, rotated on success), validation only after the bearer resolves, the send budgets, the closed thread, and "an access that cannot be recorded
// returns nothing". The SQL (liveness AND eligibility in one statement) is proven in the live suite.
import { randomUUID } from "node:crypto";
import { FAMILY_MESSAGING_FLAG_KEY } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import {
  formatSessionToken,
  hashPartnerToken,
  hashVerificationCode,
  newPartnerToken,
} from "../external-share/external-share-secrets";
import { createFamilyContactService } from "./family-contact-service";
import type {
  FamilyContactStore,
  FamilyContactTx,
  FamilyLiveSession,
  FamilySendBudget,
} from "./family-store-types";

const ORG = randomUUID();
const PEPPER = "q".repeat(32);
const CODE = "12345678";
const ip = { ip: "203.0.113.9" };

const live = (over: Partial<FamilyLiveSession> = {}): FamilyLiveSession => ({
  organizationId: ORG,
  sessionId: randomUUID(),
  invitationId: randomUUID(),
  contactId: randomUUID(),
  patientId: randomUUID(),
  stage: "active",
  sessionExpiresAt: new Date(Date.now() + 3_600_000),
  mode: "standard",
  storedMode: "standard",
  closed: false,
  channelId: randomUUID(),
  language: "en",
  staffSeenThrough: null,
  ...over,
});

function fakeTx(session: FamilyLiveSession | null, over: Partial<FamilyContactTx> = {}) {
  const calls: string[] = [];
  const tx: FamilyContactTx = {
    raw: {},
    redeemInvite: async () => ({ invitationId: randomUUID(), expiresAt: new Date(Date.now() + 86_400_000) }),
    insertSession: async () => ({ sessionId: randomUUID() }),
    resolveSession: async () => session,
    takeCodeAttempt: async () => hashVerificationCode(CODE, PEPPER),
    activate: async () => {
      calls.push("activate");
    },
    getSettings: async () => ({ agencyName: "Agency", agencyPhone: "555-0100", bereavementPhone: "555-0199" }),
    switchToBereavement: async () => {
      calls.push("switchToBereavement");
    },
    visibleMessages: async () => [],
    sendBudget: async (): Promise<FamilySendBudget> => ({ lastHour: 0, lastDay: 0, sinceStaffReply: 0 }),
    ensureChannel: async (l) => l.channelId ?? randomUUID(),
    touchContactMessage: async () => {
      calls.push("touch");
    },
    recordAccess: async (_l, action) => {
      calls.push(`access:${action}`);
    },
    ...over,
  };
  return { tx, calls };
}

function build(
  session: FamilyLiveSession | null,
  txOver: Partial<FamilyContactTx> = {},
  opts: { flag?: boolean; insertMessage?: ReturnType<typeof vi.fn> } = {},
) {
  const f = fakeTx(session, txOver);
  const store: FamilyContactStore = { run: (_o, fn) => fn(f.tx) };
  const spent: string[] = [];
  const limiter = { consume: async (key: string) => (spent.push(key), { allowed: true }) };
  const publish = vi.fn(async () => undefined);
  const service = createFamilyContactService({
    store,
    pepper: PEPPER,
    outbox: { publish } as never,
    flags: { forOrg: async () => ({ [FAMILY_MESSAGING_FLAG_KEY]: opts.flag ?? true }) },
    cipher: { open: async () => "hello", seal: async () => ({ cipher: Buffer.alloc(0), sha256: "" }) } as never,
    insertMessage: (opts.insertMessage ?? vi.fn(async () => ({ messageId: randomUUID(), createdAt: new Date().toISOString(), replayed: false }))) as never,
    redeemIpLimiter: limiter,
    verifyIpLimiter: limiter,
    bearerIpLimiter: limiter,
    readLimiter: limiter,
  });
  return { service, spent, publish, ...f };
}

const bearer = (token = newPartnerToken()) => formatSessionToken(ORG, token);

describe("redeem", () => {
  it("spends the per-address budget before anything else, and a wrong shape is the same 404 as a wrong token", async () => {
    const { service, spent } = build(null);
    for (const bad of [undefined, null, {}, { organizationId: "x", token: "y" }, { organizationId: ORG, token: "short" }]) {
      await expect(service.redeem(bad, ip)).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(spent.length).toBe(5);
    expect(spent.every((k) => k === ip.ip)).toBe(true);
  });

  it("is the neutral 404 while the flag is off, and for an unknown link", async () => {
    const off = build(null, {}, { flag: false });
    await expect(off.service.redeem({ organizationId: ORG, token: newPartnerToken() }, ip)).rejects.toMatchObject({ statusCode: 404 });
    const unknown = build(null, { redeemInvite: async () => null });
    await expect(unknown.service.redeem({ organizationId: ORG, token: newPartnerToken() }, ip)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("mints an enrolment-stage bearer for the organisation", async () => {
    const { service } = build(null);
    const out = await service.redeem({ organizationId: ORG, token: newPartnerToken() }, ip);
    expect(out.stage).toBe("enrolment");
    expect(out.sessionToken.startsWith(`${ORG}.`)).toBe(true);
  });
});

describe("the bearer", () => {
  it.each([null, "", "garbage", "11111111-1111-4111-8111-111111111111.short"])("%s is the uniform 404", async (value) => {
    const { service } = build(live());
    await expect(service.state(value, ip)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("no live session (or no longer eligible, which the store reports the same way) is the uniform 404 on every route", async () => {
    const { service } = build(null);
    await expect(service.state(bearer(), ip)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.verify(bearer(), { code: CODE }, ip)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.messages(bearer(), {}, ip)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.send(bearer(), { body: "hi" }, ip)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("the flag off is the uniform 404 even with a live session", async () => {
    const { service } = build(live(), {}, { flag: false });
    await expect(service.state(bearer(), ip)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("answers state with the agency numbers and no patient", async () => {
    const { service } = build(live({ mode: "bereavement", storedMode: "bereavement" }));
    const state = await service.state(bearer(), ip);
    expect(state).toMatchObject({ stage: "active", mode: "bereavement", agencyPhone: "555-0100", bereavementPhone: "555-0199" });
    expect(Object.keys(state)).not.toContain("patientId");
  });

  it("records the switch to bereavement mode once, in the same transaction, and announces it without ids of the person", async () => {
    const { service, calls, publish } = build(live({ mode: "bereavement", storedMode: "standard" }));
    await service.state(bearer(), ip);
    expect(calls).toContain("switchToBereavement");
    expect(JSON.stringify(publish.mock.calls[0])).not.toMatch(/patient|caregiver/i);
  });
});

describe("verify", () => {
  it("validates the code only after the bearer resolved (no oracle for the unauthenticated)", async () => {
    const none = build(null);
    await expect(none.service.verify(bearer(), { code: "nope" }, ip)).rejects.toMatchObject({ statusCode: 404 });
    const held = build(live({ stage: "enrolment" }));
    await expect(held.service.verify(bearer(), { code: "nope" }, ip)).rejects.toMatchObject({ statusCode: 422 });
  });

  it("counts the attempt before comparing: a wrong code is a 422 and the attempt stays counted", async () => {
    const take = vi.fn(async () => hashVerificationCode(CODE, PEPPER));
    const { service } = build(live({ stage: "enrolment" }), { takeCodeAttempt: take });
    await expect(service.verify(bearer(), { code: "00000000" }, ip)).rejects.toMatchObject({ code: "FAMILY_CODE_INVALID", statusCode: 422 });
    expect(take).toHaveBeenCalledTimes(1);
  });

  it("a locked invitation is the uniform 404", async () => {
    const { service } = build(live({ stage: "enrolment" }), { takeCodeAttempt: async () => null });
    await expect(service.verify(bearer(), { code: CODE }, ip)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("the right code (under the pepper) activates and rotates the bearer", async () => {
    const { service, calls } = build(live({ stage: "enrolment" }));
    const out = await service.verify(bearer(), { code: CODE }, ip);
    expect(out.stage).toBe("active");
    expect(out.sessionToken?.startsWith(`${ORG}.`)).toBe(true);
    expect(calls).toContain("activate");
  });

  it("a code hashed WITHOUT the pepper never verifies", async () => {
    const { service } = build(live({ stage: "enrolment" }), { takeCodeAttempt: async () => hashVerificationCode(CODE) });
    await expect(service.verify(bearer(), { code: CODE }, ip)).rejects.toMatchObject({ statusCode: 422 });
  });

  it("an already active session verifies without rotating", async () => {
    const { service, calls } = build(live());
    const out = await service.verify(bearer(), { code: CODE }, ip);
    expect(out.sessionToken).toBeNull();
    expect(calls).not.toContain("activate");
  });
});

describe("messages", () => {
  it("an enrolment-stage session reads nothing", async () => {
    const { service } = build(live({ stage: "enrolment" }));
    await expect(service.messages(bearer(), {}, ip)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("validates the query only for a live bearer", async () => {
    const { service } = build(live());
    await expect(service.messages(bearer(), { limit: 0 }, ip)).rejects.toMatchObject({ statusCode: 422 });
    await expect(service.messages(bearer(), { cursor: "'; drop table x" }, ip)).rejects.toMatchObject({ statusCode: 422 });
  });

  it("shows the contact's own text as 'you' (received once staff have read it) and staff text as the care team, with no staff identity", async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    const t0 = new Date(Date.now() - 60_000).toISOString().replace("T", " ").replace("Z", "+00");
    const { service, calls } = build(live({ staffSeenThrough: new Date() }), {
      visibleMessages: async () => [
        { id: mine, authorKind: "family_contact", bodyCipher: Buffer.alloc(0), bodyKind: "plain", createdAtText: t0 },
        { id: theirs, authorKind: "user", bodyCipher: Buffer.alloc(0), bodyKind: "plain", createdAtText: t0 },
      ],
    });
    const out = await service.messages(bearer(), {}, ip);
    expect(out.messages.map((m) => [m.from, m.receivedByCareTeam])).toEqual([
      ["you", true],
      ["care_team", false],
    ]);
    expect(JSON.stringify(out)).not.toMatch(/author|userId/i);
    expect(calls).toContain("access:read");
  });

  it("a read that cannot be recorded returns nothing", async () => {
    const { service } = build(live(), {
      recordAccess: async () => {
        throw new Error("message_family_access_live");
      },
    });
    await expect(service.messages(bearer(), {}, ip)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("send", () => {
  it("is refused for an enrolment-stage session", async () => {
    const { service } = build(live({ stage: "enrolment" }));
    await expect(service.send(bearer(), { body: "hi" }, ip)).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each(["", "   ", "x".repeat(2001), "a\u0007b", 12, undefined])("rejects bad text %#", async (body) => {
    const insertMessage = vi.fn();
    const { service } = build(live(), {}, { insertMessage });
    await expect(service.send(bearer(), { body }, ip)).rejects.toMatchObject({ statusCode: 422 });
    expect(insertMessage).not.toHaveBeenCalled();
  });

  it("accepts exactly 2,000 characters, counted as characters not bytes", async () => {
    const { service } = build(live());
    await expect(service.send(bearer(), { body: "\u{1F642}".repeat(2000) }, ip)).resolves.toBeTruthy();
  });

  it("a closed thread answers a plain 409 and writes nothing", async () => {
    const insertMessage = vi.fn();
    const { service } = build(live({ closed: true }), {}, { insertMessage });
    await expect(service.send(bearer(), { body: "hi" }, ip)).rejects.toMatchObject({ code: "FAMILY_THREAD_CLOSED", statusCode: 409 });
    expect(insertMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["the hourly budget", { lastHour: 10, lastDay: 10, sinceStaffReply: 3 }],
    ["the daily budget", { lastHour: 1, lastDay: 40, sinceStaffReply: 3 }],
    ["the unanswered cap", { lastHour: 1, lastDay: 1, sinceStaffReply: 200 }],
  ])("%s answers 429 and writes nothing", async (_name, budget) => {
    const insertMessage = vi.fn();
    const { service } = build(live(), { sendBudget: async () => budget }, { insertMessage });
    await expect(service.send(bearer(), { body: "hi" }, ip)).rejects.toMatchObject({ statusCode: 429 });
    expect(insertMessage).not.toHaveBeenCalled();
  });

  it("writes through the family door with NO user author and leaves a send trail row", async () => {
    const insertMessage = vi.fn(async () => ({ messageId: randomUUID(), createdAt: new Date().toISOString(), replayed: false }));
    const { service, calls } = build(live(), {}, { insertMessage });
    await service.send(bearer(), { body: "  Is mom comfortable?  " }, ip);
    expect(insertMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ authorUserId: null, familyThread: "contact", body: "Is mom comfortable?" }),
    );
    expect(calls).toEqual(expect.arrayContaining(["touch", "access:send"]));
  });

  it("takes the conversation from the invitation row, never from the request", async () => {
    const insertMessage = vi.fn(async () => ({ messageId: randomUUID(), createdAt: new Date().toISOString(), replayed: false }));
    const session = live();
    const { service } = build(session, {}, { insertMessage });
    await service.send(bearer(), { body: "hi", channelId: randomUUID(), contactId: randomUUID() }, ip);
    expect((insertMessage.mock.calls[0] as unknown[])[2]).toMatchObject({ channelId: session.channelId });
  });

  it("a send that cannot be recorded returns nothing", async () => {
    const { service } = build(live(), {
      recordAccess: async () => {
        throw new Error("message_family_access_live");
      },
    });
    await expect(service.send(bearer(), { body: "hi" }, ip)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("the bearer is hashed, never stored", () => {
  it("looks the session up by the sha256 of the token", async () => {
    const resolve = vi.fn(async () => live());
    const { service } = build(null, { resolveSession: resolve });
    const token = newPartnerToken();
    await service.state(formatSessionToken(ORG, token), ip);
    expect(resolve).toHaveBeenCalledWith(hashPartnerToken(token));
  });
});
