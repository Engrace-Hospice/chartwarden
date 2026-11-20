// M39-T05 — the published ConsentEvaluator seam over the in-memory store.
import { describe, expect, it } from "vitest";
import {
  type StoredConsent,
  createConsentEvaluator,
  createInMemoryConsentStore,
} from "../src/seams/consent-evaluator";

const ORG = "org-1";
const PAT = "pat-1";

function consent(over: Partial<StoredConsent> = {}): StoredConsent {
  return {
    id: "c1",
    organizationId: ORG,
    patientId: PAT,
    typeKey: "hipaa_release",
    status: "active",
    version: 1,
    effectiveAtMs: 1000,
    expiresAtMs: null,
    survivesDeath: false,
    scopeDescriptor: { all: true },
    recipients: [],
    ...over,
  };
}

function evalWith(consents: StoredConsent[], deceased: string[] = []) {
  const { store } = createInMemoryConsentStore({
    consents,
    deceasedPatientIds: new Set(deceased),
  });
  return createConsentEvaluator(store);
}

describe("ConsentEvaluator.evaluate (§4.3)", () => {
  const ctx = { sessionContext: { sessionClass: "staff" as const }, callerModule: "m5" };

  it("denies with no_active_consent_on_file when none exists", async () => {
    const r = await evalWith([]).evaluate({
      organizationId: ORG,
      patientId: PAT,
      consentType: "hipaa_release",
      ...ctx,
    });
    expect(r.allowed).toBe(false);
    expect(r.denyReason).toBe("no_active_consent_on_file");
  });

  it("allows on an active record and returns id + version", async () => {
    const r = await evalWith([
      consent({ recipients: [{ removedAtMs: null, expiresAtMs: null, recipientResolvedId: "x" }] }),
    ]).evaluate({
      organizationId: ORG,
      patientId: PAT,
      consentType: "hipaa_release",
      asOf: new Date(5000).toISOString(),
      ...ctx,
    });
    expect(r.allowed).toBe(true);
    expect(r.consentRecordId).toBe("c1");
    expect(r.consentVersionAtEval).toBe(1);
  });

  it("reports consent_expired for an expired record", async () => {
    const r = await evalWith([consent({ status: "expired", expiresAtMs: 2000 })]).evaluate({
      organizationId: ORG,
      patientId: PAT,
      consentType: "hipaa_release",
      asOf: new Date(5000).toISOString(),
      ...ctx,
    });
    expect(r.allowed).toBe(false);
    expect(r.denyReason).toBe("consent_expired");
  });

  it("a per-recipient consent with zero active recipients denies no_active_recipient_matches", async () => {
    const r = await evalWith([
      consent({ typeKey: "42_cfr_part_2_release", recipients: [] }),
    ]).evaluate({
      organizationId: ORG,
      patientId: PAT,
      consentType: "42_cfr_part_2_release",
      asOf: new Date(5000).toISOString(),
      ...ctx,
    });
    expect(r.allowed).toBe(false);
    expect(r.denyReason).toBe("no_active_recipient_matches");
  });

  it("D13 post-death: a non-surviving consent terminates on death", async () => {
    const r = await evalWith([consent()], [PAT]).evaluate({
      organizationId: ORG,
      patientId: PAT,
      consentType: "hipaa_release",
      asOf: new Date(5000).toISOString(),
      ...ctx,
    });
    expect(r.allowed).toBe(false);
    expect(r.denyReason).toBe("patient_deceased_consent_terminated");
  });
});

describe("ConsentEvaluator.evaluateForDisclosure (§4.3.1 fail-closed)", () => {
  it("redacts everything when no Part 2 release names the recipient", async () => {
    const r = await evalWith([]).evaluateForDisclosure({
      organizationId: ORG,
      patientId: PAT,
      recipientResolvedId: "r1",
      callerModule: "m28",
    });
    expect(r.redactSudContent).toBe(true);
    expect(r.redactHivContent).toBe(true);
    expect(r.redactMentalHealthContent).toBe(true);
    expect(r.redactGeneticContent).toBe(true);
    expect(r.redactFamilyViolenceContent).toBe(true);
  });

  it("discloses SUD only when an active Part 2 release names the recipient (HIV/MH/genetic still redacted)", async () => {
    const r = await evalWith([
      consent({
        typeKey: "42_cfr_part_2_release",
        recipients: [{ removedAtMs: null, expiresAtMs: null, recipientResolvedId: "r1" }],
      }),
    ]).evaluateForDisclosure({
      organizationId: ORG,
      patientId: PAT,
      recipientResolvedId: "r1",
      asOf: new Date(5000).toISOString(),
      callerModule: "m28",
    });
    expect(r.redactSudContent).toBe(false);
    expect(r.redactHivContent).toBe(true); // delegated to M5 → default redact
  });
});

describe("ConsentEvaluator.evaluateBulk (§4.3 / M39-F15)", () => {
  it("returns a per-patient verdict map", async () => {
    // portal_access is categorical (not per-recipient), so an active record alone is sufficient.
    const r = await evalWith([
      consent({ patientId: "pat-2", typeKey: "portal_access", recipients: [] }),
    ]).evaluateBulk({
      organizationId: ORG,
      patientIds: ["pat-1", "pat-2"],
      consentType: "portal_access",
      asOf: new Date(5000).toISOString(),
      callerModule: "m33",
    });
    expect(r.get("pat-1")?.allowed).toBe(false);
    expect(r.get("pat-2")?.allowed).toBe(true);
  });
});

describe("ConsentEvaluator.evaluate pinned to one record (`consentRecordId`, M16 D6)", () => {
  const ctx = { sessionContext: { sessionClass: "staff" as const }, callerModule: "m16" };
  const asOf = new Date(5000).toISOString();
  const outreach = (over: Partial<StoredConsent>) =>
    consent({ typeKey: "bereavement_outreach_consent", ...over });
  const evaluatePinned = (consents: StoredConsent[], consentRecordId: string) =>
    evalWith(consents).evaluate({
      organizationId: ORG,
      patientId: PAT,
      consentType: "bereavement_outreach_consent",
      consentRecordId,
      asOf,
      ...ctx,
    });

  it("allows only when THAT record is active — another person's active record does not count", async () => {
    const consents = [
      outreach({ id: "mine", status: "draft" }),
      outreach({ id: "someone-else", status: "active", version: 2 }),
    ];
    const pinned = await evaluatePinned(consents, "mine");
    expect(pinned).toMatchObject({ allowed: false, denyReason: "no_active_consent_on_file" });

    const other = await evaluatePinned(consents, "someone-else");
    expect(other).toMatchObject({ allowed: true, consentRecordId: "someone-else" });
  });

  it("a revoked pinned record denies consent_revoked; an unknown id denies no_active_consent_on_file", async () => {
    const consents = [outreach({ id: "r1", status: "revoked" })];
    expect(await evaluatePinned(consents, "r1")).toMatchObject({
      allowed: false,
      denyReason: "consent_revoked",
    });
    expect(await evaluatePinned(consents, "nope")).toMatchObject({
      allowed: false,
      denyReason: "no_active_consent_on_file",
    });
  });
});

// A row's status is its CURRENT status. `historical` asks the other question — was the record in force at `asOf` — and answers it
// from the row's own end instant (`endedAtMs`); without it the answer is unchanged, so no disclosure gate can start allowing a
// consent that has since ended (visit-note drafting reads what was on file at a visit, VN-D11).
describe("ConsentEvaluator.evaluate historical (was it in force at `asOf`)", () => {
  const ctx = { sessionContext: { sessionClass: "staff" as const }, callerModule: "m8" };
  const ack = (over: Partial<StoredConsent>) =>
    consent({ typeKey: "advance_directive_acknowledgment", effectiveAtMs: 1000, ...over });
  const evaluateAt = (
    consents: StoredConsent[],
    asOfMs: number,
    historical?: boolean,
    deceased: string[] = [],
  ) =>
    evalWith(consents, deceased).evaluate({
      organizationId: ORG,
      patientId: PAT,
      consentType: "advance_directive_acknowledgment",
      asOf: new Date(asOfMs).toISOString(),
      ...(historical === undefined ? {} : { historical }),
      ...ctx,
    });

  it.each([
    ["revoked", { status: "revoked" as const, endedAtMs: 6000 }],
    ["superseded", { status: "superseded" as const, endedAtMs: 6000 }],
    ["expired", { status: "expired" as const, endedAtMs: 6000 }],
  ])("a %s record that ended after `asOf` was in force then", async (_status, over) => {
    const result = await evaluateAt([ack({ id: "a1", ...over })], 5000, true);
    expect(result).toMatchObject({ allowed: true, consentRecordId: "a1" });
  });

  it.each([
    ["revoked", "consent_revoked"],
    ["expired", "consent_expired"],
    ["superseded", "no_active_consent_on_file"],
  ] as const)("a %s record that ended at or before `asOf` is not in force then", async (status, reason) => {
    for (const endedAtMs of [5000, 4000]) {
      const result = await evaluateAt([ack({ status, endedAtMs })], 5000, true);
      expect(result).toMatchObject({ allowed: false, denyReason: reason });
    }
  });

  it("a record whose end instant is unknown is not in force then (fail closed)", async () => {
    for (const endedAtMs of [undefined, null]) {
      const result = await evaluateAt(
        [ack({ status: "revoked", ...(endedAtMs === undefined ? {} : { endedAtMs }) })],
        5000,
        true,
      );
      expect(result.allowed).toBe(false);
    }
  });

  it("never allows a draft record, one effective after `asOf`, or one whose own expiry had passed", async () => {
    expect((await evaluateAt([ack({ status: "draft", endedAtMs: 9000 })], 5000, true)).allowed).toBe(
      false,
    );
    expect(
      (await evaluateAt([ack({ status: "revoked", endedAtMs: 9000, effectiveAtMs: 5001 })], 5000, true))
        .allowed,
    ).toBe(false);
    expect(
      (
        await evaluateAt(
          [ack({ status: "revoked", endedAtMs: 9000, expiresAtMs: 5000 })],
          5000,
          true,
        )
      ).allowed,
    ).toBe(false);
  });

  it("without `historical` (or with it false) an ended record still denies, so existing callers are unchanged", async () => {
    const ended = [ack({ status: "revoked", endedAtMs: 6000 })];
    for (const historical of [undefined, false]) {
      expect(await evaluateAt(ended, 5000, historical)).toMatchObject({
        allowed: false,
        denyReason: "consent_revoked",
      });
    }
  });

  it("the highest-version record in force at `asOf` governs, not the one that replaced it later", async () => {
    const result = await evaluateAt(
      [
        ack({ id: "old", version: 1, status: "superseded", endedAtMs: 6000 }),
        ack({ id: "new", version: 2, status: "active", effectiveAtMs: 6000 }),
      ],
      5000,
      true,
    );
    expect(result).toMatchObject({ allowed: true, consentRecordId: "old" });
  });
});
