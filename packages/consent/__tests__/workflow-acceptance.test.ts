// M39-T09 — §7 Workflow Acceptance Criteria (W-CON-01/02/03/05/06/07/08/09), composing the M39
// engines end-to-end. W-CON-04 (SUD detection from M22 DocLens) and W-CON-10..12 (FHIR egress /
// post-mortem bereavement UI / portal self-revoke) need M22/M28/M31 and land in T11 / future waves.
import { describe, expect, it } from "vitest";
import {
  type StoredConsent,
  createConsentEvaluator,
  createInMemoryConsentRouteService,
  createInMemoryConsentStore,
  dueReminders,
  nextCascadeStatus,
  validateConsentOverlay,
  validateGrantorChain,
  decideDeceasedConsentExpiry,
} from "../src/index";

const ORG = "org-1";
const PAT = "pt-1";
const DAY = 24 * 60 * 60 * 1000;

function part2(over: Partial<StoredConsent>): StoredConsent {
  return {
    id: "c-part2",
    organizationId: ORG,
    patientId: PAT,
    typeKey: "42_cfr_part_2_release",
    status: "active",
    version: 0,
    effectiveAtMs: 0,
    expiresAtMs: null,
    survivesDeath: false,
    scopeDescriptor: {},
    recipients: [],
    ...over,
  };
}

describe("W-CON-01 — initial admission consent capture (§7.1)", () => {
  it("captures hipaa_release + portal_access, both active on the dashboard", () => {
    const { service } = createInMemoryConsentRouteService();
    const now = new Date().toISOString();
    for (const typeKey of ["hipaa_release", "portal_access"] as const) {
      const d = service.createDraft(ORG, {
        patientId: PAT,
        typeKey,
        grantorKind: "patient_self",
        captureMethod: "typed_signature_in_app",
        scopeDescriptor: {},
        createdById: "intake-rn",
      });
      service.signConsent(ORG, d.id, "intake-rn", now);
    }
    const active = service.listConsentsForPatient(ORG, PAT);
    expect(active.map((r) => r.typeKey).sort()).toEqual(["hipaa_release", "portal_access"]);
    expect(active.every((r) => r.status === "active")).toBe(true);
  });
});

describe("W-CON-02 — 42 CFR Part 2 release with per-recipient addition over time (§7.2)", () => {
  it("a named recipient discloses SUD; an unlisted one is redacted; the record stays version 0", async () => {
    const consent = part2({
      recipients: [
        { removedAtMs: null, expiresAtMs: Date.now() + 365 * DAY, recipientResolvedId: "cvs" }, // initial, 1y
        { removedAtMs: null, expiresAtMs: Date.now() + 180 * DAY, recipientResolvedId: "snf" }, // added later, 6mo, no supersede
      ],
    });
    const { store } = createInMemoryConsentStore({ consents: [consent], deceasedPatientIds: new Set() });
    const evaluator = createConsentEvaluator(store);
    expect(consent.version).toBe(0); // recipient addition is not a scope change (D6)

    const cvs = await evaluator.evaluateForDisclosure({ organizationId: ORG, patientId: PAT, recipientResolvedId: "cvs", callerModule: "m28" });
    expect(cvs.redactSudContent).toBe(false);
    const snf = await evaluator.evaluateForDisclosure({ organizationId: ORG, patientId: PAT, recipientResolvedId: "snf", callerModule: "m28" });
    expect(snf.redactSudContent).toBe(false);
    const vendor = await evaluator.evaluateForDisclosure({ organizationId: ORG, patientId: PAT, recipientResolvedId: "transcription-vendor", callerModule: "m28" });
    expect(vendor.redactSudContent).toBe(true); // no_active_recipient_matches
  });
});

describe("W-CON-03 — revocation cascade (§7.3)", () => {
  it("revoke flips the consent to revoked and the cascade completes once all consumers ACK", () => {
    const { service } = createInMemoryConsentRouteService();
    const now = new Date().toISOString();
    const d = service.createDraft(ORG, { patientId: PAT, typeKey: "portal_access", grantorKind: "patient_self", captureMethod: "electronic_portal_signature", scopeDescriptor: {}, createdById: "co" });
    service.signConsent(ORG, d.id, "co", now);
    const revoked = service.revokeConsent(ORG, d.id, { actorIsStaff: true, revokedByKind: "staff", reasonText: "x".repeat(45), evidenceDocumentId: "doc", revokedById: "co" }, now);
    expect(revoked.status).toBe("revoked");
    const cascade = nextCascadeStatus({ status: "in_progress", consumers: { m2: true, m22: true }, attempts: 1 });
    expect(cascade).toEqual({ ok: true, value: "completed" });
  });
});

describe("W-CON-05 — expiring consent reminder cadence (§7.5)", () => {
  it("fires 90/30/14/7/1-day windows as the term shortens", () => {
    const now = 1_000_000_000_000;
    expect(dueReminders({ expiresAtMs: now + 90 * DAY, nowMs: now })).toContain("90_days");
    expect(dueReminders({ expiresAtMs: now + 7 * DAY, nowMs: now })).toEqual(["90_days", "30_days", "14_days", "7_days"]);
    expect(dueReminders({ expiresAtMs: now + 0.5 * DAY, nowMs: now })).toContain("1_day");
  });
});

describe("W-CON-06 — tenant overlay tightening cannot loosen (§7.6)", () => {
  const floor = {
    defaultExpirationSeconds: 365 * 24 * 3600,
    captureMethodFloor: ["notarized", "typed_signature_in_app"] as const,
    reminderCadenceFloor: ["30_days", "7_days"] as const,
    jurisdictionCodeRequired: false,
  };

  it("accepts a tightening overlay", () => {
    expect(validateConsentOverlay(floor, { tighterExpirationSeconds: 180 * 24 * 3600, tighterCaptureMethods: ["notarized"], tighterReminderCadence: ["30_days", "14_days", "7_days"], jurisdictionCodeRequired: true }).ok).toBe(true);
  });

  it("rejects a longer expiration (loosen)", () => {
    const r = validateConsentOverlay(floor, { tighterExpirationSeconds: 2 * 365 * 24 * 3600 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("overlay_loosens_platform_floor");
  });

  it("rejects a capture method outside the floor + dropping a floor reminder + relaxing jurisdiction", () => {
    expect(validateConsentOverlay(floor, { tighterCaptureMethods: ["electronic_portal_signature"] }).ok).toBe(false);
    expect(validateConsentOverlay(floor, { tighterReminderCadence: ["30_days"] }).ok).toBe(false);
    expect(validateConsentOverlay({ ...floor, jurisdictionCodeRequired: true }, { jurisdictionCodeRequired: false }).ok).toBe(false);
  });
});

describe("W-CON-07 — post-death consent termination (§7.7 / D13)", () => {
  it("terminates non-surviving consents, preserves survives_death + the evaluator agrees", async () => {
    const ids = decideDeceasedConsentExpiry([
      { id: "hipaa", typeKey: "hipaa_release", status: "active", survivesDeath: false },
      { id: "fca", typeKey: "family_caregiver_access", status: "active", survivesDeath: true },
    ]);
    expect(ids).toEqual(["hipaa"]);

    const consents: StoredConsent[] = [
      part2({ id: "hipaa", typeKey: "hipaa_release", survivesDeath: false, recipients: [{ removedAtMs: null, expiresAtMs: null, recipientResolvedId: "atty" }] }),
      part2({ id: "fca", typeKey: "family_caregiver_access", survivesDeath: true, recipients: [{ removedAtMs: null, expiresAtMs: null, recipientResolvedId: "son" }] }),
    ];
    const { store } = createInMemoryConsentStore({ consents, deceasedPatientIds: new Set([PAT]) });
    const evaluator = createConsentEvaluator(store);
    const hipaa = await evaluator.evaluate({ organizationId: ORG, patientId: PAT, consentType: "hipaa_release", sessionContext: { sessionClass: "staff" }, callerModule: "m5" });
    expect(hipaa.denyReason).toBe("patient_deceased_consent_terminated");
    const fca = await evaluator.evaluate({ organizationId: ORG, patientId: PAT, consentType: "family_caregiver_access", sessionContext: { sessionClass: "caregiver_portal" }, callerModule: "m17" });
    expect(fca.allowed).toBe(true);
  });
});

describe("W-CON-08 — DPOA chain-of-authority validation (§7.8 / D5)", () => {
  it("accepts a valid acting DPOA chain and refuses the self-reference cycle", () => {
    expect(
      validateGrantorChain({ grantorKind: "dpoa_healthcare_agent", consentRecordId: "new", actingConsentId: "dpoa-rec", actingConsent: { status: "active", typeKey: "dpoa_healthcare" } }).ok,
    ).toBe(true);
    const cycle = validateGrantorChain({ grantorKind: "dpoa_healthcare_agent", consentRecordId: "same", actingConsentId: "same", actingConsent: { status: "active", typeKey: "dpoa_healthcare" } });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.code).toBe("grantor_self_reference");
  });
});

describe("W-CON-09 — right-of-access export gate, HIPAA §164.524 (§7.9)", () => {
  it("denies with no recipient named, allows after the employer is added", async () => {
    const noRecipient = part2({ id: "hr", typeKey: "hipaa_release", recipients: [] });
    let store = createInMemoryConsentStore({ consents: [noRecipient], deceasedPatientIds: new Set() }).store;
    let evaluator = createConsentEvaluator(store);
    const deny = await evaluator.evaluate({ organizationId: ORG, patientId: PAT, consentType: "hipaa_release", sessionContext: { sessionClass: "staff" }, callerModule: "m5" });
    expect(deny.allowed).toBe(false);
    expect(deny.denyReason).toBe("no_active_recipient_matches");

    const withEmployer = part2({ id: "hr", typeKey: "hipaa_release", recipients: [{ removedAtMs: null, expiresAtMs: null, recipientResolvedId: "employer-hr" }] });
    store = createInMemoryConsentStore({ consents: [withEmployer], deceasedPatientIds: new Set() }).store;
    evaluator = createConsentEvaluator(store);
    const allow = await evaluator.evaluate({ organizationId: ORG, patientId: PAT, consentType: "hipaa_release", sessionContext: { sessionClass: "staff" }, callerModule: "m5" });
    expect(allow.allowed).toBe(true);
  });
});
