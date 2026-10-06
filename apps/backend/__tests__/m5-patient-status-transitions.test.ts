import { describe, expect, it } from "vitest";
import {
  activationPromotesToActive,
  deathTransitionFrom,
} from "../src/modules/05-patient/patient-status-transitions";

describe("M5 §2.4.1 patient.status edges driven by M6", () => {
  it("an admission activation promotes prospective and discharged patients to active", () => {
    expect(activationPromotesToActive("prospective")).toBe(true);
    expect(activationPromotesToActive("discharged")).toBe(true);
  });

  it("an admission activation leaves active, on_hold, deceased and merged patients alone", () => {
    for (const status of ["active", "on_hold", "deceased", "merged"]) {
      expect(activationPromotesToActive(status)).toBe(false);
    }
  });

  it("records an M6 death from active/on_hold and from a row that lagged the activation", () => {
    for (const status of ["active", "on_hold", "prospective", "discharged"]) {
      expect(deathTransitionFrom(status)).toBe("record");
    }
  });

  it("treats an already-deceased patient as an idempotent no-op", () => {
    expect(deathTransitionFrom("deceased")).toBe("already_deceased");
  });

  it("rejects a death on a merged chart (it belongs on the surviving chart)", () => {
    expect(deathTransitionFrom("merged")).toBe("reject");
    expect(deathTransitionFrom("unknown")).toBe("reject");
  });
});
