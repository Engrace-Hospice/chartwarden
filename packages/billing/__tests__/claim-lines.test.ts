// @wardenx/billing — pure claim-line derivations (CMS Pub. 100-04 ch. 11 §30.3): the hospice visit-line
// table + builder and the CHC 15-minute unit conversion. No DB, no clock.
import {
  CHC_UNITS_PER_HOUR,
  HOSPICE_VISIT_UNIT_MINUTES,
  type PhysicianResolution,
  type VisitEncounterInput,
  type VisitLevelOfCarePeriod,
  buildVisitLines,
  chcLineFromSegment,
  claimPhysicianNpis,
  hospiceValueCodeForRevenue,
  visitCodeFor,
  visitUnitsForMinutes,
} from "@wardenx/billing";
import { describe, expect, it } from "vitest";

describe("visitCodeFor — CMS ch. 11 §30.3 revenue-code / HCPCS table", () => {
  it.each([
    ["rn", "routine_visit", "0551", "G0299"],
    ["lpn", "lpn_visit", "0551", "G0300"],
    ["chha", "chha_visit", "0571", "G0156"],
    ["msw", "msw_assessment", "0561", "G0155"],
    ["msw", "msw_followup", "0561", "G0155"],
    ["msw", "telephonic", "0569", "G0155"],
    ["pt", "pt_visit", "0421", "G0151"],
    ["ot", "ot_visit", "0431", "G0152"],
    ["slp", "slp_visit", "0441", "G0153"],
  ])("%s / %s -> rev %s HCPCS %s", (discipline, encounterType, revenueCode, hcpcsCode) => {
    // The charge discipline is the authoring discipline, except an aide is `chha` (the charge schedule's key).
    expect(visitCodeFor({ discipline, encounterType })).toEqual({
      revenueCode,
      hcpcsCode,
      discipline,
    });
  });

  it("matches the discipline case-insensitively", () => {
    expect(visitCodeFor({ discipline: "RN", encounterType: "routine_visit" })?.hcpcsCode).toBe(
      "G0299",
    );
  });

  it.each([
    ["pt", "telephonic"],
    ["ot", "telephonic"],
    ["slp", "telephonic"],
    ["chaplain", "chaplain_visit"],
    ["volunteer", "volunteer_visit"],
    ["md", "routine_visit"],
    ["np", "face_to_face"],
    ["rn", "idg_followup"],
    ["rn", "bereavement_contact"],
    ["rn", "telephonic"],
    ["chha", "telephonic"],
  ])("%s / %s is not a reportable visit line", (discipline, encounterType) => {
    expect(visitCodeFor({ discipline, encounterType })).toBeNull();
  });
});

describe("visitUnitsForMinutes — nearest 15-minute increment, any visit length reported", () => {
  it("exposes the 15-minute increment", () => {
    expect(HOSPICE_VISIT_UNIT_MINUTES).toBe(15);
  });

  it.each([
    [1, 1],
    [7, 1],
    [8, 1],
    [22, 1],
    [23, 2],
    [30, 2],
    [45, 3],
    [60, 4],
    [127, 8],
  ])("%d minutes -> %d units", (minutes, units) => {
    expect(visitUnitsForMinutes(minutes)).toBe(units);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])("%s minutes is unresolved (null)", (m) => {
    expect(visitUnitsForMinutes(m)).toBeNull();
  });
});

const rhcPeriod: VisitLevelOfCarePeriod = {
  levelOfCarePeriodId: "loc-1",
  levelOfCare: "routine_home_care",
  from: "2026-10-01",
  to: "2026-10-31",
};

function encounter(overrides: Partial<VisitEncounterInput> = {}): VisitEncounterInput {
  return {
    encounterId: "enc-1",
    serviceDate: "2026-10-05",
    billability: "billable",
    discipline: "rn",
    encounterType: "routine_visit",
    durationMinutes: 45,
    ...overrides,
  };
}

describe("buildVisitLines", () => {
  it("emits one dated line per billable visit with 15-minute units on the owning LOC period", () => {
    const r = buildVisitLines({
      encounters: [encounter()],
      levelOfCarePeriods: [rhcPeriod],
      inpatientHospiceFacility: false,
    });
    expect(r.unresolved).toEqual([]);
    expect(r.deferred).toEqual([]);
    expect(r.lines).toEqual([
      {
        revenueCode: "0551",
        hcpcsCode: "G0299",
        discipline: "rn",
        serviceDate: "2026-10-05",
        unitCount: 3,
        levelOfCare: "routine_home_care",
        levelOfCarePeriodId: "loc-1",
        backingEncounterIds: ["enc-1"],
      },
    ]);
  });

  it("keeps same-day visits as separate lines (each visit is its own line)", () => {
    const r = buildVisitLines({
      encounters: [
        encounter({ encounterId: "b", durationMinutes: 30 }),
        encounter({ encounterId: "a", durationMinutes: 60 }),
      ],
      levelOfCarePeriods: [rhcPeriod],
      inpatientHospiceFacility: false,
    });
    expect(r.lines.map((l) => [l.backingEncounterIds[0], l.unitCount])).toEqual([
      ["a", 4],
      ["b", 2],
    ]);
  });

  it("orders lines by date then encounter id, deterministically", () => {
    const r = buildVisitLines({
      encounters: [
        encounter({ encounterId: "z", serviceDate: "2026-10-09" }),
        encounter({ encounterId: "y", serviceDate: "2026-10-02" }),
      ],
      levelOfCarePeriods: [rhcPeriod],
      inpatientHospiceFacility: false,
    });
    expect(r.lines.map((l) => l.serviceDate)).toEqual(["2026-10-02", "2026-10-09"]);
  });

  it("ignores non-billable and awaiting-cosignature encounters", () => {
    const r = buildVisitLines({
      encounters: [
        encounter({ encounterId: "n", billability: "not_billable" }),
        encounter({ encounterId: "c", billability: "awaiting_cosignature" }),
      ],
      levelOfCarePeriods: [rhcPeriod],
      inpatientHospiceFacility: false,
    });
    expect(r).toEqual({ lines: [], unresolved: [], deferred: [] });
  });

  it("silently skips encounters that are not reportable visits (chaplain, IDG, physician)", () => {
    const r = buildVisitLines({
      encounters: [
        encounter({ encounterId: "c", discipline: "chaplain", encounterType: "chaplain_visit" }),
        encounter({ encounterId: "i", encounterType: "idg_followup" }),
        encounter({ encounterId: "m", discipline: "md" }),
      ],
      levelOfCarePeriods: [rhcPeriod],
      inpatientHospiceFacility: false,
    });
    expect(r).toEqual({ lines: [], unresolved: [], deferred: [] });
  });

  it("reports a visit with no documented duration as unresolved instead of guessing units", () => {
    const r = buildVisitLines({
      encounters: [
        encounter({ durationMinutes: 0 }),
        encounter({ encounterId: "n", durationMinutes: null }),
      ],
      levelOfCarePeriods: [rhcPeriod],
      inpatientHospiceFacility: false,
    });
    expect(r.lines).toEqual([]);
    expect(r.unresolved).toEqual([
      { encounterId: "enc-1", reason: "duration_missing" },
      { encounterId: "n", reason: "duration_missing" },
    ]);
  });

  it("reports a visit outside every level-of-care period as unresolved", () => {
    const r = buildVisitLines({
      encounters: [encounter({ serviceDate: "2026-11-02" })],
      levelOfCarePeriods: [rhcPeriod],
      inpatientHospiceFacility: false,
    });
    expect(r.lines).toEqual([]);
    expect(r.unresolved).toEqual([{ encounterId: "enc-1", reason: "no_level_of_care_period" }]);
  });

  it("rides the CHC period for a visit under continuous home care", () => {
    const r = buildVisitLines({
      encounters: [encounter({ discipline: "chha", encounterType: "chha_visit" })],
      levelOfCarePeriods: [
        { ...rhcPeriod, levelOfCarePeriodId: "chc-1", levelOfCare: "continuous_home_care" },
      ],
      inpatientHospiceFacility: false,
    });
    expect(r.lines[0]).toMatchObject({
      revenueCode: "0571",
      hcpcsCode: "G0156",
      levelOfCare: "continuous_home_care",
    });
  });

  it("defers every visit at an inpatient hospice facility (weekly reporting is not implemented)", () => {
    const r = buildVisitLines({
      encounters: [encounter()],
      levelOfCarePeriods: [rhcPeriod],
      inpatientHospiceFacility: true,
    });
    expect(r.lines).toEqual([]);
    expect(r.deferred).toEqual([
      { encounterId: "enc-1", reason: "inpatient_hospice_facility_weekly_reporting" },
    ]);
  });
});

describe("chcLineFromSegment — revenue 0652 in 15-minute units", () => {
  it("converts documented hours to quarter-hour units at a quarter of the hourly rate", () => {
    expect(CHC_UNITS_PER_HOUR).toBe(4);
    expect(chcLineFromSegment({ chcHours: 10, chcAdjustedHourlyRateCents: 4000 })).toEqual({
      unitCount: 40,
      unitRateCents: 1000,
      lineChargeCents: 40000,
    });
  });

  it("rounds the unit rate half-up to whole cents and bills units x rate", () => {
    // 4015 / 4 = 1003.75 -> 1004; 8.25h -> 33 units.
    expect(chcLineFromSegment({ chcHours: 8.25, chcAdjustedHourlyRateCents: 4015 })).toEqual({
      unitCount: 33,
      unitRateCents: 1004,
      lineChargeCents: 33 * 1004,
    });
  });

  it("refuses a segment without documented hours or an hourly rate", () => {
    expect(() => chcLineFromSegment({ chcHours: null, chcAdjustedHourlyRateCents: 4000 })).toThrow(
      /documented hours/,
    );
    expect(() => chcLineFromSegment({ chcHours: 8, chcAdjustedHourlyRateCents: null })).toThrow(
      /hourly rate/,
    );
  });

  it("refuses hours that are not a whole number of 15-minute units", () => {
    expect(() => chcLineFromSegment({ chcHours: 8.1, chcAdjustedHourlyRateCents: 4000 })).toThrow(
      /15-minute/,
    );
  });
});

describe("hospiceValueCodeForRevenue — CBSA value code by level of care", () => {
  it("is 61 for home levels (0651/0652) and G8 for inpatient levels (0655/0656)", () => {
    expect(hospiceValueCodeForRevenue("0651")).toBe("61");
    expect(hospiceValueCodeForRevenue("0652")).toBe("61");
    expect(hospiceValueCodeForRevenue("0655")).toBe("G8");
    expect(hospiceValueCodeForRevenue("0656")).toBe("G8");
  });

  it("is null for non level-of-care revenue codes", () => {
    expect(hospiceValueCodeForRevenue("0551")).toBeNull();
    expect(hospiceValueCodeForRevenue("0657")).toBeNull();
  });
});

describe("claimPhysicianNpis — UB-04 FL 76 attending / FL 78 certifying", () => {
  const physician = (npi: string): PhysicianResolution => ({
    npi,
    status: "active",
    licenseUnexpiredOnServiceDates: true,
  });

  it("returns the attending NPI and omits the certifying NPI when they are the same physician", () => {
    expect(
      claimPhysicianNpis({
        attending: physician("1234567893"),
        hospicePhysician: physician("1234567893"),
        placeOfService: null,
      }),
    ).toEqual({ attendingPhysicianNpi: "1234567893", certifyingPhysicianNpi: null });
  });

  it("reports the hospice physician as certifying when different from the attending", () => {
    expect(
      claimPhysicianNpis({
        attending: physician("1234567893"),
        hospicePhysician: physician("1982736455"),
        placeOfService: null,
      }),
    ).toEqual({ attendingPhysicianNpi: "1234567893", certifyingPhysicianNpi: "1982736455" });
  });

  it("is null for an unresolved physician, never a guess", () => {
    expect(
      claimPhysicianNpis({ attending: null, hospicePhysician: null, placeOfService: null }),
    ).toEqual({ attendingPhysicianNpi: null, certifyingPhysicianNpi: null });
  });

  it("drops an NPI that is not 10 digits", () => {
    expect(
      claimPhysicianNpis({
        attending: physician("12345"),
        hospicePhysician: physician("1982736455"),
        placeOfService: null,
      }),
    ).toEqual({ attendingPhysicianNpi: null, certifyingPhysicianNpi: "1982736455" });
  });
});
