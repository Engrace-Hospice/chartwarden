import { describe, expect, it } from "vitest";
import {
  activationPromotesToActive,
  deathTransitionFrom,
  isDeathDischargeReason,
  liveDischargeTransitionFrom,
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

  it("a live discharge moves active and on_hold patients to discharged (§2.4.1)", () => {
    expect(liveDischargeTransitionFrom("active")).toBe("discharge");
    expect(liveDischargeTransitionFrom("on_hold")).toBe("discharge");
  });

  it("a live discharge is an idempotent no-op on an already-discharged patient", () => {
    expect(liveDischargeTransitionFrom("discharged")).toBe("already_discharged");
  });

  it("a live discharge leaves deceased, merged and prospective charts alone (no §2.4.1 edge)", () => {
    for (const status of ["deceased", "merged", "prospective", "unknown"]) {
      expect(liveDischargeTransitionFrom(status)).toBe("skip");
    }
  });

  it("only the `death` reason is a death discharge (the death cascade owns `deceased`)", () => {
    expect(isDeathDischargeReason("death")).toBe(true);
    for (const reason of [
      "revocation",
      "transfer",
      "moved_out_of_service_area",
      "no_longer_terminal",
      "for_cause",
      "other",
    ]) {
      expect(isDeathDischargeReason(reason)).toBe(false);
    }
  });
});
