// M23 — the RHC carry-over resolver: M6's earlier stays merged with the latest resolved HETS check.
import { describe, expect, it } from "vitest";
import {
  hetsHistoryOfCheck,
  resolveRhcCarryOver,
  rhcCarryOverSnapshot,
} from "../services/rhc-carry-over";

const NOW = new Date("2026-02-16T12:00:00.000Z");
const check = (over: { checkedAt?: string; staleAt?: string; payload?: unknown } = {}) => ({
  id: "22222222-2222-4222-8222-222222222222",
  asOfServiceDate: "2026-02-10",
  outcome: "active_part_a" as const,
  checkedAt: new Date(over.checkedAt ?? "2026-02-10T00:00:00.000Z"),
  staleAt: new Date(over.staleAt ?? "2026-03-12T00:00:00.000Z"),
  parsedPayload: over.payload ?? {
    hospicePeriods: [
      {
        kind: "benefit_period",
        periodNumber: 1,
        startDate: "2026-01-10",
        endDate: "2026-01-30",
        hospiceNpi: "1649726464",
        revocationOrDischargeDate: "2026-01-30",
        revocationCode: "1",
        daysUsed: 21,
      },
    ],
    hospiceHistoryTruncated: false,
  },
});

describe("hetsHistoryOfCheck", () => {
  it("reads the validated hospice rows + age; a check past 30 days is stale", () => {
    const fresh = hetsHistoryOfCheck(check(), NOW);
    expect(fresh.ref).toMatchObject({ ageDays: 6, stale: false });
    expect(fresh.history?.periods).toHaveLength(1);
    const old = hetsHistoryOfCheck(check({ checkedAt: "2026-01-10T00:00:00.000Z" }), NOW);
    expect(old.ref?.stale).toBe(true);
  });

  it("a check with no hospice section yields no history (but still a check ref)", () => {
    const r = hetsHistoryOfCheck(check({ payload: { partAActive: true } }), NOW);
    expect(r.history).toBeNull();
    expect(r.ref).not.toBeNull();
  });
});

describe("resolveRhcCarryOver", () => {
  it("merges another hospice's days (the manual example: 21 days carry into a 02/16 election)", () => {
    const v = resolveRhcCarryOver({
      electionDate: "2026-02-16",
      priorStays: [],
      fallbackPriorDays: 0,
      check: check(),
      now: NOW,
    });
    expect(v).toMatchObject({
      priorDays: 21,
      basis: "hets_merged",
      startsAtDay: 22,
      highRateDaysRemaining: 39,
    });
    expect(rhcCarryOverSnapshot(v)).toEqual({
      priorDays: 21,
      basis: "hets_merged",
      readmittedWithin60Days: true,
      hetsCheckAgeDays: 6,
      warningCodes: [],
    });
  });

  it("marks a stale check hets_stale", () => {
    const v = resolveRhcCarryOver({
      electionDate: "2026-02-16",
      priorStays: [],
      fallbackPriorDays: 0,
      check: check({ staleAt: "2026-02-15T00:00:00.000Z" }),
      now: NOW,
    });
    expect(v.basis).toBe("hets_stale");
    expect(v.warnings.map((w) => w.code)).toContain("hets_stale");
  });

  it("uses M6's number as is when neither the stays list nor a HETS history is available", () => {
    const v = resolveRhcCarryOver({
      electionDate: "2026-02-16",
      priorStays: undefined,
      fallbackPriorDays: 25,
      check: null,
      now: NOW,
    });
    expect(v).toMatchObject({ priorDays: 25, basis: "internal_only", chain: [], hetsCheck: null });
    expect(rhcCarryOverSnapshot(v).readmittedWithin60Days).toBe(true);
  });
});
