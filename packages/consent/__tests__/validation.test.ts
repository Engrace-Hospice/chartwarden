// M39-T04 — §2.3 validation rules.
import { describe, expect, it } from "vitest";
import {
  evaluatePostDeathScope,
  validateBereavementGrantor,
  validateCaptureEvidence,
  validateCaptureMethod,
  validateDpoaAgents,
  validateEffectiveWindow,
  validateGrantorChain,
  validateParentForMinor,
  validateRecipientFk,
  validateRecipientRoster,
  validateRenewal,
  validateRevocation,
  validateSupersession,
  validateSurvivesDeath,
} from "../src/validation";

describe("D5 chain-of-authority (validateGrantorChain)", () => {
  it("patient_self needs no acting consent", () => {
    expect(
      validateGrantorChain({
        grantorKind: "patient_self",
        consentRecordId: "a",
        actingConsentId: null,
        actingConsent: null,
      }).ok,
    ).toBe(true);
  });

  it("a DPOA-healthcare agent must reference a different, active dpoa_healthcare record", () => {
    const good = validateGrantorChain({
      grantorKind: "dpoa_healthcare_agent",
      consentRecordId: "self",
      actingConsentId: "acting",
      actingConsent: { status: "active", typeKey: "dpoa_healthcare" },
    });
    expect(good.ok).toBe(true);
  });

  it("refuses the chicken-and-egg self reference", () => {
    const r = validateGrantorChain({
      grantorKind: "dpoa_healthcare_agent",
      consentRecordId: "same",
      actingConsentId: "same",
      actingConsent: { status: "active", typeKey: "dpoa_healthcare" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("grantor_self_reference");
  });

  it("refuses a non-active or wrong-type acting consent", () => {
    expect(
      validateGrantorChain({
        grantorKind: "dpoa_healthcare_agent",
        consentRecordId: "s",
        actingConsentId: "a",
        actingConsent: { status: "revoked", typeKey: "dpoa_healthcare" },
      }).ok,
    ).toBe(false);
    expect(
      validateGrantorChain({
        grantorKind: "dpoa_financial_agent",
        consentRecordId: "s",
        actingConsentId: "a",
        actingConsent: { status: "active", typeKey: "dpoa_healthcare" },
      }).ok,
    ).toBe(false);
  });
});

describe("capture evidence floor", () => {
  it("requires the artifact appropriate to each capture method", () => {
    expect(
      validateCaptureEvidence({
        method: "typed_signature_in_app",
        evidence: { typedSignatureName: "Patient Example" },
      }).ok,
    ).toBe(true);
    expect(validateCaptureEvidence({ method: "typed_signature_in_app", evidence: {} }).ok).toBe(
      false,
    );
    expect(validateCaptureEvidence({ method: "notarized", evidence: {} }).ok).toBe(false);
    expect(
      validateCaptureEvidence({
        method: "witnessed_verbal_documented",
        evidence: {
          witnessName: "Witness Example",
          witnessAttestationText: "I witnessed the patient's verbal authorization.",
          witnessSignatureEvidenceDocumentId: "doc-1",
        },
      }).ok,
    ).toBe(true);
  });
});

describe("Part 2 recipient floor", () => {
  it("refuses an operative Part 2 release with no named recipient", () => {
    expect(validateRecipientRoster("42_cfr_part_2_release", 0).ok).toBe(false);
    expect(validateRecipientRoster("42_cfr_part_2_release", 1).ok).toBe(true);
    expect(validateRecipientRoster("hipaa_release", 0).ok).toBe(true);
  });
});

describe("D5 parent_for_minor majority lapse", () => {
  it("valid while a minor, refused once aged out", () => {
    expect(
      validateParentForMinor({
        grantorKind: "parent_for_minor",
        patientAgeYearsAtEffective: 16,
        ageOfMajorityYears: 18,
      }).ok,
    ).toBe(true);
    const r = validateParentForMinor({
      grantorKind: "parent_for_minor",
      patientAgeYearsAtEffective: 18,
      ageOfMajorityYears: 18,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("grantor_authority_expired_on_majority");
  });
});

describe("D13/D14 death semantics", () => {
  it("only the three eligible types may set survives_death", () => {
    expect(validateSurvivesDeath("family_caregiver_access", true).ok).toBe(true);
    expect(validateSurvivesDeath("media_release", true).ok).toBe(true);
    expect(validateSurvivesDeath("research_participation", true).ok).toBe(true);
    expect(validateSurvivesDeath("hipaa_release", true).ok).toBe(false);
    expect(validateSurvivesDeath("hipaa_release", false).ok).toBe(true);
  });

  it("post-death scope terminates non-surviving consents, keeps surviving + bereavement", () => {
    expect(
      evaluatePostDeathScope({
        typeKey: "hipaa_release",
        survivesDeath: false,
        patientDeceased: false,
      }).ok,
    ).toBe(true);
    const dead = evaluatePostDeathScope({
      typeKey: "hipaa_release",
      survivesDeath: false,
      patientDeceased: true,
    });
    expect(dead.ok).toBe(false);
    if (!dead.ok) expect(dead.code).toBe("consent_terminated_on_death");
    expect(
      evaluatePostDeathScope({
        typeKey: "family_caregiver_access",
        survivesDeath: true,
        patientDeceased: true,
      }).ok,
    ).toBe(true);
    expect(
      evaluatePostDeathScope({
        typeKey: "bereavement_outreach_consent",
        survivesDeath: false,
        patientDeceased: true,
      }).ok,
    ).toBe(true);
  });

  it("bereaved_person_self is valid only for bereavement on a deceased patient", () => {
    expect(
      validateBereavementGrantor({
        grantorKind: "bereaved_person_self",
        typeKey: "bereavement_outreach_consent",
        patientDeceased: true,
      }).ok,
    ).toBe(true);
    expect(
      validateBereavementGrantor({
        grantorKind: "bereaved_person_self",
        typeKey: "hipaa_release",
        patientDeceased: true,
      }).ok,
    ).toBe(false);
    const alive = validateBereavementGrantor({
      grantorKind: "bereaved_person_self",
      typeKey: "bereavement_outreach_consent",
      patientDeceased: false,
    });
    expect(alive.ok).toBe(false);
    if (!alive.ok) expect(alive.code).toBe("bereavement_patient_not_deceased");
  });
});

describe("D1 supersession + D13 renewal invariants", () => {
  const base = { typeKey: "hipaa_release" as const, patientId: "p", organizationId: "o" };
  it("supersession requires a matching active prior row", () => {
    expect(validateSupersession({ prior: { ...base, status: "active" }, next: base }).ok).toBe(
      true,
    );
    expect(validateSupersession({ prior: { ...base, status: "expired" }, next: base }).ok).toBe(
      false,
    );
    expect(
      validateSupersession({
        prior: { ...base, status: "active" },
        next: { ...base, patientId: "other" },
      }).ok,
    ).toBe(false);
  });

  it("renewal requires a matching expired/revoked prior row", () => {
    expect(
      validateRenewal({
        prior: { typeKey: "hipaa_release", patientId: "p", status: "expired" },
        next: { typeKey: "hipaa_release", patientId: "p" },
      }).ok,
    ).toBe(true);
    expect(
      validateRenewal({
        prior: { typeKey: "hipaa_release", patientId: "p", status: "active" },
        next: { typeKey: "hipaa_release", patientId: "p" },
      }).ok,
    ).toBe(false);
  });
});

describe("capture method / revocation / window / dpoa / recipient", () => {
  it("capture method must be in floor and tighter overlay", () => {
    expect(
      validateCaptureMethod({ method: "notarized", floor: ["notarized", "typed_signature_in_app"] })
        .ok,
    ).toBe(true);
    expect(
      validateCaptureMethod({ method: "typed_signature_in_app", floor: ["notarized"] }).ok,
    ).toBe(false);
    expect(
      validateCaptureMethod({
        method: "typed_signature_in_app",
        floor: ["notarized", "typed_signature_in_app"],
        tighter: ["notarized"],
      }).ok,
    ).toBe(false);
  });

  it("staff revocation requires ≥40-char reason + evidence; patient does not", () => {
    expect(
      validateRevocation({ actorIsStaff: false, reasonText: "", evidenceDocumentId: null }).ok,
    ).toBe(true);
    expect(
      validateRevocation({ actorIsStaff: true, reasonText: "too short", evidenceDocumentId: "d" })
        .ok,
    ).toBe(false);
    expect(
      validateRevocation({
        actorIsStaff: true,
        reasonText: "x".repeat(40),
        evidenceDocumentId: null,
      }).ok,
    ).toBe(false);
    expect(
      validateRevocation({
        actorIsStaff: true,
        reasonText: "x".repeat(40),
        evidenceDocumentId: "d",
      }).ok,
    ).toBe(true);
  });

  it("no future-dated signatures; expiry after effective + within term", () => {
    expect(
      validateEffectiveWindow({
        effectiveAtMs: 100,
        nowMs: 50,
        expiresAtMs: null,
        maxTermSeconds: null,
      }).ok,
    ).toBe(false);
    expect(
      validateEffectiveWindow({
        effectiveAtMs: 50,
        nowMs: 100,
        expiresAtMs: 40,
        maxTermSeconds: null,
      }).ok,
    ).toBe(false);
    expect(
      validateEffectiveWindow({
        effectiveAtMs: 0,
        nowMs: 100,
        expiresAtMs: 2 * 365 * 86400 * 1000,
        maxTermSeconds: 365 * 86400,
      }).ok,
    ).toBe(false);
    expect(
      validateEffectiveWindow({
        effectiveAtMs: 0,
        nowMs: 100,
        expiresAtMs: 86400 * 1000,
        maxTermSeconds: 365 * 86400,
      }).ok,
    ).toBe(true);
  });

  it("exactly one primary DPOA agent, ≤1 of each alternate", () => {
    expect(validateDpoaAgents(["primary"]).ok).toBe(true);
    expect(validateDpoaAgents(["primary", "alternate_1", "alternate_2"]).ok).toBe(true);
    expect(validateDpoaAgents([]).ok).toBe(false);
    expect(validateDpoaAgents(["primary", "primary"]).ok).toBe(false);
    expect(validateDpoaAgents(["primary", "alternate_1", "alternate_1"]).ok).toBe(false);
  });

  it("free_text recipient has no FK + ≥5-char name; other kinds require the FK", () => {
    expect(validateRecipientFk({ kind: "free_text", entityId: null, freeText: "Dr Bob" }).ok).toBe(
      true,
    );
    expect(validateRecipientFk({ kind: "free_text", entityId: "x", freeText: "Dr Bob" }).ok).toBe(
      false,
    );
    expect(validateRecipientFk({ kind: "free_text", entityId: null, freeText: "ab" }).ok).toBe(
      false,
    );
    expect(
      validateRecipientFk({ kind: "external_physician", entityId: "phys-1", freeText: null }).ok,
    ).toBe(true);
    expect(
      validateRecipientFk({ kind: "external_physician", entityId: null, freeText: null }).ok,
    ).toBe(false);
  });
});
