// M25 — CMS appeal-deadline fixtures (milestone 1 of the hospice ADR/TPE/QIC PRD). Each row is an expected
// last-filing-day for a notice date, worked by hand from the regulation text so a clinical-billing SME can
// review the table without reading code. A mismatch here is a wrong legal deadline shown to a user.
//
// Rule: window runs from RECEIPT, receipt is presumed 5 calendar days after the notice date, the last day
// is usable until its end in the deadline zone. A last day on a weekend or US federal holiday moves BACK to
// the previous business day (clinical-billing SME decision); the calendar day is kept as `calendarLastDay`.
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
  { name: "redetermination crossing year end", tier: "redetermination", noticeDay: "2025-09-01", lastFilingDay: "2026-01-02" },
  { name: "redetermination crossing leap day", tier: "redetermination", noticeDay: "2024-01-01", lastFilingDay: "2024-05-03" },
  // reconsideration (QIC): 180 days from receipt = notice + 185 (42 CFR 405.962)
  { name: "reconsideration mid-year", tier: "reconsideration", noticeDay: "2026-01-01", lastFilingDay: "2026-07-02" },
  { name: "reconsideration crossing year end", tier: "reconsideration", noticeDay: "2026-08-01", lastFilingDay: "2027-02-02" },
  // alj / council / federal court: 60 days from receipt = notice + 65 (405.1002, 405.1102, 405.1136)
  { name: "alj", tier: "alj", noticeDay: "2026-01-01", lastFilingDay: "2026-03-06" },
  { name: "council", tier: "council", noticeDay: "2026-01-01", lastFilingDay: "2026-03-06" },
  { name: "federal court crossing month end", tier: "federal_court", noticeDay: "2026-01-20", lastFilingDay: "2026-03-26" },
];

describe("CMS appeal deadlines — last filing day", () => {
  it.each(FIXTURES)("$name", ({ tier, noticeDay, lastFilingDay }) => {
    const derived = deriveTierDeadline(tier, noticeDay);
    expect(derived.lastFilingDay).toBe(lastFilingDay);
  });

  it("keeps the calendar day beside the rolled-back filing day", () => {
    const d = deriveTierDeadline("reconsideration", "2026-01-01");
    expect(d.calendarLastDay).toBe("2026-07-05"); // Sunday; Saturday 4 July is observed on Friday 3 July
    expect(d.lastFilingDay).toBe("2026-07-02");
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

describe("CMS appeal deadlines — business-day roll-back", () => {
  const last = (tier: AppealTier, day: string) => deriveTierDeadline(tier, day).lastFilingDay;

  it("moves a Saturday back to Friday and a Sunday back to Friday", () => {
    expect(last("alj", "2026-01-01")).toBe("2026-03-06"); // calendar Saturday 7 March
    expect(last("redetermination", "2024-01-01")).toBe("2024-05-03"); // calendar Sunday 5 May
  });

  it("moves a Monday holiday back over the weekend to the previous Friday", () => {
    // 2026-07-04 + 65 = Monday 2026-09-07 (Labor Day) -> Friday 2026-09-04.
    expect(deriveTierDeadline("alj", "2026-07-04").calendarLastDay).toBe("2026-09-07");
    expect(last("alj", "2026-07-04")).toBe("2026-09-04");
  });

  it("treats Christmas on a Friday as a holiday", () => {
    // 2026-12-25 is a Friday. alj: notice + 65 = 2026-12-25 -> notice 2026-10-21.
    expect(deriveTierDeadline("alj", "2026-10-21").calendarLastDay).toBe("2026-12-25");
    expect(last("alj", "2026-10-21")).toBe("2026-12-24");
  });

  it("observes a Saturday 1 January on the prior 31 December", () => {
    // 1 January 2028 is a Saturday, observed Friday 31 December 2027.
    expect(deriveTierDeadline("redetermination", "2027-08-29").calendarLastDay).toBe("2028-01-01");
    expect(last("redetermination", "2027-08-29")).toBe("2027-12-30");
  });
});

describe("CMS appeal deadlines — time zone and daylight saving", () => {
  it("uses the supplied zone for the end of the last day", () => {
    // Last filing day Friday 2026-03-06; Los Angeles is on standard time (UTC-8).
    const pacific = computeTierDeadline("alj", "2026-01-01", "America/Los_Angeles");
    expect(pacific.toISOString()).toBe("2026-03-07T07:59:59.999Z");
  });

  it("defaults to a documented zone", () => {
    expect(DEFAULT_DEADLINE_ZONE).toBe("America/New_York");
    // 23:59:59.999 EST (UTC-5) on 2026-03-06.
    expect(computeTierDeadline("alj", "2026-01-01").toISOString()).toBe("2026-03-07T04:59:59.999Z");
  });

  it("uses the earliest-ending zone when a provider has locations in several", () => {
    // Friday 2026-03-06: Puerto Rico (AST, UTC-4 all year) ends before New York (EST, UTC-5) and Los Angeles.
    const zones = ["America/Los_Angeles", "America/New_York", "America/Puerto_Rico"];
    const d = deriveTierDeadline("alj", "2026-01-01", zones);
    expect(d.zone).toBe("America/Puerto_Rico");
    expect(d.deadlineAt.toISOString()).toBe("2026-03-07T03:59:59.999Z");
  });

  it("recognises real IANA zones and rejects unknown ones", () => {
    expect(isKnownZone("America/Chicago")).toBe(true);
    expect(isKnownZone("Mars/Olympus")).toBe(false);
  });
});
