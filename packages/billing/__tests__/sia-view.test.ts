// M23 SIA read model: ONE `siaViewOf(row)` maps a `sia_calculation` row to the `SiaView` the claim detail publishes (read AND write
// service use it, so the two can never drift). A `units_v2` row carries the whole units snapshot; a legacy `minutes_v1` row keeps
// only its minutes summary and maps to basis 'minutes_v1' with no visits and null unit totals.
import type { SiaCalculation } from "@chartwarden/db/schema";
import { registerRouteFormats } from "@chartwarden/shared/route-kit";
import { Value } from "@sinclair/typebox/value";
import { beforeAll, describe, expect, it } from "vitest";
import { SiaView, siaViewOf } from "../src/schemas";

// TypeBox treats an unregistered string format (`date`, `date-time`, `uuid`) as a failed check; the server registers them at boot.
beforeAll(registerRouteFormats);

const ENC_A = "11111111-1111-4111-8111-111111111111";
const ENC_B = "22222222-2222-4222-8222-222222222222";
const ENC_C = "33333333-3333-4333-8333-333333333333";

const BASE_ROW: SiaCalculation = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  claimId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  patientDeceasedDate: "2026-09-30",
  windowStart: "2026-09-24",
  qualifyingVisits: [
    {
      encounterId: ENC_A,
      visitDate: "2026-09-28",
      discipline: "rn",
      durationMinutes: 75,
      units: 5,
      paidUnits: 5,
    },
  ],
  totalQualifyingMinutes: 75,
  siaAddOnCents: 6_000,
  paidUnits: 5,
  eligibleUnits: 6,
  truncatedUnits: 1,
  chcHourlyRateCents: 4_800,
  wageIndexFiscalYear: 2026,
  wageIndexFactor: "1.0412",
  policy: {
    unitTieBreak: "up",
    videoEligible: false,
    visitDating: "service_date",
    wageBasis: "chc_labor_share",
  },
  visitOutcomes: [
    {
      encounterId: ENC_A,
      serviceDate: "2026-09-28",
      discipline: "rn",
      durationMinutes: 75,
      units: 5,
      paidUnits: 5,
      counted: true,
      excluded: null,
    },
    {
      encounterId: ENC_B,
      serviceDate: "2026-09-29",
      discipline: "msw",
      durationMinutes: null,
      units: null,
      paidUnits: 0,
      counted: false,
      excluded: "no_documented_time",
    },
    {
      encounterId: ENC_C,
      serviceDate: "2026-09-29",
      discipline: "rn",
      durationMinutes: 15,
      units: 1,
      paidUnits: 0,
      counted: false,
      excluded: "over_daily_cap",
    },
  ],
  priorClaimAdvisory: null,
  basis: "units_v2",
  revision: 2,
  calculatedAt: new Date("2026-10-02T14:30:00.000Z"),
};

const LEGACY_ROW: SiaCalculation = {
  ...BASE_ROW,
  qualifyingVisits: [
    { encounterId: ENC_A, visitDate: "2026-09-28", discipline: "RN", durationMinutes: 90 },
  ],
  totalQualifyingMinutes: 90,
  siaAddOnCents: 7_200,
  paidUnits: null,
  eligibleUnits: null,
  truncatedUnits: null,
  chcHourlyRateCents: null,
  wageIndexFiscalYear: null,
  wageIndexFactor: null,
  policy: null,
  visitOutcomes: null,
  priorClaimAdvisory: null,
  basis: "minutes_v1",
  revision: 1,
};

describe("siaViewOf: a units_v2 row", () => {
  const view = siaViewOf(BASE_ROW);

  it("carries the basis, revision, window and the unit totals", () => {
    expect(view).toMatchObject({
      basis: "units_v2",
      revision: 2,
      windowStart: "2026-09-24",
      windowEnd: "2026-09-30",
      paidUnits: 5,
      eligibleUnits: 6,
      truncatedUnits: 1,
    });
  });

  it("carries the price, the CHC hourly rate and the wage index it was priced with", () => {
    expect(view).toMatchObject({
      amountCents: 6_000,
      chcHourlyRateCents: 4_800,
      wageIndexFiscalYear: 2026,
    });
    expect(view.policy).toEqual(BASE_ROW.policy);
  });

  it("lists every visit with its counted verdict and exclusion reason", () => {
    expect(view.visits).toEqual([
      {
        id: ENC_A,
        date: "2026-09-28",
        discipline: "rn",
        minutes: 75,
        timeSource: null,
        units: 5,
        paidUnits: 5,
        counted: true,
        reason: null,
      },
      {
        id: ENC_B,
        date: "2026-09-29",
        discipline: "msw",
        minutes: null,
        timeSource: null,
        units: null,
        paidUnits: 0,
        counted: false,
        reason: "no_documented_time",
      },
      {
        id: ENC_C,
        date: "2026-09-29",
        discipline: "rn",
        minutes: 15,
        timeSource: null,
        units: 1,
        paidUnits: 0,
        counted: false,
        reason: "over_daily_cap",
      },
    ]);
  });

  it("shows who supplied each visit's minutes, and null for a revision written before that was recorded", () => {
    const [counted, excluded] = siaViewOf({
      ...BASE_ROW,
      visitOutcomes: [
        { ...BASE_ROW.visitOutcomes![0]!, timeSource: "clinician" },
        BASE_ROW.visitOutcomes![1]!, // no timeSource key at all: an older revision
      ],
    }).visits;
    expect(counted?.timeSource).toBe("clinician");
    expect(excluded?.timeSource).toBeNull();
  });

  it("has no prior-claim advisory unless the row recorded one", () => {
    expect(view.priorClaimAdvisory).toBeNull();
  });

  it("passes the prior-claim advisory through when death fell in the first 7 days of a month", () => {
    const advisory = { from: "2026-09-28", to: "2026-09-30", units: 7, cents: 8_400 };
    const withAdvisory = siaViewOf({ ...BASE_ROW, priorClaimAdvisory: advisory });
    expect(withAdvisory.priorClaimAdvisory).toEqual(advisory);
  });

  it("validates against the published SiaView contract", () => {
    expect(Value.Check(SiaView, view)).toBe(true);
  });

  it("does not mutate the stored row", () => {
    const before = JSON.stringify(BASE_ROW);
    siaViewOf(BASE_ROW);
    expect(JSON.stringify(BASE_ROW)).toBe(before);
  });
});

describe("siaViewOf: a legacy minutes_v1 row", () => {
  const view = siaViewOf(LEGACY_ROW);

  it("maps to basis minutes_v1 with no visits and no unit totals", () => {
    expect(view).toMatchObject({
      basis: "minutes_v1",
      revision: 1,
      paidUnits: null,
      eligibleUnits: null,
      truncatedUnits: null,
      chcHourlyRateCents: null,
      wageIndexFiscalYear: null,
      policy: null,
      priorClaimAdvisory: null,
    });
    expect(view.visits).toEqual([]);
  });

  it("keeps the old summary: window, minutes and the stored amount", () => {
    expect(view).toMatchObject({
      windowStart: "2026-09-24",
      windowEnd: "2026-09-30",
      totalQualifyingMinutes: 90,
      amountCents: 7_200,
      calculatedAt: "2026-10-02T14:30:00.000Z",
    });
  });

  it("validates against the published SiaView contract", () => {
    expect(Value.Check(SiaView, view)).toBe(true);
  });
});
