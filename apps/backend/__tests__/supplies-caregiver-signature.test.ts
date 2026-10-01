// apps/backend/__tests__/supplies-caregiver-signature.test.ts — F-193 (#248). The pure M21-owned
// caregiver-signature capture guard + evidence-floor validator — no DB, no seams, no clock (the
// `supplies-lifecycle.test.ts` precedent for this module's other pure machines).
import { describe, expect, it } from "vitest";
import {
  assertCaregiverSignatureCaptureAllowed,
  caregiverSignatureEvidenceJsonbOf,
  caregiverSignatureEvidenceSatisfiesMethod,
  requireCaregiverSignatureEvidence,
} from "../src/modules/21-supplies/lifecycle/caregiver-signature";
import { SupplyStateError } from "../src/modules/21-supplies/lifecycle/errors";

describe("F-193 — assertCaregiverSignatureCaptureAllowed", () => {
  it("allows a capture against a delivered, never-captured row", () => {
    expect(() =>
      assertCaregiverSignatureCaptureAllowed({
        deliveredAt: "2026-06-08T12:00:00.000Z",
        existing: { capturedAt: null },
      }),
    ).not.toThrow();
  });

  it("refuses a capture before the row has reached 'delivered' (M21_CAREGIVER_SIGNATURE_REQUIRES_DELIVERY, 422)", () => {
    try {
      assertCaregiverSignatureCaptureAllowed({ deliveredAt: null, existing: { capturedAt: null } });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SupplyStateError);
      expect((err as SupplyStateError).code).toBe("M21_CAREGIVER_SIGNATURE_REQUIRES_DELIVERY");
      expect((err as SupplyStateError).statusCode).toBe(422);
    }
  });

  it("refuses a SECOND capture — the resubmission choice is REJECT, not overwrite or append (M21_CAREGIVER_SIGNATURE_ALREADY_CAPTURED, 409)", () => {
    try {
      assertCaregiverSignatureCaptureAllowed({
        deliveredAt: "2026-06-08T12:00:00.000Z",
        existing: { capturedAt: "2026-06-08T13:00:00.000Z" },
      });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SupplyStateError);
      expect((err as SupplyStateError).code).toBe("M21_CAREGIVER_SIGNATURE_ALREADY_CAPTURED");
      expect((err as SupplyStateError).statusCode).toBe(409);
    }
  });

  it("checks 'not yet delivered' BEFORE 'already captured' — a row cannot be both, but the guard order is deliberate and testable", () => {
    // deliveredAt null + capturedAt set is an impossible row (the paired CHECK + this guard's own write
    // path prevent it), but the guard must still resolve deterministically rather than throwing whichever
    // check happens to run last.
    try {
      assertCaregiverSignatureCaptureAllowed({
        deliveredAt: null,
        existing: { capturedAt: "2026-06-08T13:00:00.000Z" },
      });
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as SupplyStateError).code).toBe("M21_CAREGIVER_SIGNATURE_REQUIRES_DELIVERY");
    }
  });
});

describe("F-193 — caregiverSignatureEvidenceSatisfiesMethod (mirrors M39's validateCaptureEvidence floor)", () => {
  it("typed_signature_in_app requires a typed name of at least 2 characters", () => {
    expect(
      caregiverSignatureEvidenceSatisfiesMethod("typed_signature_in_app", {
        typedSignatureName: "Dana Reyes",
      }),
    ).toBe(true);
    expect(
      caregiverSignatureEvidenceSatisfiesMethod("typed_signature_in_app", {
        typedSignatureName: "D",
      }),
    ).toBe(false);
    expect(caregiverSignatureEvidenceSatisfiesMethod("typed_signature_in_app", {})).toBe(false);
    expect(
      caregiverSignatureEvidenceSatisfiesMethod("typed_signature_in_app", {
        typedSignatureName: "   ",
      }),
    ).toBe(false);
  });

  it("witnessed_verbal_documented requires a witness name, a ≥20-char attestation AND an evidence document id", () => {
    const full = {
      witnessName: "Chris Lee",
      witnessAttestationText:
        "I witnessed the caregiver verbally consent to receipt of the DME item.",
      evidenceDocumentId: "doc-1",
    };
    expect(caregiverSignatureEvidenceSatisfiesMethod("witnessed_verbal_documented", full)).toBe(
      true,
    );

    expect(
      caregiverSignatureEvidenceSatisfiesMethod("witnessed_verbal_documented", {
        ...full,
        witnessName: "C",
      }),
    ).toBe(false);
    expect(
      caregiverSignatureEvidenceSatisfiesMethod("witnessed_verbal_documented", {
        ...full,
        witnessAttestationText: "too short",
      }),
    ).toBe(false);
    expect(
      caregiverSignatureEvidenceSatisfiesMethod("witnessed_verbal_documented", {
        ...full,
        evidenceDocumentId: undefined,
      }),
    ).toBe(false);
  });

  it("declined requires no evidence at all", () => {
    expect(caregiverSignatureEvidenceSatisfiesMethod("declined", {})).toBe(true);
    expect(
      caregiverSignatureEvidenceSatisfiesMethod("declined", { declinedReason: "patient asleep" }),
    ).toBe(true);
  });
});

describe("F-193 — requireCaregiverSignatureEvidence throws the domain error", () => {
  it("throws M21_CAREGIVER_SIGNATURE_EVIDENCE_REQUIRED (422) when the evidence does not satisfy the method", () => {
    try {
      requireCaregiverSignatureEvidence("typed_signature_in_app", {});
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SupplyStateError);
      expect((err as SupplyStateError).code).toBe("M21_CAREGIVER_SIGNATURE_EVIDENCE_REQUIRED");
      expect((err as SupplyStateError).statusCode).toBe(422);
    }
  });

  it("does not throw when the evidence satisfies the method", () => {
    expect(() =>
      requireCaregiverSignatureEvidence("declined", { declinedReason: "asleep" }),
    ).not.toThrow();
  });
});

describe("F-193 — caregiverSignatureEvidenceJsonbOf projects only the method's own fields", () => {
  it("typed_signature_in_app keeps only the typed name — a stray witness field does not ride along", () => {
    expect(
      caregiverSignatureEvidenceJsonbOf("typed_signature_in_app", {
        typedSignatureName: "Dana Reyes",
        witnessName: "should not appear",
      }),
    ).toEqual({ typedSignatureName: "Dana Reyes" });
  });

  it("witnessed_verbal_documented keeps the witness name + attestation, never the evidence document id (that is a discrete column, not jsonb)", () => {
    expect(
      caregiverSignatureEvidenceJsonbOf("witnessed_verbal_documented", {
        witnessName: "Chris Lee",
        witnessAttestationText: "witnessed the verbal consent",
        evidenceDocumentId: "doc-1",
      }),
    ).toEqual({ witnessName: "Chris Lee", witnessAttestationText: "witnessed the verbal consent" });
  });

  it("declined with no reason projects to null — nothing to store", () => {
    expect(caregiverSignatureEvidenceJsonbOf("declined", {})).toBeNull();
  });

  it("declined with a reason keeps it", () => {
    expect(caregiverSignatureEvidenceJsonbOf("declined", { declinedReason: "asleep" })).toEqual({
      declinedReason: "asleep",
    });
  });
});
