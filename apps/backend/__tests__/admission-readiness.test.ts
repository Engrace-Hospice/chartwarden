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

  it("requires a provider entity in admission details", () => {
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
      status: "action_required",
      blocking: true,
    });
    expect(req(result, "admission_details")?.message).toContain("provider entity");
  });

  it("requires a service location in admission details", () => {
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
      status: "action_required",
      blocking: true,
    });
    expect(req(result, "admission_details")?.message).toContain("location");
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
