// M39-T05 — the published ConsentEvaluator seam over the in-memory store.
import { describe, expect, it } from "vitest";
import {
  type StoredConsent,
  createConsentEvaluator,
  createInMemoryConsentStore,
} from "../src/seams/consent-evaluator";

const ORG = "org-1";
const PAT = "pat-1";

function consent(over: Partial<StoredConsent>): StoredConsent {
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
    const r = await evalWith([]).evaluate({ organizationId: ORG, patientId: PAT, consentType: "hipaa_release", ...ctx });
    expect(r.allowed).toBe(false);
    expect(r.denyReason).toBe("no_active_consent_on_file");
  });

  it("allows on an active record and returns id + version", async () => {
    const r = await evalWith([consent({ recipients: [{ removedAtMs: null, expiresAtMs: null, recipientResolvedId: "x" }] })]).evaluate(
      { organizationId: ORG, patientId: PAT, consentType: "hipaa_release", asOf: new Date(5000).toISOString(), ...ctx },
    );
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
    const r = await evalWith([consent({ typeKey: "42_cfr_part_2_release", recipients: [] })]).evaluate({
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
    const r = await evalWith([]).evaluateForDisclosure({ organizationId: ORG, patientId: PAT, recipientResolvedId: "r1", callerModule: "m28" });
    expect(r.redactSudContent).toBe(true);
    expect(r.redactHivContent).toBe(true);
    expect(r.redactMentalHealthContent).toBe(true);
    expect(r.redactGeneticContent).toBe(true);
    expect(r.redactFamilyViolenceContent).toBe(true);
  });

  it("discloses SUD only when an active Part 2 release names the recipient (HIV/MH/genetic still redacted)", async () => {
    const r = await evalWith([
      consent({ typeKey: "42_cfr_part_2_release", recipients: [{ removedAtMs: null, expiresAtMs: null, recipientResolvedId: "r1" }] }),
    ]).evaluateForDisclosure({ organizationId: ORG, patientId: PAT, recipientResolvedId: "r1", asOf: new Date(5000).toISOString(), callerModule: "m28" });
    expect(r.redactSudContent).toBe(false);
    expect(r.redactHivContent).toBe(true); // delegated to M5 → default redact
  });
});

describe("ConsentEvaluator.evaluateBulk (§4.3 / M39-F15)", () => {
  it("returns a per-patient verdict map", async () => {
    // portal_access is categorical (not per-recipient), so an active record alone is sufficient.
    const r = await evalWith([consent({ patientId: "pat-2", typeKey: "portal_access", recipients: [] })]).evaluateBulk({
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
