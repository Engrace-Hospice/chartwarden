import { describe, expect, it } from "vitest";
import {
  InvalidAdmissionActivationPatientStatusError,
  transitionPatientOnAdmissionActivated,
} from "../src/modules/05-patient/lifecycle/admission-activation";

describe("M5 patient lifecycle on m6.admission.activated", () => {
  it.each(["prospective", "discharged"] as const)("allows %s → active", (status) => {
    expect(transitionPatientOnAdmissionActivated("patient-1", status)).toEqual({
      kind: "activate",
      fromStatus: status,
    });
  });

  it("is idempotent when the patient is already active", () => {
    expect(transitionPatientOnAdmissionActivated("patient-1", "active")).toEqual({
      kind: "already_active",
    });
  });

  it.each(["on_hold", "deceased", "merged"] as const)(
    "rejects %s because no admission-activation edge exists",
    (status) => {
      expect(() => transitionPatientOnAdmissionActivated("patient-1", status)).toThrow(
        InvalidAdmissionActivationPatientStatusError,
      );
    },
  );
});
