// ADR-0052 amendment (#767): age-based status for DDE items with no filing deadline. Pure, synthetic dates only.
import {
  DDE_AGING_AT_RISK_BUSINESS_DAYS,
  DDE_AGING_OVERDUE_BUSINESS_DAYS,
  DDE_UNASSIGNED_ALERT_BUSINESS_DAYS,
  businessDaysBetween,
  ddeAgingAlertFindings,
  ddeAgingCutoffDate,
  ddeDeadlineStatus,
} from "@chartwarden/billing";
import { describe, expect, it } from "vitest";

// 2026-10-05 is a Monday.
describe("businessDaysBetween", () => {
  it("counts weekdays after the start date up to and including the end date", () => {
    expect(businessDaysBetween("2026-10-05", "2026-10-05")).toBe(0);
    expect(businessDaysBetween("2026-10-05", "2026-10-09")).toBe(4);
    expect(businessDaysBetween("2026-10-09", "2026-10-12")).toBe(1); // Fri -> Mon skips the weekend
    expect(businessDaysBetween("2026-10-05", "2026-10-19")).toBe(10);
  });
  it("is zero when the end precedes the start", () => {
    expect(businessDaysBetween("2026-10-09", "2026-10-05")).toBe(0);
  });
});

describe("ddeAgingCutoffDate", () => {
  it("returns the latest creation date that is at least N business days old", () => {
    for (const asOf of ["2026-10-12", "2026-10-14", "2026-10-17", "2026-10-19"]) {
      const cutoff = ddeAgingCutoffDate(asOf, 5);
      expect(businessDaysBetween(cutoff, asOf)).toBeGreaterThanOrEqual(5);
      const next = new Date(`${cutoff}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      expect(businessDaysBetween(next.toISOString().slice(0, 10), asOf)).toBeLessThan(5);
    }
  });
});

describe("ddeDeadlineStatus for items with no deadline", () => {
  const base = { state: "queued", deadlineAt: null, macAcceptedOn: null } as const;
  it("stays none when the item has no age to judge (back-compat)", () => {
    expect(ddeDeadlineStatus(base, "2026-10-19")).toBe("none");
  });
  it("is on_track, at_risk, then overdue as the open item ages in business days", () => {
    const asOf = "2026-10-19";
    expect(ddeDeadlineStatus({ ...base, openedOn: "2026-10-16" }, asOf)).toBe("on_track");
    expect(ddeDeadlineStatus({ ...base, openedOn: "2026-10-12" }, asOf)).toBe("at_risk"); // 5 bd
    expect(ddeDeadlineStatus({ ...base, openedOn: "2026-10-05" }, asOf)).toBe("overdue"); // 10 bd
  });
  it("is none once the item is no longer open", () => {
    for (const state of ["accepted", "closed", "cancelled"] as const) {
      expect(ddeDeadlineStatus({ ...base, state, openedOn: "2026-01-05" }, "2026-10-19")).toBe(
        "none",
      );
    }
  });
  it("leaves deadline-bearing items on the deadline rule", () => {
    expect(
      ddeDeadlineStatus(
        { ...base, deadlineAt: "2026-10-30", openedOn: "2026-01-05" },
        "2026-10-19",
      ),
    ).toBe("on_track");
  });
  it("uses ordered named thresholds", () => {
    expect(DDE_AGING_AT_RISK_BUSINESS_DAYS).toBeLessThan(DDE_AGING_OVERDUE_BUSINESS_DAYS);
  });
});

describe("ddeAgingAlertFindings", () => {
  const item = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    state: "queued" as const,
    deadlineAt: null,
    openedOn: "2026-10-19",
    assigneeMembershipId: null,
    ...over,
  });
  const asOf = "2026-10-19";
  it("flags overdue null-deadline items and old unassigned items", () => {
    const out = ddeAgingAlertFindings(
      [
        item("a", { openedOn: "2026-10-05", assigneeMembershipId: "m1", state: "assigned" }),
        item("b", { openedOn: "2026-10-14" }), // 3 bd, unassigned
        item("c"), // today, unassigned: too young
        item("d", { openedOn: "2026-10-05" }), // both overdue and unassigned
        item("e", { openedOn: "2026-10-05", state: "closed" }),
        item("f", { deadlineAt: "2026-10-30", openedOn: "2026-10-05", assigneeMembershipId: "m1" }),
      ],
      asOf,
    );
    expect(out.overdueIds).toEqual(["a", "d"]);
    expect(out.unassignedIds).toEqual(["b", "d"]);
    expect(DDE_UNASSIGNED_ALERT_BUSINESS_DAYS).toBeGreaterThan(0);
  });
  it("is empty when nothing needs attention", () => {
    expect(ddeAgingAlertFindings([item("c")], asOf)).toEqual({
      overdueIds: [],
      unassignedIds: [],
    });
  });
});
