import { describe, expect, it } from "vitest";
import {
  type PlaceOfServiceFacts,
  buildHospiceLines,
  resolvePlaceOfServiceQCode,
} from "../src/line-assembly";

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

  it("uses the resolved place-of-service Q-code instead of the LOC-based default when facts are supplied", () => {
    const { lines } = buildHospiceLines({
      serviceFrom: "2026-01-01",
      serviceTo: "2026-01-05",
      locPeriods: [
        {
          levelOfCarePeriodId: "loc-1",
          levelOfCare: "RHC",
          from: "2026-01-01",
          to: "2026-01-05",
          placeOfService: {
            ownIpuBed: false,
            locPeriodFacilityKind: "snf",
            residenceKind: null,
            residenceFacilityKind: null,
          },
        },
      ],
      rateFor: rate(20000),
      encounters: [],
      startingLineNumber: 1,
    });
    expect(lines[0].qCode).toBe("Q5004");
  });
});

const NO_FACTS: PlaceOfServiceFacts = {
  ownIpuBed: false,
  locPeriodFacilityKind: null,
  residenceKind: null,
  residenceFacilityKind: null,
};

describe("resolvePlaceOfServiceQCode", () => {
  it("a confirmed own-IPU bed is always Q5006, regardless of any facility-kind fact", () => {
    expect(
      resolvePlaceOfServiceQCode("GIP", {
        ...NO_FACTS,
        ownIpuBed: true,
        locPeriodFacilityKind: "hospital",
      }),
    ).toBe("Q5006");
  });

  it("the LOC period's own facility kind takes priority over the patient's residence", () => {
    expect(
      resolvePlaceOfServiceQCode("GIP", {
        ...NO_FACTS,
        locPeriodFacilityKind: "hospital",
        residenceKind: "facility",
        residenceFacilityKind: "alf",
      }),
    ).toBe("Q5005");
  });

  it.each([
    ["hospital", "Q5005"],
    ["alf", "Q5002"],
    ["nf", "Q5003"],
    ["snf", "Q5004"],
    ["ipu", "Q5006"],
    ["ltch", "Q5007"],
    ["psych", "Q5008"],
    ["clinic", "Q5009"],
    ["other", "Q5009"],
  ] as const)("locPeriodFacilityKind=%s resolves %s", (kind, expected) => {
    expect(resolvePlaceOfServiceQCode("RHC", { ...NO_FACTS, locPeriodFacilityKind: kind })).toBe(
      expected,
    );
  });

  it("falls back to the patient's residence facility kind when the LOC period has none", () => {
    expect(
      resolvePlaceOfServiceQCode("RHC", {
        ...NO_FACTS,
        residenceKind: "facility",
        residenceFacilityKind: "snf",
      }),
    ).toBe("Q5004");
  });

  it("ignores the residence facility kind when residenceKind is not 'facility'", () => {
    expect(
      resolvePlaceOfServiceQCode("RHC", {
        ...NO_FACTS,
        residenceKind: "mailing",
        residenceFacilityKind: "snf",
      }),
    ).toBe("Q5001");
  });

  it("resolves home residence to Q5001", () => {
    expect(resolvePlaceOfServiceQCode("CHC", { ...NO_FACTS, residenceKind: "home" })).toBe("Q5001");
  });

  it("with no facts at all, GIP defaults to Q5006 (the common own-inpatient-facility case)", () => {
    expect(resolvePlaceOfServiceQCode("GIP", NO_FACTS)).toBe("Q5006");
  });

  it("with no facts at all, IRC defaults to Q5009 (NOS — inpatient respite is never honestly 'home')", () => {
    expect(resolvePlaceOfServiceQCode("IRC", NO_FACTS)).toBe("Q5009");
  });

  it("with no facts at all, RHC/CHC default to Q5001 (home is the overwhelming common case)", () => {
    expect(resolvePlaceOfServiceQCode("RHC", NO_FACTS)).toBe("Q5001");
    expect(resolvePlaceOfServiceQCode("CHC", NO_FACTS)).toBe("Q5001");
  });
});
