// M25 — CMS appeal-deadline fixtures (milestone 1 of the hospice ADR/TPE/QIC PRD). Each row is an expected
// last-filing-day for a notice date, worked by hand from the regulation text so a clinical-billing SME can
// review the table without reading code. A mismatch here is a wrong legal deadline shown to a user.
//
// Rule: window runs from RECEIPT, receipt is presumed 5 calendar days after the notice date, the last day
// is usable until its end in the deadline zone. No weekend/holiday roll-forward (not found in Part 405).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEADLINE_ZONE,
  RECEIPT_PRESUMPTION_DAYS,
  computeTierDeadline,
  deriveTierDeadline,
  isKnownZone,
  isWithinDeadline,
} from "../deadline";
import type { AppealTier } from "../types";

interface Fixture {
  readonly name: string;
  readonly tier: AppealTier;
  readonly noticeDay: string;
  readonly lastFilingDay: string;
}

const FIXTURES: readonly Fixture[] = [
  // redetermination: 120 days from receipt = notice + 5 + 120 = notice + 125 (42 CFR 405.942)
  { name: "redetermination mid-year", tier: "redetermination", noticeDay: "2026-01-01", lastFilingDay: "2026-05-06" },
  { name: "redetermination crossing year end", tier: "redetermination", noticeDay: "2025-09-01", lastFilingDay: "2026-01-04" },
  { name: "redetermination crossing leap day", tier: "redetermination", noticeDay: "2024-01-01", lastFilingDay: "2024-05-05" },
  // reconsideration (QIC): 180 days from receipt = notice + 185 (42 CFR 405.962)
  { name: "reconsideration mid-year", tier: "reconsideration", noticeDay: "2026-01-01", lastFilingDay: "2026-07-05" },
  { name: "reconsideration crossing year end", tier: "reconsideration", noticeDay: "2026-08-01", lastFilingDay: "2027-02-02" },
  // alj / council / federal court: 60 days from receipt = notice + 65 (405.1002, 405.1102, 405.1136)
  { name: "alj", tier: "alj", noticeDay: "2026-01-01", lastFilingDay: "2026-03-07" },
  { name: "council", tier: "council", noticeDay: "2026-01-01", lastFilingDay: "2026-03-07" },
  { name: "federal court crossing month end", tier: "federal_court", noticeDay: "2026-01-20", lastFilingDay: "2026-03-26" },
];

describe("CMS appeal deadlines — last filing day", () => {
  it.each(FIXTURES)("$name", ({ tier, noticeDay, lastFilingDay }) => {
    const derived = deriveTierDeadline(tier, noticeDay);
    expect(derived.lastFilingDay).toBe(lastFilingDay);
  });

  it("presumes receipt 5 calendar days after the notice date", () => {
    expect(RECEIPT_PRESUMPTION_DAYS).toBe(5);
    expect(deriveTierDeadline("redetermination", "2026-01-01").presumedReceiptOn).toBe("2026-01-06");
  });

  it("reports the window used for each tier", () => {
    expect(deriveTierDeadline("redetermination", "2026-01-01").windowDays).toBe(120);
    expect(deriveTierDeadline("reconsideration", "2026-01-01").windowDays).toBe(180);
    expect(deriveTierDeadline("alj", "2026-01-01").windowDays).toBe(60);
  });

  it("rejects a notice day that is not a real calendar date", () => {
    expect(() => deriveTierDeadline("alj", "2026-02-30")).toThrow(/notice day/i);
    expect(() => deriveTierDeadline("alj", "01/02/2026")).toThrow(/notice day/i);
  });
});

describe("CMS appeal deadlines — last day is usable until it ends", () => {
  // 2026-01-01 redetermination → last filing day 2026-05-06; New York is on daylight time (UTC-4) in May.
  const deadline = computeTierDeadline("redetermination", "2026-01-01", "America/New_York");

  it("accepts a filing at 23:59 local on the last day", () => {
    const lateEvening = new Date("2026-05-07T03:59:00Z"); // 23:59 EDT on May 6
    expect(isWithinDeadline(deadline, lateEvening)).toBe(true);
  });

  it("rejects a filing at 00:00 local the next day", () => {
    const midnight = new Date("2026-05-07T04:00:00Z"); // 00:00 EDT on May 7
    expect(isWithinDeadline(deadline, midnight)).toBe(false);
  });

  it("accepts a filing early on the last day (a start-of-day deadline would reject it)", () => {
    const morning = new Date("2026-05-06T14:00:00Z");
    expect(isWithinDeadline(deadline, morning)).toBe(true);
  });
});

describe("CMS appeal deadlines — time zone and daylight saving", () => {
  it("uses the supplied zone for the end of the last day", () => {
    // Last filing day 2026-03-07; Los Angeles is still on standard time (UTC-8) until Mar 8.
    const pacific = computeTierDeadline("alj", "2026-01-01", "America/Los_Angeles");
    expect(pacific.toISOString()).toBe("2026-03-08T07:59:59.999Z");
  });

  it("defaults to a documented zone", () => {
    expect(DEFAULT_DEADLINE_ZONE).toBe("America/New_York");
    // 23:59:59.999 EST (UTC-5) on 2026-03-07.
    expect(computeTierDeadline("alj", "2026-01-01").toISOString()).toBe("2026-03-08T04:59:59.999Z");
  });

  it("ends the day correctly on the spring daylight-saving change day", () => {
    // Last filing day 2026-03-08, the day US clocks spring forward; 23:59:59.999 EDT (UTC-4).
    const deadline = computeTierDeadline("alj", "2026-01-02", "America/New_York");
    expect(deadline.toISOString()).toBe("2026-03-09T03:59:59.999Z");
  });

  it("recognises real IANA zones and rejects unknown ones", () => {
    expect(isKnownZone("America/Chicago")).toBe(true);
    expect(isKnownZone("Mars/Olympus")).toBe(false);
  });

  it("ends the day correctly on the autumn daylight-saving change day", () => {
    // 2026-06-29 + 125 days = 2026-11-01, the day US clocks fall back; 23:59:59.999 EST (UTC-5).
    const deadline = computeTierDeadline("redetermination", "2026-06-29", "America/New_York");
    expect(deadline.toISOString()).toBe("2026-11-02T04:59:59.999Z");
  });
});
