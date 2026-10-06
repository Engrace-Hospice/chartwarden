// The Medicare hospice transfer notice (TOB 8xC / corrected 8xC / 8xD): the lifecycle reducer, the
// CMS Pub. 100-04 ch. 11 §20.1.3 / §20.1.4 validation rules and the PHI-free gateway document.
import { describe, expect, it } from "vitest";
import {
  type TransferNoticeFacts,
  assertCorrectionPair,
  buildTransferNoticeDocument,
  evaluateTransferNotice,
  transferNoticeMachine,
  transferNoticeOccurrenceCodes,
  transferNoticeTob,
} from "../src";

const ORIGINAL: TransferNoticeFacts = {
  action: "original",
  facilityTypeCode: "81",
  statementFromDate: "2026-01-10",
  originalTransferDate: null,
  admissionDate: "2026-01-10",
  benefitPeriodSequence: 2,
  benefitPeriodStartDate: "2025-12-01",
  providerCcn: "381501",
  priorHospiceCcn: "381777",
  priorBilling: { throughDate: "2026-01-10", patientStatus: "50" },
  otherTransfersInBenefitPeriod: 0,
  supersededAccepted: null,
};

const codes = (facts: TransferNoticeFacts) =>
  evaluateTransferNotice(facts).blockers.map((b) => b.code);

describe("transferNoticeMachine — the 8xC lifecycle", () => {
  it("walks draft → ready → submitted → ack_pending → ack_accepted", () => {
    let state = transferNoticeMachine.reduce("draft", "assemble", { openBlockers: 0 }).state;
    expect(state).toBe("ready");
    state = transferNoticeMachine.reduce(state, "submit").state;
    expect(state).toBe("submitted");
    state = transferNoticeMachine.reduce(state, "ack_999_accepted").state;
    expect(state).toBe("ack_pending");
    state = transferNoticeMachine.reduce(state, "ack_277ca_accepted").state;
    expect(state).toBe("ack_accepted");
    expect(transferNoticeMachine.isTerminal(state)).toBe(true);
  });

  it("holds DRAFT while any blocker is open, and fails closed when the blocker count is absent", () => {
    expect(transferNoticeMachine.reduce("draft", "assemble", { openBlockers: 1 })).toEqual({
      state: "draft",
      error: "GUARD_FAILED",
    });
    expect(transferNoticeMachine.reduce("draft", "assemble").error).toBe("GUARD_FAILED");
  });

  it("cancels only before submission and only with a reason", () => {
    expect(
      transferNoticeMachine.reduce("ready", "cancel", { cancelReasonProvided: true }).state,
    ).toBe("cancelled");
    expect(transferNoticeMachine.reduce("ready", "cancel").error).toBe("GUARD_FAILED");
    expect(
      transferNoticeMachine.reduce("submitted", "cancel", { cancelReasonProvided: true }).error,
    ).toBe("INVALID_TRANSITION");
  });

  it("rejects on a 999 or a 277CA", () => {
    expect(transferNoticeMachine.reduce("submitted", "ack_999_rejected").state).toBe(
      "ack_rejected",
    );
    expect(transferNoticeMachine.reduce("ack_pending", "ack_277ca_rejected").state).toBe(
      "ack_rejected",
    );
  });
});

describe("evaluateTransferNotice — §20.1.3 rules", () => {
  it("passes a complete, continuous original", () => {
    const evaluation = evaluateTransferNotice(ORIGINAL);
    expect(evaluation.blockers).toEqual([]);
    expect(evaluation.tob).toBe("81C");
    expect(evaluation.conditionCodes).toEqual([]);
  });

  it("blocks a transfer from the same CCN (a move between locations of one hospice)", () => {
    expect(codes({ ...ORIGINAL, priorHospiceCcn: "381501" })).toEqual(["SAME_CCN"]);
  });

  it("blocks when the transferring hospice's CCN is unknown (the same-CCN rule cannot be proven)", () => {
    expect(codes({ ...ORIGINAL, priorHospiceCcn: null })).toEqual(["PRIOR_HOSPICE_CCN_REQUIRED"]);
  });

  it("blocks a second change of hospice in the same benefit period", () => {
    expect(codes({ ...ORIGINAL, otherTransfersInBenefitPeriod: 1 })).toEqual([
      "SECOND_TRANSFER_IN_BENEFIT_PERIOD",
    ]);
  });

  it("holds the notice until the transferring hospice has finalized its billing", () => {
    expect(codes({ ...ORIGINAL, priorBilling: null })).toEqual(["PRIOR_BILLING_NOT_CONFIRMED"]);
  });

  it("blocks a gap: the transferring Through date must equal our From date", () => {
    const evaluation = evaluateTransferNotice({
      ...ORIGINAL,
      priorBilling: { throughDate: "2026-01-09", patientStatus: "51" },
    });
    expect(evaluation.blockers.map((b) => b.code)).toEqual(["CONTINUITY_GAP"]);
    expect(evaluation.blockers[0]?.citation).toBe("CMS Pub. 100-04 ch. 11 §20.1.3");
  });

  it("blocks an admission after the transfer date and warns on one before it", () => {
    expect(codes({ ...ORIGINAL, admissionDate: "2026-01-11" })).toEqual([
      "ADMISSION_AFTER_TRANSFER_DATE",
    ]);
    const early = evaluateTransferNotice({ ...ORIGINAL, admissionDate: "2026-01-09" });
    expect(early.blockers).toEqual([]);
    expect(early.warnings.map((w) => w.code)).toEqual(["ADMISSION_BEFORE_TRANSFER_DATE"]);
    expect(codes({ ...ORIGINAL, admissionDate: null })).toEqual(["ADMISSION_DATE_UNKNOWN"]);
  });

  it("blocks a transfer date before the inherited benefit period started", () => {
    expect(codes({ ...ORIGINAL, benefitPeriodStartDate: "2026-01-11" })).toContain(
      "TRANSFER_BEFORE_BENEFIT_PERIOD_START",
    );
  });

  it("reports OC 27 only when the transfer date is the first day of the next benefit period", () => {
    const boundary = { ...ORIGINAL, benefitPeriodStartDate: "2026-01-10" };
    expect(evaluateTransferNotice(boundary).occurrenceCodes).toEqual([
      { code: "27", date: "2026-01-10" },
    ]);
    expect(evaluateTransferNotice(ORIGINAL).occurrenceCodes).toEqual([]);
    // Period 1 starting on the transfer date is not "the next" benefit period.
    expect(transferNoticeOccurrenceCodes({ ...boundary, benefitPeriodSequence: 1 })).toEqual([]);
  });

  it("derives the correction pair: From = corrected date, OC 56 = original date, CC D0", () => {
    const evaluation = evaluateTransferNotice({
      ...ORIGINAL,
      action: "correction",
      statementFromDate: "2026-01-11",
      originalTransferDate: "2026-01-10",
      admissionDate: "2026-01-11",
      priorBilling: { throughDate: "2026-01-11", patientStatus: "50" },
      supersededAccepted: true,
    });
    expect(evaluation.blockers).toEqual([]);
    expect(evaluation.tob).toBe("81C");
    expect(evaluation.conditionCodes).toEqual(["D0"]);
    expect(evaluation.occurrenceCodes).toEqual([{ code: "56", date: "2026-01-10" }]);
  });

  it("blocks a correction to the same date, and one of a notice Medicare has not accepted", () => {
    expect(
      codes({
        ...ORIGINAL,
        action: "correction",
        originalTransferDate: "2026-01-10",
        supersededAccepted: false,
      }),
    ).toEqual(["CORRECTION_SAME_DATE", "SUPERSEDED_NOT_ACCEPTED"]);
  });

  it("evaluates an 8xD void with no hold, no codes and the §20.1.4 citation", () => {
    const evaluation = evaluateTransferNotice({
      ...ORIGINAL,
      action: "void",
      priorBilling: null,
      supersededAccepted: false,
    });
    expect(evaluation.tob).toBe("81D");
    expect(evaluation.occurrenceCodes).toEqual([]);
    expect(evaluation.blockers.map((b) => [b.code, b.citation])).toEqual([
      ["SUPERSEDED_NOT_ACCEPTED", "CMS Pub. 100-04 ch. 11 §20.1.4"],
    ]);
  });

  it("names the TOB from the facility type and the action", () => {
    expect(transferNoticeTob("82", "original")).toBe("82C");
    expect(transferNoticeTob("82", "void")).toBe("82D");
  });

  it("asserts OC 56 and CC D0 travel together", () => {
    expect(() => assertCorrectionPair(["D0"], [])).toThrow(/56/);
    expect(() => assertCorrectionPair([], [{ code: "56" }])).toThrow(/D0/);
    expect(() => assertCorrectionPair(["D0"], [{ code: "56" }])).not.toThrow();
  });
});

describe("buildTransferNoticeDocument — the gateway contract", () => {
  const base = {
    transferNoticeId: "tn-1",
    controlNumber: "CTRL1",
    action: "original" as const,
    tob: "81C",
    statementFromDate: "2026-01-10",
    admissionDate: "2026-01-10",
    conditionCodes: [],
    occurrenceCodes: [],
    attendingPhysicianId: "att",
    certifyingPhysicianId: "cert",
  };

  it("reports the certifying physician as the other physician", () => {
    const doc = buildTransferNoticeDocument(base);
    expect(doc.frequencyCode).toBe("C");
    expect(doc.attendingPhysicianId).toBe("att");
    expect(doc.otherPhysicianId).toBe("cert");
  });

  it("falls back to the certifying physician when no attending is designated (§20.1.3)", () => {
    const doc = buildTransferNoticeDocument({ ...base, attendingPhysicianId: null });
    expect(doc.attendingPhysicianId).toBe("cert");
    expect(doc.otherPhysicianId).toBeNull();
  });

  it("uses the transfer date as the 8xD admit date (§20.1.4)", () => {
    const doc = buildTransferNoticeDocument({
      ...base,
      action: "void",
      tob: "81D",
      admissionDate: "2026-01-02",
    });
    expect(doc.admissionDate).toBe("2026-01-10");
    expect(doc.frequencyCode).toBe("D");
  });

  it("refuses a TOB that does not match the action", () => {
    expect(() => buildTransferNoticeDocument({ ...base, tob: "81D" })).toThrow(/does not match/);
  });
});
