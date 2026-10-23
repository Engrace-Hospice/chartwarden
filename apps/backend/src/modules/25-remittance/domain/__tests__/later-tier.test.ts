// M25 milestone 7a-1 - later-tier (ALJ / Council / federal court) facts are RECORDED, not ruled. Pure. Nothing here
// compares an amount to a threshold or encodes a window; the shipped 60-day windows are flagged unconfirmed.
import { describe, expect, it } from "vitest";
import {
  LATER_TIER_WINDOWS_CONFIRMED,
  canPacketRender,
  checkTierDetail,
  dispositionNeedsManualReview,
  isLaterTier,
  windowUnconfirmed,
} from "../later-tier";

describe("later tiers", () => {
  it("are alj, council and federal_court only", () => {
    expect(isLaterTier("alj")).toBe(true);
    expect(isLaterTier("council")).toBe(true);
    expect(isLaterTier("federal_court")).toBe(true);
    expect(isLaterTier("reconsideration")).toBe(false);
  });
  it("carry the not-confirmed flag for every shipped window, in one place", () => {
    expect(LATER_TIER_WINDOWS_CONFIRMED).toEqual({
      alj: false,
      council: false,
      federal_court: false,
    });
    expect(windowUnconfirmed("alj")).toBe(true);
    expect(windowUnconfirmed("redetermination")).toBe(false);
  });
});

describe("canPacketRender", () => {
  it("is false for federal court (a civil action is filed by counsel) and true for the rest", () => {
    expect(canPacketRender("federal_court")).toBe(false);
    expect(canPacketRender("alj")).toBe(true);
    expect(canPacketRender("council")).toBe(true);
    expect(canPacketRender("redetermination")).toBe(true);
  });
});

describe("checkTierDetail", () => {
  it("refuses a tier that is not a later tier", () => {
    expect(checkTierDetail("reconsideration", {})).toBe("TIER_NOT_LATER");
  });
  it("accepts an empty detail", () => {
    expect(checkTierDetail("alj", {})).toBeNull();
  });
  it("stores an amount in controversy as non-negative whole cents, never compared to anything", () => {
    expect(checkTierDetail("alj", { amountInControversyCents: 0 })).toBeNull();
    expect(checkTierDetail("alj", { amountInControversyCents: 12_345 })).toBeNull();
    expect(checkTierDetail("alj", { amountInControversyCents: -1 })).toBe("AMOUNT_INVALID");
    expect(checkTierDetail("alj", { amountInControversyCents: 1.5 })).toBe("AMOUNT_INVALID");
  });
  it("accepts only a real hearing date", () => {
    expect(checkTierDetail("alj", { hearingOn: "2026-05-04" })).toBeNull();
    expect(checkTierDetail("alj", { hearingOn: "2026-05-34" })).toBe("HEARING_ON_INVALID");
  });
  it("keeps counsel-filing facts to federal court", () => {
    expect(checkTierDetail("council", { docketReference: "1:26-cv-1" })).toBe("FEDERAL_ONLY_FIELD");
    expect(checkTierDetail("alj", { filedByCounselOn: "2026-05-04" })).toBe("FEDERAL_ONLY_FIELD");
    expect(
      checkTierDetail("federal_court", {
        filedByCounselOn: "2026-05-04",
        docketReference: "1:26-cv-1",
      }),
    ).toBeNull();
  });
  it("keeps hearing facts off federal court (record-only)", () => {
    expect(checkTierDetail("federal_court", { hearingOn: "2026-05-04" })).toBe(
      "HEARING_NOT_RECORDED",
    );
  });
  it("validates the disposition label and needs a note for 'other'", () => {
    expect(checkTierDetail("alj", { dispositionKind: "remand" })).toBeNull();
    expect(checkTierDetail("alj", { dispositionKind: "bogus" })).toBe("DISPOSITION_INVALID");
    expect(checkTierDetail("alj", { dispositionKind: "other" })).toBe("DISPOSITION_NOTE_REQUIRED");
    expect(
      checkTierDetail("alj", { dispositionKind: "other", dispositionNote: "see order" }),
    ).toBeNull();
  });
  it("refuses a disposition note with no kind", () => {
    expect(checkTierDetail("alj", { dispositionNote: "x" })).toBe("DISPOSITION_KIND_REQUIRED");
  });
});

describe("dispositionNeedsManualReview", () => {
  it("flags remand, dismissal and other but not a decision", () => {
    expect(dispositionNeedsManualReview("remand")).toBe(true);
    expect(dispositionNeedsManualReview("dismissal")).toBe(true);
    expect(dispositionNeedsManualReview("other")).toBe(true);
    expect(dispositionNeedsManualReview("decision")).toBe(false);
    expect(dispositionNeedsManualReview(null)).toBe(false);
  });
});
