import { LATE_ENTRY_REASON_MIN_CHARS } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import type { WriteResult } from "../encounters-api";
import {
  LATE_ENTRY_REASON_REQUIRED_CODE,
  estimateLateEntry,
  isLateEntryRefusal,
  lateEntryApprovalNote,
  lateEntryHowLate,
  lateEntryTierName,
  localCalendarDay,
  reasonCountText,
  reasonToSend,
  tierNeedsReason,
} from "../late-entry-reason";

const refusal = (code: string | null): WriteResult<never> => ({
  ok: false,
  status: 422,
  code,
  message: "late entry (tier 'significant_late_entry') requires a reason >= 40 characters",
  details: undefined,
});

describe("localCalendarDay", () => {
  it("is the device's own calendar day, zero-padded", () => {
    expect(localCalendarDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localCalendarDay(new Date(2026, 10, 24, 0, 1))).toBe("2026-11-24");
  });
});

describe("estimateLateEntry", () => {
  it.each([
    ["2026-11-24", "normal", 0],
    ["2026-11-23", "normal", 1],
    ["2026-11-22", "late_entry", 2],
    ["2026-11-20", "significant_late_entry", 4],
    ["2026-11-10", "significant_late_entry", 14],
    ["2026-11-09", "administrative_override", 15],
  ])("a visit on %s is %s (%i days)", (serviceDate, tier, daysLate) => {
    expect(estimateLateEntry(serviceDate, "2026-11-24")).toEqual({ tier, daysLate });
  });

  it("reads a service date that carries a time", () => {
    expect(estimateLateEntry("2026-11-17T00:00:00.000Z", "2026-11-24")?.daysLate).toBe(7);
  });

  it.each([null, undefined, "", "not-a-date", "2026-13-45"])(
    "guesses nothing from %s",
    (serviceDate) => {
      expect(estimateLateEntry(serviceDate, "2026-11-24")).toBeNull();
    },
  );

  it("treats a future-dated visit as on time (the server has its own guard for it)", () => {
    expect(estimateLateEntry("2026-11-30", "2026-11-24")?.tier).toBe("normal");
  });
});

describe("tierNeedsReason", () => {
  it("is every tier past normal", () => {
    expect(tierNeedsReason("normal")).toBe(false);
    expect(tierNeedsReason("late_entry")).toBe(true);
    expect(tierNeedsReason("significant_late_entry")).toBe(true);
    expect(tierNeedsReason("administrative_override")).toBe(true);
  });
});

describe("isLateEntryRefusal", () => {
  it("is the server's LATE_ENTRY_REASON_REQUIRED and nothing else", () => {
    expect(isLateEntryRefusal(refusal(LATE_ENTRY_REASON_REQUIRED_CODE))).toBe(true);
    expect(isLateEntryRefusal(refusal("COMPLIANCE_GATE_FAILED"))).toBe(false);
    expect(isLateEntryRefusal(refusal(null))).toBe(false);
    expect(isLateEntryRefusal({ ok: true, value: {} })).toBe(false);
  });
});

describe("the reason", () => {
  const long = "x".repeat(LATE_ENTRY_REASON_MIN_CHARS);

  it("is sent only once it is long enough, trimmed", () => {
    expect(reasonToSend("")).toBeUndefined();
    expect(reasonToSend(long.slice(1))).toBeUndefined();
    expect(reasonToSend(`  ${long}  `)).toBe(long);
  });

  it("does not count the spaces around it", () => {
    expect(reasonToSend(`${" ".repeat(10)}${long.slice(10)}`)).toBeUndefined();
  });

  it("counts characters and what is still missing", () => {
    expect(reasonCountText("")).toBe("0 of 40 characters, 40 more needed");
    expect(reasonCountText("x".repeat(12))).toBe("12 of 40 characters, 28 more needed");
    expect(reasonCountText(long)).toBe("40 characters");
    expect(reasonCountText("x".repeat(55))).toBe("55 characters");
  });
});

describe("the words", () => {
  const estimate = estimateLateEntry("2026-11-17", "2026-11-24");

  it("says how late the note is", () => {
    expect(lateEntryHowLate("2026-11-17", estimate)).toBe(
      "The visit was on 2026-11-17, 7 days ago.",
    );
    expect(lateEntryHowLate("2026-11-23", estimateLateEntry("2026-11-23", "2026-11-24"))).toBe(
      "The visit was on 2026-11-23, 1 day ago.",
    );
    expect(lateEntryHowLate("2026-11-24", estimateLateEntry("2026-11-24", "2026-11-24"))).toBe("");
    expect(lateEntryHowLate("2026-11-17", null)).toBe("");
  });

  it("names the tier only when it has an estimate", () => {
    expect(lateEntryTierName(estimate)).toBe("a significant late entry");
    expect(lateEntryTierName(null)).toBe("");
  });

  it("names who must approve a significant or administrative late entry before it can be signed", () => {
    expect(lateEntryApprovalNote(estimate)).toMatch(/Clinical Supervisor/);
    expect(lateEntryApprovalNote(estimateLateEntry("2026-10-01", "2026-11-24"))).toMatch(
      /Director/,
    );
    expect(lateEntryApprovalNote(estimateLateEntry("2026-11-22", "2026-11-24"))).toBe("");
    expect(lateEntryApprovalNote(null)).toBe("");
  });
});
