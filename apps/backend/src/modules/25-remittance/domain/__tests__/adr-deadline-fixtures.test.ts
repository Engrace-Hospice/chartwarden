// M25 — ADR response deadline fixtures (milestone 2a). Hand-worked so a clinical-billing SME can review the
// table: the response is due `windowDays` calendar days after the request date, a weekend or US federal
// holiday moves BACK to the previous business day (same conservative rule as appeal deadlines), and the last
// day is usable until its end in the provider zone (the earliest-ending zone when several).
import { describe, expect, it } from "vitest";
import { DEFAULT_ADR_WINDOWS, deriveAdrDeadline, resolveAdrWindow } from "../adr-deadline";
import { canTransitionAdr, isAdrTerminal } from "../adr-machine";

describe("ADR response deadline", () => {
  const FIXTURES = [
    { name: "due on Presidents' Day rolls to the prior Friday", requestedOn: "2026-01-02", days: 45, calendar: "2026-02-16", last: "2026-02-13" },
    { name: "45-day ADR landing on a weekday", requestedOn: "2026-02-02", days: 45, calendar: "2026-03-19", last: "2026-03-19" },
    { name: "20-day re-ADR across a month end", requestedOn: "2026-03-20", days: 20, calendar: "2026-04-09", last: "2026-04-09" },
    { name: "due on a Saturday rolls to Friday", requestedOn: "2026-01-28", days: 45, calendar: "2026-03-14", last: "2026-03-13" },
    { name: "due on a Sunday rolls to Friday", requestedOn: "2026-01-29", days: 45, calendar: "2026-03-15", last: "2026-03-13" },
  ] as const;

  it.each(FIXTURES)("$name", ({ requestedOn, days, calendar, last }) => {
    const d = deriveAdrDeadline(requestedOn, days);
    expect(d.calendarDueDay).toBe(calendar);
    expect(d.dueDay).toBe(last);
  });

  it("is usable until the end of the due day in the provider zone", () => {
    const d = deriveAdrDeadline("2026-02-02", 45, "America/New_York"); // Thu 2026-03-19, EDT? DST starts 03-08 -> EDT UTC-4
    expect(d.dueAt.toISOString()).toBe("2026-03-20T03:59:59.999Z");
  });

  it("uses the earliest-ending zone when a provider spans several", () => {
    const d = deriveAdrDeadline("2026-02-02", 45, ["America/Los_Angeles", "America/New_York"]);
    expect(d.zone).toBe("America/New_York");
  });

  it("rejects a bad request date or window", () => {
    expect(() => deriveAdrDeadline("2026-02-30", 45)).toThrow(/notice day/i);
    expect(() => deriveAdrDeadline("2026-02-02", 0)).toThrow(/window/i);
    expect(() => deriveAdrDeadline("2026-02-02", 1.5)).toThrow(/window/i);
  });
});

describe("ADR window resolution", () => {
  it("prefers the organization's rule and reports it verified or not", () => {
    const rules = [
      { macName: "CGS", reviewType: "adr", responseDays: 45, verifiedOn: "2026-10-01", sourceNote: "CGS ADR page" },
    ] as const;
    expect(resolveAdrWindow(rules, "cgs", "adr")).toEqual({
      days: 45, source: "org_rule", verified: true, sourceNote: "CGS ADR page",
    });
  });

  it("falls back to the platform default, marked unverified", () => {
    expect(resolveAdrWindow([], "Palmetto GBA", "adr")).toMatchObject({
      days: DEFAULT_ADR_WINDOWS.adr, source: "platform_default", verified: false,
    });
    expect(resolveAdrWindow([], "Palmetto GBA", "re_adr").days).toBe(DEFAULT_ADR_WINDOWS.re_adr);
  });

  it("treats a rule with no verification date as unverified", () => {
    const rules = [{ macName: "NGS", reviewType: "adr", responseDays: 30, verifiedOn: null, sourceNote: null }] as const;
    expect(resolveAdrWindow(rules, "NGS", "adr")).toMatchObject({ days: 30, source: "org_rule", verified: false });
  });
});

describe("ADR state machine", () => {
  it("moves forward through assembly, review and submission", () => {
    expect(canTransitionAdr("received", "in_assembly")).toBe(true);
    expect(canTransitionAdr("in_assembly", "in_review")).toBe(true);
    expect(canTransitionAdr("in_review", "submitted")).toBe(true);
    expect(canTransitionAdr("submitted", "closed")).toBe(true);
  });

  it("lets review send a packet back to assembly, but never skip review", () => {
    expect(canTransitionAdr("in_review", "in_assembly")).toBe(true);
    expect(canTransitionAdr("in_assembly", "submitted")).toBe(false);
    expect(canTransitionAdr("received", "submitted")).toBe(false);
  });

  it("allows withdrawal and a missed deadline only before submission", () => {
    expect(canTransitionAdr("in_assembly", "withdrawn")).toBe(true);
    expect(canTransitionAdr("received", "denied_no_response")).toBe(true);
    expect(canTransitionAdr("submitted", "denied_no_response")).toBe(false);
  });

  it("treats withdrawn, denied_no_response and closed as terminal", () => {
    for (const s of ["withdrawn", "denied_no_response", "closed"] as const) {
      expect(isAdrTerminal(s)).toBe(true);
    }
    expect(isAdrTerminal("in_review")).toBe(false);
  });
});
