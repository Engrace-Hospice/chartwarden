// @wardenx/dosespot — §2.3 verbal-medication-order M11-seam consumption surface — M12-T03.
import { describe, expect, it } from "vitest";
import {
  assertVerbalAllowedForClass,
  buildVerbalRecordInput,
  buildSignTargetInput,
  type VerbalMedicationOrderFacts,
} from "../src/lifecycle";

const facts: VerbalMedicationOrderFacts = {
  organizationId: "org-1",
  medicationOrderId: "mo-1",
  medClass: "standard",
  containsControlled: false,
  recordingMembershipId: "rn-1",
  orderingPhysicianMdmId: "md-1",
  verbalAttestation: "Verbal order received from Dr. Smith for ...",
  receivedAt: "2026-06-22T12:00:00.000Z",
};

describe("§2.3 / D18 assertVerbalAllowedForClass", () => {
  it("permits a standard verbal", () => {
    expect(() => assertVerbalAllowedForClass("standard", false)).not.toThrow();
  });
  it("blocks a controlled-substance verbal (403)", () => {
    expect(() => assertVerbalAllowedForClass("controlled_substance", false)).toThrowError(
      expect.objectContaining({ code: "EPCS_VERBAL_NOT_PERMITTED", statusCode: 403 }),
    );
  });
  it("blocks a compounded-with-controlled verbal", () => {
    expect(() => assertVerbalAllowedForClass("compounded", true)).toThrowError(
      expect.objectContaining({ code: "EPCS_VERBAL_NOT_PERMITTED" }),
    );
  });
  it("permits a compounded verbal without a controlled component", () => {
    expect(() => assertVerbalAllowedForClass("compounded", false)).not.toThrow();
  });
});

describe("§2.3 buildVerbalRecordInput (M11 recordVerbalOrder payload)", () => {
  it("pins targetKind='medication_order' and maps every fact", () => {
    expect(buildVerbalRecordInput(facts)).toEqual({
      organizationId: "org-1",
      targetKind: "medication_order",
      targetId: "mo-1",
      recordingMembershipId: "rn-1",
      orderingPhysicianMdmId: "md-1",
      verbalAttestation: "Verbal order received from Dr. Smith for ...",
      receivedAt: "2026-06-22T12:00:00.000Z",
    });
  });
  it("refuses to build a controlled-substance verbal payload (D18)", () => {
    expect(() =>
      buildVerbalRecordInput({ ...facts, medClass: "controlled_substance" }),
    ).toThrowError(expect.objectContaining({ code: "EPCS_VERBAL_NOT_PERMITTED" }));
  });
});

describe("§2.3 / §2.8 D14 buildSignTargetInput (M11 signOrderTarget payload)", () => {
  it("builds a plain standard-sign payload (no signature context)", () => {
    const input = buildSignTargetInput({
      organizationId: "org-1",
      medicationOrderId: "mo-1",
      signerMembershipId: "md-1",
      signedAtClient: "2026-06-22T13:00:00.000Z",
    });
    expect(input).toEqual({
      organizationId: "org-1",
      targetKind: "medication_order",
      targetId: "mo-1",
      signerMembershipId: "md-1",
      signedAtClient: "2026-06-22T13:00:00.000Z",
      signatureKind: "signature",
    });
    expect(input.signatureContext).toBeUndefined();
  });
  it("carries the EPCS second-factor type in the signature context", () => {
    const input = buildSignTargetInput({
      organizationId: "org-1",
      medicationOrderId: "mo-1",
      signerMembershipId: "md-1",
      signedAtClient: "2026-06-22T13:00:00.000Z",
      secondFactorType: "passkey",
    });
    expect(input.signatureContext).toEqual({ reason: "epcs_second_factor=passkey" });
  });
  it("carries an on-behalf signer for the standard (non-verbal) path", () => {
    const input = buildSignTargetInput({
      organizationId: "org-1",
      medicationOrderId: "mo-1",
      signerMembershipId: "md-2",
      signedAtClient: "2026-06-22T13:00:00.000Z",
      onBehalfOf: "md-1",
    });
    expect(input.signatureContext).toEqual({ onBehalfOf: "md-1" });
  });
});
