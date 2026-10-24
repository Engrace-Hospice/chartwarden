// ADR-0099 - the family STAFF service rules over a fake store: flag, availability, the care-team predicate, consent-or-no-link, caps, the secrets returned once and
// stored as hashes, supersede on reissue, reply checks (eligibility, closed, nothing to reply to), close / block and the second-person unblock.
// The SQL (eligibility, guards, scope) is proven in the live suite.
import { randomUUID } from "node:crypto";
import { FAMILY_MESSAGING_FLAG_KEY, FAMILY_NOT_ELIGIBLE_CODE } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import { verifyVerificationCode } from "../external-share/external-share-secrets";
import { createFamilyStaffService } from "./family-staff-service";
import type {
  FamilyCaregiverRow,
  FamilyContactRow,
  FamilyStaffStore,
  FamilyStaffTx,
} from "./family-store-types";

const ORG = randomUUID();
const USER = randomUUID();
const PATIENT = randomUUID();
const CAREGIVER = randomUUID();
const CONTACT = randomUUID();
const CHANNEL = randomUUID();
const PEPPER = "p".repeat(32);
const actor = { organizationId: ORG, userId: USER };

const caregiver = (over: Partial<FamilyCaregiverRow> = {}): FamilyCaregiverRow => ({
  patientCaregiverId: CAREGIVER,
  patientId: PATIENT,
  caregiverName: "Pat Daughter",
  relationship: "child",
  isLegalRepresentative: false,
  language: "en",
  reason: "ok",
  providerEntityId: null,
  locationId: null,
  ...over,
});

const contact = (over: Partial<FamilyContactRow> = {}): FamilyContactRow => ({
  contactId: CONTACT,
  patientId: PATIENT,
  patientCaregiverId: CAREGIVER,
  patientName: "Pat Ient",
  caregiverName: "Pat Daughter",
  relationship: "child",
  reason: "ok",
  mode: "standard",
  language: "en",
  closed: false,
  blocked: false,
  blockedBy: null,
  channelId: CHANNEL,
  lastContactMessageAt: new Date(),
  lastStaffReplyAt: null,
  staffSeenThrough: null,
  invitation: null,
  sentLastHour: 0,
  unansweredSince: null,
  hadRevokedInvitation: false,
  dbNow: new Date(),
  ...over,
});

function fakeTx(over: Partial<FamilyStaffTx> = {}) {
  const calls: string[] = [];
  const inserted: Array<{ inviteTokenHash: string; codeHash: string; expiresInDays: number }> = [];
  const tx: FamilyStaffTx = {
    raw: {},
    lockTenant: async () => undefined,
    getSettings: async () => ({
      agencyName: "Agency",
      agencyPhone: "555-0100",
      bereavementPhone: null,
    }),
    putSettings: async (_u, s) => s,
    caregivers: async () => [caregiver()],
    caregiver: async () => caregiver(),
    ensureContact: async () => CONTACT,
    counts: async () => ({ orgDay: 0, creatorDay: 0 }),
    revokeLive: async (_id, _u, reason) => {
      calls.push(`revokeLive:${reason}`);
      return true;
    },
    insertInvitation: async (_u, input) => {
      inserted.push(input);
      return { expiresAt: new Date(Date.now() + 7 * 86_400_000) };
    },
    getContact: async () => contact(),
    listContacts: async () => [contact()],
    setClosed: async () => true,
    setBlocked: async () => true,
    messages: async () => [],
    markSeen: async () => undefined,
    markReplied: async () => {
      calls.push("markReplied");
    },
    ...over,
  };
  return { tx, calls, inserted };
}

function build(
  txOver: Partial<FamilyStaffTx> = {},
  opts: {
    flag?: boolean;
    access?: boolean;
    onTeam?: (patientId: string) => boolean;
    insertMessage?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const f = fakeTx(txOver);
  const store: FamilyStaffStore = { run: (_a, fn) => fn(f.tx) };
  const publish = vi.fn(async () => undefined);
  const service = createFamilyStaffService({
    accessAvailable: opts.access ?? true,
    pepper: PEPPER,
    store,
    outbox: { publish } as never,
    flags: { forOrg: async () => ({ [FAMILY_MESSAGING_FLAG_KEY]: opts.flag ?? true }) },
    cipher: {
      open: async () => "",
      seal: async () => ({ cipher: Buffer.alloc(0), sha256: "" }),
    } as never,
    canAccessPatient: async (_o, _u, patientId) => (opts.onTeam ? opts.onTeam(patientId) : true),
    insertMessage: (opts.insertMessage ??
      vi.fn(async () => ({
        messageId: randomUUID(),
        createdAt: new Date().toISOString(),
        replayed: false,
      }))) as never,
  });
  return { service, publish, ...f };
}

const request = {
  patientId: PATIENT,
  patientCaregiverId: CAREGIVER,
  codeByVoiceConfirmed: true as const,
};

describe("createInvitation", () => {
  it("is the neutral 404 while the flag is off", async () => {
    const { service } = build({}, { flag: false });
    await expect(service.createInvitation(actor, request)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("answers 503 when the deployment cannot key budgets on a real client address", async () => {
    const { service } = build({}, { access: false });
    await expect(service.createInvitation(actor, request)).rejects.toMatchObject({
      code: "FAMILY_ACCESS_UNAVAILABLE",
      statusCode: 503,
    });
  });

  it("is the 404 of an unknown patient for a permission holder who is not on the care team", async () => {
    const { service, inserted } = build({}, { onTeam: () => false });
    await expect(service.createInvitation(actor, request)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(inserted).toHaveLength(0);
  });

  it("requires the by-voice confirmation and a whole number of days", async () => {
    const { service } = build();
    await expect(
      service.createInvitation(actor, { ...request, codeByVoiceConfirmed: false as never }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      service.createInvitation(actor, { ...request, expiresInDays: 31 }),
    ).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it("refuses without the agency's 24-hour number (the not-an-emergency notice needs it)", async () => {
    const { service } = build({
      getSettings: async () => ({ agencyName: null, agencyPhone: null, bereavementPhone: null }),
    });
    await expect(service.createInvitation(actor, request)).rejects.toMatchObject({
      code: "FAMILY_SETTINGS_MISSING",
    });
  });

  it.each([
    "no_consent",
    "part2_restricted",
    "involvement_ended",
    "blocked",
    "patient_status",
  ] as const)("no consent, no link: %s is a reason code and nothing is written", async (reason) => {
    const { service, inserted } = build({ caregiver: async () => caregiver({ reason }) });
    await expect(service.createInvitation(actor, request)).rejects.toMatchObject({
      code: FAMILY_NOT_ELIGIBLE_CODE,
      statusCode: 409,
      details: [{ code: reason }],
    });
    expect(inserted).toHaveLength(0);
  });

  it("refuses a caregiver of another patient with the 404 of an unknown one", async () => {
    const { service } = build({ caregiver: async () => caregiver({ patientId: randomUUID() }) });
    await expect(service.createInvitation(actor, request)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("refuses over the daily caps with 429", async () => {
    const { service } = build({ counts: async () => ({ orgDay: 25, creatorDay: 0 }) });
    await expect(service.createInvitation(actor, request)).rejects.toMatchObject({
      statusCode: 429,
    });
    const second = build({ counts: async () => ({ orgDay: 0, creatorDay: 10 }) });
    await expect(second.service.createInvitation(actor, request)).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it("returns the link token and the code once, stores only hashes (the code under the pepper) and supersedes the older link", async () => {
    const { service, inserted, calls, publish } = build();
    const created = await service.createInvitation(actor, request);
    expect(created.inviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.verificationCode).toMatch(/^\d{8}$/);
    expect(created.agencyPhone).toBe("555-0100");
    expect(inserted).toHaveLength(1);
    const stored = inserted[0]!;
    expect(JSON.stringify(stored)).not.toContain(created.inviteToken);
    expect(JSON.stringify(stored)).not.toContain(created.verificationCode);
    expect(verifyVerificationCode(created.verificationCode, stored.codeHash, PEPPER)).toBe(true);
    // The pepper is part of the secret: without it the stored hash proves nothing.
    expect(verifyVerificationCode(created.verificationCode, stored.codeHash)).toBe(false);
    expect(calls).toContain("revokeLive:superseded");
    expect(publish).toHaveBeenCalledTimes(1);
    const event = JSON.stringify(publish.mock.calls[0]);
    for (const secret of [created.inviteToken, created.verificationCode, PATIENT, CAREGIVER]) {
      expect(event).not.toContain(secret);
    }
  });
});

describe("list and thread", () => {
  it("shows only the contacts of patients the actor's care-team predicate admits", async () => {
    const other = randomUUID();
    const { service } = build(
      {
        listContacts: async () => [
          contact(),
          contact({ contactId: randomUUID(), patientId: other }),
        ],
      },
      { onTeam: (p) => p === PATIENT },
    );
    const rows = await service.list(actor);
    expect(rows.map((r) => r.patientId)).toEqual([PATIENT]);
  });

  it("derives the link state from the database clock", async () => {
    const now = new Date();
    const open = (over: Partial<NonNullable<FamilyContactRow["invitation"]>>) =>
      contact({
        dbNow: now,
        invitation: {
          expiresAt: new Date(now.getTime() + 60_000),
          redeemed: false,
          codeAttempts: 0,
          activeSession: false,
          verifyingSession: false,
          ...over,
        },
      });
    const state = async (row: FamilyContactRow) =>
      (await build({ listContacts: async () => [row] }).service.list(actor))[0]?.linkState;
    expect(await state(open({}))).toBe("not_opened");
    expect(await state(open({ verifyingSession: true, redeemed: true }))).toBe("verifying");
    expect(await state(open({ activeSession: true, redeemed: true }))).toBe("active");
    expect(await state(open({ codeAttempts: 5, redeemed: true }))).toBe("locked");
    expect(await state(open({ expiresAt: new Date(now.getTime() - 1) }))).toBe("expired");
    expect(await state(contact({ hadRevokedInvitation: true }))).toBe("revoked");
    expect(await state(contact())).toBe("none");
  });

  it("is the unknown-id 404 for a thread of a patient outside the actor's team", async () => {
    const { service } = build({}, { onTeam: () => false });
    await expect(service.thread(actor, CONTACT)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("marks the thread received by the care team when staff read it", async () => {
    const markSeen = vi.fn(async () => undefined);
    const { service } = build({ markSeen });
    await service.thread(actor, CONTACT);
    expect(markSeen).toHaveBeenCalledTimes(1);
  });
});

describe("reply", () => {
  it("is refused while the flag is off", async () => {
    const { service } = build({}, { flag: false });
    await expect(service.reply(actor, CONTACT, "hello")).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each(["no_consent", "part2_restricted", "blocked", "not_in_bereavement_plan"] as const)(
    "posts nothing to a contact the eligibility expression refuses (%s)",
    async (reason) => {
      const insertMessage = vi.fn();
      const { service } = build({ getContact: async () => contact({ reason }) }, { insertMessage });
      await expect(service.reply(actor, CONTACT, "hello")).rejects.toMatchObject({
        code: FAMILY_NOT_ELIGIBLE_CODE,
      });
      expect(insertMessage).not.toHaveBeenCalled();
    },
  );

  it("refuses a closed thread, a thread the contact never wrote in, and bad text", async () => {
    const insertMessage = vi.fn();
    const closed = build({ getContact: async () => contact({ closed: true }) }, { insertMessage });
    await expect(closed.service.reply(actor, CONTACT, "hello")).rejects.toMatchObject({
      code: "FAMILY_THREAD_CLOSED",
    });
    const empty = build(
      { getContact: async () => contact({ channelId: null }) },
      { insertMessage },
    );
    await expect(empty.service.reply(actor, CONTACT, "hello")).rejects.toMatchObject({
      statusCode: 409,
    });
    const live = build({}, { insertMessage });
    for (const bad of ["", "   ", "x".repeat(2001), "a\u0000b", 5]) {
      await expect(live.service.reply(actor, CONTACT, bad)).rejects.toMatchObject({
        statusCode: 422,
      });
    }
    expect(insertMessage).not.toHaveBeenCalled();
  });

  it("writes through the family door as the staff author and records the reply instant", async () => {
    const insertMessage = vi.fn(async () => ({
      messageId: randomUUID(),
      createdAt: new Date().toISOString(),
      replayed: false,
    }));
    const { service, calls } = build({}, { insertMessage });
    const sent = await service.reply(actor, CONTACT, "  We are here.  ");
    expect(sent.body).toBe("We are here.");
    expect(insertMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ authorUserId: USER, channelId: CHANNEL, familyThread: "staff" }),
    );
    expect(calls).toContain("markReplied");
  });
});

describe("revoke, close and block", () => {
  it("revoke needs a live link and never the flag", async () => {
    const ok = build({}, { flag: false });
    await expect(ok.service.revoke(actor, CONTACT)).resolves.toBeTruthy();
    expect(ok.publish).toHaveBeenCalledTimes(1);
    const none = build({ revokeLive: async () => false });
    await expect(none.service.revoke(actor, CONTACT)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a manager outside the patient's care team can revoke, but the answer carries no name and no patient id", async () => {
    const { service } = build({}, { onTeam: () => false });
    const out = await service.revoke(actor, CONTACT);
    expect(out).toMatchObject({
      contactId: CONTACT,
      patientName: "",
      displayName: "",
      relationship: "",
      channelId: null,
    });
    expect(out.patientId).toBe(CONTACT);
    expect(JSON.stringify(out)).not.toContain(PATIENT);
    const blocked = await build({}, { onTeam: () => false }).service.setBlocked(
      actor,
      CONTACT,
      true,
    );
    expect(blocked.patientName).toBe("");
  });

  it("close and reopen are 409 when there is nothing to change", async () => {
    const { service } = build({ setClosed: async () => false });
    await expect(service.setClosed(actor, CONTACT, true)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("a block also revokes the link; lifting it by the same person is the second-person 409", async () => {
    const { service, calls } = build();
    await service.setBlocked(actor, CONTACT, true);
    expect(calls).toContain("revokeLive:blocked");
    const refused = build({
      setBlocked: async () => {
        throw new Error(
          "check_violation: message_family_contact_unblock: a block is lifted by a second person",
        );
      },
    });
    await expect(refused.service.setBlocked(actor, CONTACT, false)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe("settings", () => {
  it("trims, nulls empty text and bounds the length", async () => {
    const put = vi.fn(async (_u: string, s: unknown) => s as never);
    const { service } = build({ putSettings: put });
    await service.putSettings(actor, {
      agencyName: "  Hospice  ",
      agencyPhone: "",
      bereavementPhone: null,
    });
    expect(put).toHaveBeenCalledWith(USER, {
      agencyName: "Hospice",
      agencyPhone: null,
      bereavementPhone: null,
    });
    await expect(
      service.putSettings(actor, {
        agencyName: "x".repeat(121),
        agencyPhone: null,
        bereavementPhone: null,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});
