// #845 — M5 coverage interval arithmetic: one inclusive convention for `patient_payer` dates, the replacement
// closure (prior row ends the day BEFORE its successor starts) and the range-wide, cross-kind resolver that
// billing gates use instead of sampling a window's endpoints.
import type { PatientCoverage } from "@chartwarden/types";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  addDaysIso,
  coverageForRange,
  inForceOn,
  replacementClosesOn,
} from "../src/modules/05-patient/coverage-intervals";

const cov = (over: Partial<PatientCoverage> & { id: string }): PatientCoverage => ({
  patientId: "p",
  payerId: "payer",
  rank: 1,
  coverageKind: "medicare_ffs",
  subscriberId: "x",
  groupNumber: null,
  current: over.effectiveTo === undefined || over.effectiveTo === null,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  ...over,
});

describe("addDaysIso", () => {
  it("crosses month, year and leap-day boundaries", () => {
    expect(addDaysIso("2026-01-15", -1)).toBe("2026-01-14");
    expect(addDaysIso("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysIso("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("rejects a value that is not a real calendar date with a typed 422", () => {
    for (const bad of ["2026-02-30", "2026-1-5", "yesterday", "2026-01-15T00:00:00Z"]) {
      expect(() => addDaysIso(bad, 1)).toThrow(ChartWardenError);
    }
  });
});

describe("replacementClosesOn", () => {
  it("closes the prior row the day before the replacement starts, so the two never share a day", () => {
    const closeOn = replacementClosesOn("2026-01-01", "2026-01-15");
    expect(closeOn).toBe("2026-01-14");
    const old = cov({ id: "old", effectiveTo: closeOn });
    const next = cov({ id: "new", effectiveFrom: "2026-01-15" });
    expect(inForceOn(old, "2026-01-15")).toBe(false);
    expect(inForceOn(next, "2026-01-15")).toBe(true);
    expect(inForceOn(old, "2026-01-14")).toBe(true);
  });

  it("allows a one-day prior coverage (replacement starts the day after)", () => {
    expect(replacementClosesOn("2026-01-01", "2026-01-02")).toBe("2026-01-01");
  });

  it("refuses a replacement starting on or before the current row's start (would invert its dates)", () => {
    for (const from of ["2026-01-01", "2025-12-01"]) {
      try {
        replacementClosesOn("2026-01-01", from);
        expect.fail("expected a refusal");
      } catch (e) {
        expect(e).toBeInstanceOf(ChartWardenError);
        expect((e as ChartWardenError).code).toBe("PAYER_REPLACEMENT_NOT_AFTER_CURRENT");
        expect((e as ChartWardenError).statusCode).toBe(409);
      }
    }
  });
});

describe("coverageForRange", () => {
  const range = { from: "2026-01-10", to: "2026-01-20" };

  it("is uniform when one coverage is top-ranked every day, whatever lower ranks do", () => {
    const rows = [
      cov({ id: "ffs" }),
      cov({ id: "sec-a", rank: 2, coverageKind: "medicaid", effectiveTo: "2026-01-12" }),
      cov({ id: "sec-b", rank: 2, coverageKind: "medicaid", effectiveFrom: "2026-01-13" }),
    ];
    const r = coverageForRange(rows, range);
    expect(r.status).toBe("uniform");
    expect(r.status === "uniform" && r.coverage.id).toBe("ffs");
  });

  it("reports the same-day cross-kind overlap the old closure produced as ambiguous (the #845 repro)", () => {
    const rows = [
      cov({ id: "ffs", effectiveTo: "2026-01-15" }),
      cov({ id: "commercial", coverageKind: "commercial", effectiveFrom: "2026-01-15" }),
    ];
    expect(coverageForRange(rows, { from: "2026-01-15", to: "2026-01-15" })).toEqual({
      status: "ambiguous",
      onDate: "2026-01-15",
    });
  });

  it("sees a payer switch strictly INSIDE the window, not only at its endpoints", () => {
    // Both endpoints show the FFS row on top; a rank-1 commercial row outranks it mid-window only.
    const rows = [
      cov({ id: "ffs", rank: 2 }),
      cov({
        id: "commercial",
        rank: 1,
        coverageKind: "commercial",
        effectiveFrom: "2026-01-14",
        effectiveTo: "2026-01-16",
      }),
    ];
    expect(coverageForRange(rows, range)).toEqual({ status: "changes", onDate: "2026-01-14" });
  });

  it("sees a replacement at a correct (day-before) closure as a change on the replacement's first day", () => {
    const rows = [
      cov({ id: "ffs", effectiveTo: "2026-01-14" }),
      cov({ id: "commercial", coverageKind: "commercial", effectiveFrom: "2026-01-15" }),
    ];
    expect(coverageForRange(rows, range)).toEqual({ status: "changes", onDate: "2026-01-15" });
    const before = coverageForRange(rows, { from: "2026-01-10", to: "2026-01-14" });
    expect(before.status === "uniform" && before.coverage.id).toBe("ffs");
    const after = coverageForRange(rows, { from: "2026-01-15", to: "2026-01-20" });
    expect(after.status === "uniform" && after.coverage.id).toBe("commercial");
  });

  it("reports a gap (no coverage at all) with its first uncovered day", () => {
    const rows = [cov({ id: "ffs", effectiveTo: "2026-01-17" })];
    expect(coverageForRange(rows, range)).toEqual({ status: "none", onDate: "2026-01-18" });
    expect(coverageForRange([], range)).toEqual({ status: "none", onDate: "2026-01-10" });
  });

  it("never treats an inverted (voided) row as in force", () => {
    const rows = [cov({ id: "void", effectiveFrom: "2026-01-15", effectiveTo: "2026-01-14" })];
    expect(coverageForRange(rows, range)).toEqual({ status: "none", onDate: "2026-01-10" });
  });

  it("restricted to one kind, ignores other kinds and resolves that kind's top-ranked row", () => {
    const rows = [
      cov({ id: "ffs" }),
      cov({ id: "mcd", rank: 2, coverageKind: "medicaid", effectiveTo: "2026-01-15" }),
    ];
    expect(coverageForRange(rows, range, "medicaid")).toEqual({
      status: "none",
      onDate: "2026-01-16",
    });
    const r = coverageForRange(rows, { from: "2026-01-10", to: "2026-01-15" }, "medicaid");
    expect(r.status === "uniform" && r.coverage.id).toBe("mcd");
  });

  it("refuses an inverted window with a typed 422", () => {
    expect(() => coverageForRange([], { from: "2026-01-20", to: "2026-01-10" })).toThrow(
      ChartWardenError,
    );
  });
});
