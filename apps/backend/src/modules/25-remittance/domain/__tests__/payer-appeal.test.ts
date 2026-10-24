// M25 milestone 12a-1 - the payer appeal CASE pure rules: the program check, the state edges, the deadline derivation
// (computed only from a complete level window and a typed anchor date; nothing Medicare is applied unless the level
// row says so), the deadline state, the informational decision-overdue flag and the no-deadline alert rule.
// Every window number here is a made-up fixture for the arithmetic; none is a payer's rule.
import { describe, expect, it } from "vitest";
import {
  type LevelWindow,
  canTransitionPayerAppeal,
  checkPayerDecision,
  checkPayerKind,
  checkPayerOpen,
  derivePayerLevelDeadline,
  payerDeadlineState,
  payerDecisionOverdue,
  shouldAlertPayerNoDeadline,
} from "../payer-appeal";

const cal = (days: number, over: Partial<LevelWindow> = {}): LevelWindow => ({
  windowDays: days,
  anchorKind: "notice_date",
  receiptPresumptionDays: null,
  dayBasis: "calendar",
  roll: null,
  ...over,
});

describe("checkPayerKind (the program guard on the payer-appeal side)", () => {
  it("refuses a Medicare advice: that denial takes the Medicare tiers", () => {
    expect(checkPayerKind("medicare")).toBe("MEDICARE_PAYER");
  });
  it("refuses a Medicaid advice: managed-care appeals are another milestone", () => {
    expect(checkPayerKind("medicaid")).toBe("MEDICAID_PAYER");
  });
  it("refuses a denial with no advice: no payer is named", () => {
    expect(checkPayerKind(null)).toBe("NO_PAYER_ADVICE");
    expect(checkPayerKind(undefined)).toBe("NO_PAYER_ADVICE");
  });
  it("accepts a commercial advice", () => {
    expect(checkPayerKind("commercial")).toBeNull();
  });
});

describe("canTransitionPayerAppeal", () => {
  it.each([
    ["draft", "submitted", true],
    ["draft", "withdrawn", true],
    ["submitted", "under_review", true],
    ["under_review", "decided", true],
    ["decided", "closed", true],
    ["under_review", "escalated", false],
    ["draft", "decided", false],
    ["closed", "draft", false],
    ["withdrawn", "closed", false],
  ] as const)("%s -> %s is %s", (from, to, ok) => {
    expect(canTransitionPayerAppeal(from, to as never)).toBe(ok);
  });
});

describe("derivePayerLevelDeadline", () => {
  it("is null with no window (nothing is computed from an incomplete row)", () => {
    expect(derivePayerLevelDeadline(null, "2026-03-02", ["America/New_York"])).toBeNull();
  });
  it("is null with no typed anchor date", () => {
    expect(derivePayerLevelDeadline(cal(10), null, ["America/New_York"])).toBeNull();
  });
  it("counts calendar days from the typed date with NO presumption when the row has none", () => {
    const d = derivePayerLevelDeadline(cal(10), "2026-03-02", ["America/New_York"]);
    expect(d?.lastFilingDay).toBe("2026-03-12");
    expect(d?.presumedReceiptOn).toBeNull();
    expect(d?.deadlineAt.toISOString()).toBe("2026-03-13T04:59:59.999Z");
  });
  it("applies a receipt presumption only when the row states one", () => {
    const d = derivePayerLevelDeadline(cal(10, { receiptPresumptionDays: 3 }), "2026-03-02", [
      "America/New_York",
    ]);
    expect(d?.presumedReceiptOn).toBe("2026-03-05");
    expect(d?.lastFilingDay).toBe("2026-03-15");
  });
  it("a zero presumption is a stated value, not an absent one", () => {
    const d = derivePayerLevelDeadline(cal(10, { receiptPresumptionDays: 0 }), "2026-03-02", [
      "America/New_York",
    ]);
    expect(d?.presumedReceiptOn).toBe("2026-03-02");
    expect(d?.lastFilingDay).toBe("2026-03-12");
  });
  it("does not roll a weekend on a calendar basis", () => {
    // 2026-03-14 is a Saturday.
    const d = derivePayerLevelDeadline(cal(12), "2026-03-02", ["America/New_York"]);
    expect(d?.lastFilingDay).toBe("2026-03-14");
  });
  it("business basis with roll none leaves the date alone", () => {
    const d = derivePayerLevelDeadline(
      cal(12, { dayBasis: "business_us_federal", roll: "none" }),
      "2026-03-02",
      ["America/New_York"],
    );
    expect(d?.lastFilingDay).toBe("2026-03-14");
  });
  it("business basis rolls back to the previous business day only when the row says back", () => {
    const d = derivePayerLevelDeadline(
      cal(12, { dayBasis: "business_us_federal", roll: "back" }),
      "2026-03-02",
      ["America/New_York"],
    );
    expect(d?.calendarLastDay).toBe("2026-03-14");
    expect(d?.lastFilingDay).toBe("2026-03-13");
  });
  it("business basis rolls forward only when the row says forward", () => {
    const d = derivePayerLevelDeadline(
      cal(12, { dayBasis: "business_us_federal", roll: "forward" }),
      "2026-03-02",
      ["America/New_York"],
    );
    expect(d?.lastFilingDay).toBe("2026-03-16");
  });
  it("a business basis with no roll stated computes nothing", () => {
    const w = cal(12, { dayBasis: "business_us_federal", roll: null });
    expect(derivePayerLevelDeadline(w, "2026-03-02", ["America/New_York"])).toBeNull();
  });
  it("ends the day in the earliest-ending provider zone", () => {
    const d = derivePayerLevelDeadline(cal(10), "2026-03-02", [
      "America/Los_Angeles",
      "America/New_York",
    ]);
    expect(d?.zone).toBe("America/New_York");
  });
  it("rejects a typed date that is not a real day", () => {
    expect(() => derivePayerLevelDeadline(cal(10), "2026-02-30", ["America/New_York"])).toThrow();
  });
});

describe("payerDeadlineState", () => {
  it("is none with neither a computed nor an open recorded deadline", () => {
    expect(payerDeadlineState({ computedAt: null, openRecordedCount: 0 })).toBe("none");
  });
  it("is computed when the path produced one", () => {
    expect(payerDeadlineState({ computedAt: new Date(), openRecordedCount: 0 })).toBe("computed");
  });
  it("is recorded when only a typed deadline exists", () => {
    expect(payerDeadlineState({ computedAt: null, openRecordedCount: 2 })).toBe("recorded");
  });
});

describe("payerDecisionOverdue (informational only)", () => {
  const base = { decisionDays: 5, submittedOn: "2026-03-01", state: "under_review" };
  it("is false when no decision days are recorded", () => {
    expect(payerDecisionOverdue({ ...base, decisionDays: null, today: "2030-01-01" })).toBe(false);
  });
  it("is false before the recorded days elapse and true after", () => {
    expect(payerDecisionOverdue({ ...base, today: "2026-03-06" })).toBe(false);
    expect(payerDecisionOverdue({ ...base, today: "2026-03-07" })).toBe(true);
  });
  it("is false once decided or not yet submitted", () => {
    expect(payerDecisionOverdue({ ...base, state: "decided", today: "2030-01-01" })).toBe(false);
    expect(payerDecisionOverdue({ ...base, submittedOn: null, today: "2030-01-01" })).toBe(false);
  });
});

describe("shouldAlertPayerNoDeadline", () => {
  const now = new Date("2026-03-10T12:00:00Z");
  const row = (over: Record<string, unknown> = {}) => ({
    state: "draft",
    createdAt: new Date("2026-03-01T00:00:00Z"),
    hasDeadline: false,
    alreadyAlerted: false,
    ...over,
  });
  it("alerts an old draft with no deadline of either kind", () => {
    expect(shouldAlertPayerNoDeadline(row(), now)).toBe(true);
  });
  it("does not alert a fresh one, one with a deadline, or one already alerted", () => {
    expect(shouldAlertPayerNoDeadline(row({ createdAt: new Date("2026-03-10T00:00:00Z") }), now)).toBe(false);
    expect(shouldAlertPayerNoDeadline(row({ hasDeadline: true }), now)).toBe(false);
    expect(shouldAlertPayerNoDeadline(row({ alreadyAlerted: true }), now)).toBe(false);
  });
  it("does not alert a case that is no longer a draft", () => {
    expect(shouldAlertPayerNoDeadline(row({ state: "submitted" }), now)).toBe(false);
  });
});

describe("checkPayerOpen", () => {
  it("needs a level label and kind when no path level is chosen", () => {
    expect(checkPayerOpen({ hasPathLevel: false, levelLabel: "", levelKind: "internal" })).toBe("LEVEL_LABEL_REQUIRED");
    expect(checkPayerOpen({ hasPathLevel: false, levelLabel: "L1", levelKind: "x" })).toBe("LEVEL_KIND_INVALID");
    expect(checkPayerOpen({ hasPathLevel: false, levelLabel: "L1", levelKind: "other" })).toBeNull();
  });
  it("takes label and kind from the path level when one is chosen", () => {
    expect(checkPayerOpen({ hasPathLevel: true })).toBeNull();
  });
});

describe("checkPayerDecision", () => {
  it("needs an outcome", () => {
    expect(checkPayerDecision({ outcome: undefined })).toBe("OUTCOME_REQUIRED");
    expect(checkPayerDecision({ outcome: "maybe" })).toBe("OUTCOME_REQUIRED");
  });
  it("a disposition of 'other' needs a note, and a note needs a kind", () => {
    expect(checkPayerDecision({ outcome: "unfavorable", dispositionKind: "other" })).toBe("DISPOSITION_NOTE_REQUIRED");
    expect(checkPayerDecision({ outcome: "unfavorable", dispositionNote: "n" })).toBe("DISPOSITION_KIND_REQUIRED");
    expect(checkPayerDecision({ outcome: "unfavorable", dispositionKind: "remand" })).toBeNull();
  });
});
