import { describe, expect, it } from "vitest";
import { buildHospiceLines } from "../src/line-assembly";

const rate =
  (cents: number, scheduleId = "sched-1") =>
  () => ({ rateCents: cents, scheduleId });

describe("buildHospiceLines", () => {
  it("builds one line per LOC period fully inside the claim window", () => {
    const { lines, missingRateSegments } = buildHospiceLines({
      serviceFrom: "2026-01-01",
      serviceTo: "2026-01-31",
      locPeriods: [
        { levelOfCarePeriodId: "loc-1", levelOfCare: "RHC", from: "2026-01-01", to: "2026-01-31" },
      ],
      rateFor: rate(20000),
      encounters: [],
      startingLineNumber: 1,
    });
    expect(missingRateSegments).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      lineNumber: 1,
      levelOfCare: "RHC",
      revenueCode: "0651",
      qCode: "Q5001",
      units: 31,
      rateCents: 20000,
      chargesCents: 31 * 20000,
    });
  });

  it("produces one line per contiguous LOC run, in order, with sequential line numbers", () => {
    const { lines } = buildHospiceLines({
      serviceFrom: "2026-01-01",
      serviceTo: "2026-01-20",
      locPeriods: [
        { levelOfCarePeriodId: "loc-1", levelOfCare: "RHC", from: "2026-01-01", to: "2026-01-10" },
        { levelOfCarePeriodId: "loc-2", levelOfCare: "GIP", from: "2026-01-11", to: "2026-01-15" },
        { levelOfCarePeriodId: "loc-3", levelOfCare: "RHC", from: "2026-01-16", to: "2026-01-20" },
      ],
      rateFor: (loc) =>
        loc === "RHC"
          ? { rateCents: 20000, scheduleId: "s-rhc" }
          : { rateCents: 90000, scheduleId: "s-gip" },
      encounters: [],
      startingLineNumber: 1,
    });
    expect(lines.map((l) => [l.lineNumber, l.levelOfCare, l.units])).toEqual([
      [1, "RHC", 10],
      [2, "GIP", 5],
      [3, "RHC", 5],
    ]);
    expect(lines[1].revenueCode).toBe("0656");
    expect(lines[1].qCode).toBe("Q5006");
  });

  it("clips a period that starts before / ends after the claim window", () => {
    const { lines } = buildHospiceLines({
      serviceFrom: "2026-01-10",
      serviceTo: "2026-01-20",
      locPeriods: [
        { levelOfCarePeriodId: "loc-1", levelOfCare: "RHC", from: "2025-12-01", to: "2026-02-01" },
      ],
      rateFor: rate(20000),
      encounters: [],
      startingLineNumber: 1,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].serviceDate).toBe("2026-01-10");
    expect(lines[0].serviceDateTo).toBe("2026-01-20");
    expect(lines[0].units).toBe(11);
  });

  it("clips an open-ended period (to: null) to the claim's serviceTo", () => {
    const { lines } = buildHospiceLines({
      serviceFrom: "2026-01-01",
      serviceTo: "2026-01-10",
      locPeriods: [
        { levelOfCarePeriodId: "loc-1", levelOfCare: "GIP", from: "2026-01-05", to: null },
      ],
      rateFor: rate(90000),
      encounters: [],
      startingLineNumber: 1,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].serviceDateTo).toBe("2026-01-10");
    expect(lines[0].units).toBe(6);
  });

  it("skips a period with no overlap with the claim window", () => {
    const { lines } = buildHospiceLines({
      serviceFrom: "2026-02-01",
      serviceTo: "2026-02-28",
      locPeriods: [
        { levelOfCarePeriodId: "loc-1", levelOfCare: "RHC", from: "2026-01-01", to: "2026-01-31" },
      ],
      rateFor: rate(20000),
      encounters: [],
      startingLineNumber: 1,
    });
    expect(lines).toHaveLength(0);
  });

  it("reports a missing rate as a diagnostic instead of fabricating a line", () => {
    const { lines, missingRateSegments } = buildHospiceLines({
      serviceFrom: "2026-01-01",
      serviceTo: "2026-01-10",
      locPeriods: [
        { levelOfCarePeriodId: "loc-1", levelOfCare: "IRC", from: "2026-01-01", to: "2026-01-10" },
      ],
      rateFor: () => null,
      encounters: [],
      startingLineNumber: 1,
    });
    expect(lines).toHaveLength(0);
    expect(missingRateSegments).toEqual([
      { levelOfCare: "IRC", from: "2026-01-01", to: "2026-01-10" },
    ]);
  });

  it("links only encounters whose serviceDate falls within the segment", () => {
    const { lines } = buildHospiceLines({
      serviceFrom: "2026-01-01",
      serviceTo: "2026-01-20",
      locPeriods: [
        { levelOfCarePeriodId: "loc-1", levelOfCare: "RHC", from: "2026-01-01", to: "2026-01-10" },
        { levelOfCarePeriodId: "loc-2", levelOfCare: "GIP", from: "2026-01-11", to: "2026-01-20" },
      ],
      rateFor: rate(20000),
      encounters: [
        { encounterId: "e1", serviceDate: "2026-01-05" },
        { encounterId: "e2", serviceDate: "2026-01-15" },
        { encounterId: "e3", serviceDate: "2026-01-25" }, // outside both segments
      ],
      startingLineNumber: 1,
    });
    expect(lines[0].backingEncounterIds).toEqual(["e1"]);
    expect(lines[1].backingEncounterIds).toEqual(["e2"]);
  });

  it("starts numbering from the given startingLineNumber", () => {
    const { lines } = buildHospiceLines({
      serviceFrom: "2026-01-01",
      serviceTo: "2026-01-05",
      locPeriods: [
        { levelOfCarePeriodId: "loc-1", levelOfCare: "RHC", from: "2026-01-01", to: "2026-01-05" },
      ],
      rateFor: rate(20000),
      encounters: [],
      startingLineNumber: 7,
    });
    expect(lines[0].lineNumber).toBe(7);
  });
});
