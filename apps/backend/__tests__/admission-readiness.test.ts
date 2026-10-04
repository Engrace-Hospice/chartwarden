import { describe, expect, it } from "vitest";
import {
  type AdmissionReadinessFacts,
  evaluateAdmissionReadiness,
} from "../src/modules/06-admission/intake";

function facts(overrides: Partial<AdmissionReadinessFacts> = {}): AdmissionReadinessFacts {
  return {
    admissionId: "adm_1",
    patientIdentity: { patientId: "pat_1" },
    admissionDetails: {
      admissionDatePresent: true,
      providerEntityPresent: true,
      locationPresent: true,
    },
    patientPrivacy: { allowed: true },
    noticeOfRights: {
      acknowledged: true,
      acknowledgedAtPresent: true,
      signerValid: true,
      methodValid: true,
    },
    electionStatement: {
      exists: true,
      status: "signed",
      signedAtPresent: true,
      belongsToCurrentPeriod: true,
    },
    cti: {
      exists: true,
      status: "signed",
      hospiceMdSigned: true,
    },
    f2f: {
      required: false,
      exists: false,
      status: null,
      completed: false,
      attestationRequired: false,
      attested: false,
    },
    ...overrides,
  };
}

const req = (result: ReturnType<typeof evaluateAdmissionReadiness>, code: string) =>
  result.requirements.find((r) => r.code === code);

describe("admission readiness evaluator", () => {
  it("marks the admission ready when all blocking requirements are complete", () => {
    const result = evaluateAdmissionReadiness(facts());
    expect(result.status).toBe("ready");
    expect(result.canActivate).toBe(true);
    expect(result.blockingRemaining).toBe(0);
  });

  it("blocks unresolved patient identity", () => {
    const result = evaluateAdmissionReadiness(facts({ patientIdentity: { patientId: null } }));
    expect(result.canActivate).toBe(false);
    expect(req(result, "patient_identity")).toMatchObject({ status: "blocked", blocking: true });
  });

  // activation-gate.ts evaluateAdmissionReadiness (commit 5cf3d073): "Provider/location are denormalized
  // capture-siting facts. They may be unavailable while an admission is still being assembled and are
  // deliberately not R-AC-01 activation blockers." The admission DATE is the admission-details blocker.
  it("requires an admission date in admission details", () => {
    const result = evaluateAdmissionReadiness(
      facts({
        admissionDetails: {
          admissionDatePresent: false,
          providerEntityPresent: true,
          locationPresent: true,
        },
      }),
    );
    expect(result.canActivate).toBe(false);
    expect(req(result, "admission_details")).toMatchObject({
      status: "action_required",
      blocking: true,
      action: "COMPLETE_ADMISSION_DETAILS",
    });
    expect(req(result, "admission_details")?.message).toBe("Missing admission date.");
  });

  it("does not block activation on a missing provider entity (siting, not an R-AC-01 blocker)", () => {
    const result = evaluateAdmissionReadiness(
      facts({
        admissionDetails: {
          admissionDatePresent: true,
          providerEntityPresent: false,
          locationPresent: true,
        },
      }),
    );
    expect(req(result, "admission_details")).toMatchObject({
      status: "complete",
      blocking: true,
    });
    expect(result.canActivate).toBe(true);
  });

  it("does not block activation on a missing service location (siting, not an R-AC-01 blocker)", () => {
    const result = evaluateAdmissionReadiness(
      facts({
        admissionDetails: {
          admissionDatePresent: true,
          providerEntityPresent: true,
          locationPresent: false,
        },
      }),
    );
    expect(req(result, "admission_details")).toMatchObject({
      status: "complete",
      blocking: true,
    });
    expect(result.canActivate).toBe(true);
  });

  it("completes admission details when date, provider entity, and location are present", () => {
    const result = evaluateAdmissionReadiness(
      facts({
        admissionDetails: {
          admissionDatePresent: true,
          providerEntityPresent: true,
          locationPresent: true,
        },
      }),
    );
    expect(req(result, "admission_details")).toMatchObject({
      status: "complete",
      blocking: true,
    });
  });

  it("blocks activation on privacy restriction", () => {
    const result = evaluateAdmissionReadiness(
      facts({ patientPrivacy: { allowed: false, reason: "PRIVACY_RESTRICTION" } }),
    );
    expect(result.status).toBe("blocked");
    expect(req(result, "patient_privacy")).toMatchObject({ status: "blocked", blocking: true });
  });

  it("F-238: an unreviewed intake detection is advisory — it never blocks activation", () => {
    const result = evaluateAdmissionReadiness(
      facts({
        patientPrivacy: {
          allowed: false,
          reason: "PRIVACY_RESTRICTION",
          restriction: "INTAKE_DETECTION_UNREVIEWED",
          overrideAllowed: true,
        },
      }),
    );
    expect(result.canActivate).toBe(true);
    expect(result.status).toBe("ready");
    expect(result.blockingRemaining).toBe(0);
    expect(req(result, "patient_privacy")).toEqual({
      code: "patient_privacy",
      label: "Patient privacy",
      status: "action_required",
      blocking: false,
      message:
        "An intake document is flagged for possibly specially protected records and hasn't been reviewed yet. This doesn't block admission; the records stay restricted until reviewed.",
      action: "REVIEW_PRIVACY",
      reasonCode: "INTAKE_DETECTION_UNREVIEWED",
    });
  });

  it("F-238: a confirmed detection without consent, any other restriction, or no clearance still blocks", () => {
    for (const patientPrivacy of [
      { allowed: false, reason: "PRIVACY_RESTRICTION", restriction: "CONSENT_REQUIRED" },
      { allowed: false, reason: "PRIVACY_RESTRICTION", restriction: "RESTRICTED" },
      { allowed: false, reason: "PRIVACY_CLEARANCE_UNAVAILABLE" },
      { allowed: false, reason: "PATIENT_NOT_FOUND" },
    ] as const) {
      const result = evaluateAdmissionReadiness(facts({ patientPrivacy }));
      expect(result.canActivate).toBe(false);
      expect(result.status).toBe("blocked");
      expect(req(result, "patient_privacy")).toMatchObject({ status: "blocked", blocking: true });
    }
  });

  it("names WHY privacy blocks (category-free reasonCode) so the UI can offer the right next step", () => {
    const privacy = (p: AdmissionReadinessFacts["patientPrivacy"]) =>
      req(evaluateAdmissionReadiness(facts({ patientPrivacy: p })), "patient_privacy");
    expect(
      privacy({
        allowed: false,
        reason: "PRIVACY_RESTRICTION",
        restriction: "INTAKE_DETECTION_UNREVIEWED",
      }),
    ).toMatchObject({
      status: "action_required",
      blocking: false,
      action: "REVIEW_PRIVACY",
      reasonCode: "INTAKE_DETECTION_UNREVIEWED",
    });
    expect(
      privacy({ allowed: false, reason: "PRIVACY_RESTRICTION", restriction: "CONSENT_REQUIRED" }),
    ).toMatchObject({ status: "blocked", blocking: true, reasonCode: "CONSENT_REQUIRED" });
    expect(privacy({ allowed: false, reason: "PRIVACY_RESTRICTION" })).toMatchObject({
      reasonCode: "RESTRICTED",
      message: "A patient restriction requires authorized review.",
    });
    expect(privacy({ allowed: false, reason: "PRIVACY_CLEARANCE_UNAVAILABLE" })).toMatchObject({
      reasonCode: "PRIVACY_CLEARANCE_UNAVAILABLE",
    });
    expect(privacy({ allowed: false, reason: "PATIENT_NOT_FOUND" })).toMatchObject({
      reasonCode: "PATIENT_NOT_FOUND",
    });
    // Never a flag category in what M6 hands the admission screen.
    const all = JSON.stringify(
      evaluateAdmissionReadiness(
        facts({
          patientPrivacy: {
            allowed: false,
            reason: "PRIVACY_RESTRICTION",
            restriction: "INTAKE_DETECTION_UNREVIEWED",
          },
        }),
      ),
    ).toLowerCase();
    expect(all).not.toMatch(/\bsud\b|substance|part 2/);
    expect(privacy({ allowed: true })?.reasonCode).toBeUndefined();
  });

  it("requires a valid Notice of Rights acknowledgment", () => {
    const result = evaluateAdmissionReadiness(
      facts({
        noticeOfRights: {
          acknowledged: true,
          acknowledgedAtPresent: false,
          signerValid: true,
          methodValid: true,
        },
      }),
    );
    expect(req(result, "notice_of_rights")).toMatchObject({
      status: "action_required",
      blocking: true,
    });
  });

  it("does not treat an Election draft as complete", () => {
    const result = evaluateAdmissionReadiness(
      facts({
        electionStatement: {
          exists: true,
          status: "drafted",
          signedAtPresent: false,
          belongsToCurrentPeriod: true,
        },
      }),
    );
    expect(result.canActivate).toBe(false);
    expect(req(result, "election_statement")).toMatchObject({
      status: "action_required",
      blocking: true,
    });
  });

  it("requires Election status signed and signedAt", () => {
    const result = evaluateAdmissionReadiness(
      facts({
        electionStatement: {
          exists: true,
          status: "signed",
          signedAtPresent: false,
          belongsToCurrentPeriod: true,
        },
      }),
    );
    expect(req(result, "election_statement")).toMatchObject({ status: "action_required" });
  });

  it("maps CTI draft and missing signatures to awaiting action", () => {
    const draft = evaluateAdmissionReadiness(
      facts({
        cti: {
          exists: true,
          status: "drafted",
          hospiceMdSigned: false,
        },
      }),
    );
    expect(req(draft, "cti")).toMatchObject({ status: "awaiting_signature" });

    const hospiceSigned = evaluateAdmissionReadiness(
      facts({
        cti: {
          exists: true,
          status: "awaiting_attending",
          hospiceMdSigned: true,
        },
      }),
    );
    expect(req(hospiceSigned, "cti")).toMatchObject({ status: "complete" });
  });

  it("treats F2F not applicable as non-blocking", () => {
    const result = evaluateAdmissionReadiness(facts());
    expect(req(result, "f2f")).toMatchObject({ status: "not_applicable", blocking: false });
  });

  it("blocks required F2F until completed and attested", () => {
    const missing = evaluateAdmissionReadiness(
      facts({
        f2f: {
          required: true,
          exists: false,
          status: null,
          completed: false,
          attestationRequired: true,
          attested: false,
        },
      }),
    );
    expect(req(missing, "f2f")).toMatchObject({ status: "action_required", blocking: true });

    const unattested = evaluateAdmissionReadiness(
      facts({
        f2f: {
          required: true,
          exists: true,
          status: "completed",
          completed: true,
          attestationRequired: true,
          attested: false,
        },
      }),
    );
    expect(req(unattested, "f2f")).toMatchObject({ status: "awaiting_signature" });

    const complete = evaluateAdmissionReadiness(
      facts({
        f2f: {
          required: true,
          exists: true,
          status: "attested",
          completed: true,
          attestationRequired: true,
          attested: true,
        },
      }),
    );
    expect(req(complete, "f2f")).toMatchObject({ status: "complete" });
  });
});
