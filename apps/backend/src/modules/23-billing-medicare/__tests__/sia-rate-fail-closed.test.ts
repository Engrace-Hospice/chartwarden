// CW-PI-05 — a payable Service Intensity Add-on is never priced from a rate that is not there. The rate comes from the
// tenant-entered, effective-dated hospice rate table (the version covering the date priced) and the wage index of the
// fiscal year of the death; when any of it is missing, or is not a usable amount, the claim is refused with a typed 422
// and nothing is priced (never a $0 add-on, never a fall back to the claim's first year). The advisory for the PRIOR
// month's claim is informational and never blocks, but it stays null (unknown), never a fabricated 0.
//
// The real adapter's effective-date and missing-version behavior against the database is proved live in
// m23-rate-table.live.test.ts; these cases drive computeClaimSia through the seam with the same typed errors.
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { computeClaimSia } from "../services/claim-assembly-facts";

const RHC_PERIODS = [
  {
    levelOfCarePeriodId: "loc-1",
    levelOfCare: "routine_home_care",
    from: "2026-09-01",
    to: "2026-11-30",
    chcDocumentedHours: null,
    gipAdmissionCriteriaDocumented: null,
  },
];

const rnVisit = (encounterId: string, serviceDate: string, durationMinutes: number) => ({
  encounterId,
  serviceDate,
  billability: "billable" as const,
  discipline: "rn",
  encounterType: "routine_visit",
  durationMinutes,
  modality: "in_person" as const,
  modalityConfirmed: true,
});

const deathAdmission = (deceasedDate: string) => ({
  admissionId: "adm-1",
  hospiceAdmissionDate: "2026-09-01",
  dischargeDate: deceasedDate,
  dischargeReason: "death",
  deceasedDate,
  placeOfDeath: "home",
  transferOut: null,
});

const CLAIM = {
  orgId: "org-1",
  providerEntityId: "pe-1",
  patientId: "pat-1",
  serviceFrom: "2026-10-01",
  serviceTo: "2026-10-31",
};

/** Facts for a death on `deceasedDate` (FY2027 starts 2026-10-01) with one payable 60-minute RN visit that day. */
function facts(deceasedDate: string, over: Record<string, unknown> = {}) {
  return {
    admission: deathAdmission(deceasedDate),
    mdmResolution: { placeOfService: "home" },
    resolvedPeriods: [],
    resolvedLoc: RHC_PERIODS,
    billableEncounters: [rnVisit("rn-1", deceasedDate, 60)],
    fiscalYearStarting: 2026,
    fiscalYearPricing: new Map([[2026, { wageIndexFactorDecimal: "1.0000" }]]),
    rateScope: { orgId: "org-1", providerEntityId: "pe-1", serviceFrom: "2026-10-01" },
    pe: { ccn: "123456" },
    valueAreas: undefined,
    ...over,
  } as never;
}

type RateRead = (
  fiscalYear: number,
  wageIndex: string,
  scope: { serviceFrom: string },
) => Promise<number>;

function seams(chcHourlyRateCents: RateRead, providerIndex = true) {
  return {
    billableEncounters: { forRange: async () => [] },
    levelOfCare: { periodsInRange: async () => RHC_PERIODS },
    referenceData: {
      chcHourlyRateCents,
      wageIndexForCcn: async () =>
        providerIndex ? { factorDecimal: "1.0000", cbsaCode: null } : null,
    },
  } as never;
}

const typed422 = (code: string) => ({ code, statusCode: 422 });
const FY2026_CLAIM_DEATH_IN_FY2027 = {
  claim: { ...CLAIM, serviceFrom: "2026-09-25", serviceTo: "2026-10-05" },
  facts: () =>
    facts("2026-10-03", {
      fiscalYearStarting: 2025,
      fiscalYearPricing: new Map([[2025, { wageIndexFactorDecimal: "1.0000" }]]),
      rateScope: { orgId: "org-1", providerEntityId: "pe-1", serviceFrom: "2026-09-25" },
    }),
};

describe("a payable SIA add-on fails closed when its rate is missing or unusable", () => {
  it("prices a payable add-on from the resolved hourly rate (the control case: one hour is one hourly rate)", async () => {
    const sia = await computeClaimSia(
      seams(async () => 7_192),
      facts("2026-10-10"),
      CLAIM,
    );
    expect(sia?.result.paidUnits).toBe(4);
    expect(sia?.result.siaAddOnCents).toBe(7_192);
    expect(sia?.pricing?.chcHourlyRateCents).toBe(7_192);
  });

  it.each([
    ["RATE_TABLE_MISSING", "no hospice rate table covers the date priced"],
    ["RATE_TABLE_LABOR_SHARE_MISSING", "the rate version carries no labor shares"],
  ])("refuses with the typed 422 %s and prices nothing (%s)", async (code, message) => {
    const missing = async (): Promise<number> => {
      throw new ChartWardenError(code, message, 422);
    };
    await expect(computeClaimSia(seams(missing), facts("2026-10-10"), CLAIM)).rejects.toMatchObject(
      typed422(code),
    );
  });

  it.each([
    ["zero (a zero wage-adjusted rate would price the add-on at $0)", 0],
    ["negative", -7_192],
    ["not a number", Number.NaN],
    ["not whole cents", 71.92],
  ])("refuses a resolved rate that is %s, with CHC_HOURLY_RATE_INVALID", async (_label, rate) => {
    await expect(
      computeClaimSia(
        seams(async () => rate),
        facts("2026-10-10"),
        CLAIM,
      ),
    ).rejects.toMatchObject(typed422("CHC_HOURLY_RATE_INVALID"));
  });

  it("refuses when the death year's provider wage index is missing, and does not fall back to the claim's first year", async () => {
    // The claim starts in FY2026 (Sep 30 and before); the death is on Oct 3 2026 (FY2027), a year the claim's own
    // facts hold no index for, and the provider index for FY2027 is absent.
    const rateReads: unknown[] = [];
    await expect(
      computeClaimSia(
        seams(async (...args) => {
          rateReads.push(args);
          return 7_192;
        }, false),
        FY2026_CLAIM_DEATH_IN_FY2027.facts(),
        FY2026_CLAIM_DEATH_IN_FY2027.claim,
      ),
    ).rejects.toMatchObject(typed422("WAGE_INDEX_UNAVAILABLE"));
    expect(rateReads).toEqual([]); // no rate was read with the wrong year's index
  });

  it("reads the rate table version effective on the day of the death when the death year differs from the claim's first year", async () => {
    const reads: [number, string][] = [];
    const sia = await computeClaimSia(
      seams(async (fiscalYear, _wageIndex, scope) => {
        reads.push([fiscalYear, scope.serviceFrom]);
        return 7_000;
      }),
      FY2026_CLAIM_DEATH_IN_FY2027.facts(),
      FY2026_CLAIM_DEATH_IN_FY2027.claim,
    );
    expect(reads).toEqual([[2026, "2026-10-03"]]);
    expect(sia?.pricing?.fiscalYear).toBe(2026);
  });

  it("reads the rate for the claim's first day when the death falls in the same fiscal year as it", async () => {
    const reads: [number, string][] = [];
    await computeClaimSia(
      seams(async (fiscalYear, _wageIndex, scope) => {
        reads.push([fiscalYear, scope.serviceFrom]);
        return 7_000;
      }),
      facts("2026-10-10"),
      CLAIM,
    );
    expect(reads).toEqual([[2026, "2026-10-01"]]);
  });
});

describe("the advisory for the prior month's claim stays unknown, never zero, and never blocks", () => {
  // Claim Oct 1-31, death Oct 3, no payable visit in October: only a Sep 30 RN visit (on the prior claim) earns units.
  const priorOnly = (chc: RateRead) =>
    ({
      billableEncounters: { forRange: async () => [rnVisit("rn-sep", "2026-09-30", 60)] },
      levelOfCare: { periodsInRange: async () => RHC_PERIODS },
      referenceData: {
        chcHourlyRateCents: chc,
        wageIndexForCcn: async () => ({ factorDecimal: "1.0000", cbsaCode: null }),
      },
    }) as never;
  const factsNoOctoberVisit = () => facts("2026-10-03", { billableEncounters: [] });

  it.each([
    ["RATE_TABLE_MISSING"],
    ["RATE_TABLE_LABOR_SHARE_MISSING"],
    ["CHC_HOURLY_RATE_INVALID"],
  ])("a %s on the prior-month rate leaves the advisory unpriced (null)", async (code) => {
    const sia = await computeClaimSia(
      priorOnly(async () => {
        throw new ChartWardenError(code, "unavailable", 422);
      }),
      factsNoOctoberVisit(),
      CLAIM,
    );
    expect(sia?.result.present).toBe(false);
    expect(sia?.pricing).toBeNull();
    expect(sia?.priorClaimAdvisory).toMatchObject({ units: 4, cents: null });
  });

  it("a zero rate is refused as invalid, so the advisory is null and not a fabricated $0", async () => {
    const sia = await computeClaimSia(
      priorOnly(async () => 0),
      factsNoOctoberVisit(),
      CLAIM,
    );
    expect(sia?.priorClaimAdvisory?.cents).toBeNull();
  });

  it("an unexpected error (not a typed refusal) is never swallowed into an unknown advisory", async () => {
    await expect(
      computeClaimSia(
        priorOnly(async () => {
          throw new TypeError("a bug, not a missing rate");
        }),
        factsNoOctoberVisit(),
        CLAIM,
      ),
    ).rejects.toThrow(TypeError);
  });

  it("with the rate present the advisory is exact: 4 units at 7192 is 7192", async () => {
    const sia = await computeClaimSia(
      priorOnly(async () => 7_192),
      factsNoOctoberVisit(),
      CLAIM,
    );
    expect(sia?.priorClaimAdvisory).toEqual({
      from: "2026-09-27",
      to: "2026-09-30",
      units: 4,
      cents: 7_192,
    });
  });
});
