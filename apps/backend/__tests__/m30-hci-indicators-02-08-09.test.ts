// apps/backend/__tests__/m30-hci-indicators-02-08-09.test.ts — F-042: the three HCI indicators whose
// population is DAYS and SEQUENCES rather than events, plus the composite that reads the ten back.
//
// These are the only HCI indicators that need both modules at once: M6 owns which days a patient was on
// service and at what level of care, M8 owns which of those days a nurse visited and for how long. The
// intersection is M30's, and it is what these tests pin — the seams are fakes here; the live suite
// (`m30-hci-indicator-inputs.live.test.ts`) proves the two Drizzle readers produce the shapes assumed.
import {
  HCI_SKILLED_NURSING_GAP_DAYS,
  computeHciIndicator02,
  computeHciIndicator08,
  computeHciIndicator09,
  computeHciScore,
  isDataUnavailable,
} from "@chartwarden/quality";
import { describe, expect, it } from "vitest";
import {
  resolveHciCompositeInput,
  resolveHciIndicator02Input,
  resolveHciSkilledNursingDayInput,
  resolveHciUnavailableIndicatorInput,
} from "../src/modules/30-quality/jobs/m30-jobs";

const REQUEST = (code: string, periodStart = "2026-01-01", periodEnd = "2026-01-15") => ({
  registration: { code } as never,
  organizationId: "org-1",
  providerEntityId: "pe-1",
  periodStart,
  periodEnd,
});

/** A fake M6 span reader + M8 day-total reader (only the two methods these resolvers call). */
function seamsOf(args: {
  readonly locSpans?: readonly {
    admissionId: string;
    levelOfCare: string;
    from: string;
    to: string;
  }[];
  readonly epSpans?: readonly {
    admissionId: string;
    electionPeriodId: string;
    from: string;
    to: string;
  }[];
  readonly days?: readonly {
    admissionId: string;
    serviceDate: string;
    visits: number;
    minutes: number;
  }[];
}) {
  return {
    levelOfCarePeriodReader: {
      async levelOfCareDaySpans() {
        return args.locSpans ?? [];
      },
      async electionPeriodSpans() {
        return args.epSpans ?? [];
      },
    },
    encounters: {
      async skilledNursingDayTotalsForOrg() {
        return args.days ?? [];
      },
    },
  } as never;
}

describe("HCI indicator 8 — mean skilled-nursing minutes per routine-home-care day (CMS)", () => {
  it("divides the SN minutes on RHC days by the RHC days", async () => {
    const input = await resolveHciSkilledNursingDayInput(
      REQUEST("hci_indicator_08", "2026-01-01", "2026-01-11"),
      seamsOf({
        // Ten RHC days: 2026-01-01 .. 2026-01-10 inclusive (half-open to the 11th).
        locSpans: [
          {
            admissionId: "a1",
            levelOfCare: "routine_home_care",
            from: "2026-01-01",
            to: "2026-01-11",
          },
        ],
        days: [
          { admissionId: "a1", serviceDate: "2026-01-02", visits: 1, minutes: 45 },
          { admissionId: "a1", serviceDate: "2026-01-05", visits: 1, minutes: 30 },
          // A short visit is still minutes — there is no per-day floor in the CMS definition.
          { admissionId: "a1", serviceDate: "2026-01-07", visits: 1, minutes: 5 },
        ],
      }),
    );
    expect(input).toMatchObject({ totalRhcDays: 10, skilledNursingMinutesOnRhcDays: 80 });
    const r = computeHciIndicator08(input as never);
    expect(r.numerator).toBe(80);
    expect(r.denominator).toBe(10);
    expect(r.computationSnapshot.meanSkilledNursingMinutesPerRhcDay).toBeCloseTo(8);
    // 8 min/RHC day is under the 15-minute cut.
    expect(r.thresholdMet).toBe(false);
  });

  it("excludes days — and minutes — at any level of care OTHER than routine home care", async () => {
    const input = await resolveHciSkilledNursingDayInput(
      REQUEST("hci_indicator_08", "2026-01-01", "2026-01-11"),
      seamsOf({
        locSpans: [
          {
            admissionId: "a1",
            levelOfCare: "routine_home_care",
            from: "2026-01-01",
            to: "2026-01-06",
          },
          // The five days at GIP are not routine-home-care days and must not enlarge the denominator.
          {
            admissionId: "a1",
            levelOfCare: "general_inpatient_care",
            from: "2026-01-06",
            to: "2026-01-11",
          },
        ],
        days: [
          { admissionId: "a1", serviceDate: "2026-01-02", visits: 1, minutes: 60 },
          { admissionId: "a1", serviceDate: "2026-01-08", visits: 1, minutes: 240 },
        ],
      }),
    );
    expect(input).toMatchObject({ totalRhcDays: 5, skilledNursingMinutesOnRhcDays: 60 });
  });

  it("an org with no level-of-care spans SUPPRESSES rather than scoring 0", async () => {
    const input = await resolveHciSkilledNursingDayInput(REQUEST("hci_indicator_08"), seamsOf({}));
    const r = computeHciIndicator08(input as never);
    expect(r.denominator).toBe(0);
    expect(r.rate).toBeNull();
    expect(r.bandColor).toBe("insufficient_n");
  });
});

describe("HCI indicator 9 — share of skilled-nursing minutes on weekends (CMS)", () => {
  it("divides the Saturday/Sunday SN minutes on RHC days by all SN minutes on RHC days", async () => {
    // 2026-01-01 is a Thursday; 01-03/01-04 and 01-10/01-11 are the weekends in this window.
    const input = await resolveHciSkilledNursingDayInput(
      REQUEST("hci_indicator_09", "2026-01-01", "2026-01-12"),
      seamsOf({
        locSpans: [
          {
            admissionId: "a1",
            levelOfCare: "routine_home_care",
            from: "2026-01-01",
            to: "2026-01-06",
          },
          // Minutes on a non-RHC weekend are outside the CMS population (numerator AND denominator).
          {
            admissionId: "a1",
            levelOfCare: "general_inpatient_care",
            from: "2026-01-06",
            to: "2026-01-12",
          },
        ],
        days: [
          { admissionId: "a1", serviceDate: "2026-01-03", visits: 1, minutes: 60 },
          { admissionId: "a1", serviceDate: "2026-01-02", visits: 1, minutes: 180 },
          { admissionId: "a1", serviceDate: "2026-01-11", visits: 1, minutes: 60 },
        ],
      }),
    );
    expect(input).toMatchObject({
      totalSkilledNursingMinutes: 240,
      weekendSkilledNursingMinutes: 60,
    });
    const r = computeHciIndicator09(input as never);
    expect(r.rate).toBeCloseTo(0.25);
    expect(r.thresholdMet).toBe(true);
  });

  it("shares one pair of reads with indicator 8 but reduces them differently", async () => {
    const seams = seamsOf({
      locSpans: [
        {
          admissionId: "a1",
          levelOfCare: "routine_home_care",
          from: "2026-01-01",
          to: "2026-01-12",
        },
      ],
      days: [
        { admissionId: "a1", serviceDate: "2026-01-03", visits: 1, minutes: 60 },
        { admissionId: "a1", serviceDate: "2026-01-05", visits: 1, minutes: 30 },
      ],
    });
    const eight = await resolveHciSkilledNursingDayInput(
      REQUEST("hci_indicator_08", "2026-01-01", "2026-01-12"),
      seams,
    );
    const nine = await resolveHciSkilledNursingDayInput(
      REQUEST("hci_indicator_09", "2026-01-01", "2026-01-12"),
      seams,
    );
    expect(eight).toMatchObject({ totalRhcDays: 11, skilledNursingMinutesOnRhcDays: 90 });
    expect(nine).toMatchObject({
      totalSkilledNursingMinutes: 90,
      weekendSkilledNursingMinutes: 60,
    });
  });

  it("no skilled-nursing minutes on RHC days SUPPRESSES rather than scoring 0%", async () => {
    const input = await resolveHciSkilledNursingDayInput(
      REQUEST("hci_indicator_09", "2026-01-01", "2026-01-12"),
      seamsOf({
        locSpans: [
          {
            admissionId: "a1",
            levelOfCare: "routine_home_care",
            from: "2026-01-01",
            to: "2026-01-12",
          },
        ],
      }),
    );
    const r = computeHciIndicator09(input as never);
    expect(r.rate).toBeNull();
    expect(r.bandColor).toBe("insufficient_n");
  });
});

describe("HCI indicator 2 — gaps in skilled-nursing visits", () => {
  const span = (from: string, to: string) => ({
    admissionId: "a1",
    electionPeriodId: "ep1",
    from,
    to,
  });
  const visit = (serviceDate: string) => ({
    admissionId: "a1",
    serviceDate,
    visits: 1,
    minutes: 30,
  });

  it("counts an election with a between-visit interval longer than the gap constant", async () => {
    const input = await resolveHciIndicator02Input(
      REQUEST("hci_indicator_02", "2026-01-01", "2026-02-01"),
      seamsOf({
        epSpans: [span("2026-01-01", "2026-02-01")],
        // 01-02 → 01-12 is a 10-day interval, beyond the 7-day constant.
        days: [visit("2026-01-02"), visit("2026-01-12")],
      }),
    );
    expect(HCI_SKILLED_NURSING_GAP_DAYS).toBe(7);
    expect(input).toMatchObject({ totalElectionPeriods: 1, periodsWithSkilledNursingGap: 1 });
  });

  it("does not count an election visited inside the interval throughout", async () => {
    const input = await resolveHciIndicator02Input(
      REQUEST("hci_indicator_02", "2026-01-01", "2026-02-01"),
      seamsOf({
        epSpans: [span("2026-01-01", "2026-02-01")],
        days: [
          visit("2026-01-02"),
          visit("2026-01-08"),
          visit("2026-01-14"),
          visit("2026-01-20"),
          visit("2026-01-26"),
        ],
      }),
    );
    expect(input).toMatchObject({ totalElectionPeriods: 1, periodsWithSkilledNursingGap: 0 });
  });

  it("counts the LEADING interval — election start to the first visit", async () => {
    const input = await resolveHciIndicator02Input(
      REQUEST("hci_indicator_02", "2026-01-01", "2026-02-01"),
      seamsOf({
        epSpans: [span("2026-01-01", "2026-02-01")],
        // First nurse visit nine days after the election started.
        days: [visit("2026-01-10"), visit("2026-01-15"), visit("2026-01-21"), visit("2026-01-27")],
      }),
    );
    expect(input).toMatchObject({ periodsWithSkilledNursingGap: 1 });
  });

  it("does NOT count the TRAILING interval — it is open, not a completed gap", async () => {
    const input = await resolveHciIndicator02Input(
      REQUEST("hci_indicator_02", "2026-01-01", "2026-02-01"),
      seamsOf({
        epSpans: [span("2026-01-01", "2026-02-01")],
        // Visited on schedule until the 8th, then the window ends — the next visit may be after it.
        days: [visit("2026-01-02"), visit("2026-01-08")],
      }),
    );
    expect(input).toMatchObject({ periodsWithSkilledNursingGap: 0 });
  });

  it("an election with no skilled-nursing visit at all is a gap when it is long enough", async () => {
    const long = await resolveHciIndicator02Input(
      REQUEST("hci_indicator_02", "2026-01-01", "2026-02-01"),
      seamsOf({ epSpans: [span("2026-01-01", "2026-02-01")] }),
    );
    expect(long).toMatchObject({ periodsWithSkilledNursingGap: 1 });

    // ...but a span shorter than the interval cannot have exceeded it, even with no visits — a period
    // clipped to three days at the edge of the reporting window has not yet failed anything.
    const short = await resolveHciIndicator02Input(
      REQUEST("hci_indicator_02", "2026-01-01", "2026-02-01"),
      seamsOf({ epSpans: [span("2026-01-29", "2026-02-01")] }),
    );
    expect(short).toMatchObject({ totalElectionPeriods: 1, periodsWithSkilledNursingGap: 0 });
  });

  it("attributes visits to the right admission", async () => {
    const input = await resolveHciIndicator02Input(
      REQUEST("hci_indicator_02", "2026-01-01", "2026-02-01"),
      seamsOf({
        epSpans: [
          { admissionId: "a1", electionPeriodId: "ep1", from: "2026-01-01", to: "2026-02-01" },
          { admissionId: "a2", electionPeriodId: "ep2", from: "2026-01-01", to: "2026-02-01" },
        ],
        // Every visit belongs to a1; a2 was never visited and must not borrow a1's cadence.
        days: [
          { admissionId: "a1", serviceDate: "2026-01-02", visits: 1, minutes: 30 },
          { admissionId: "a1", serviceDate: "2026-01-08", visits: 1, minutes: 30 },
          { admissionId: "a1", serviceDate: "2026-01-14", visits: 1, minutes: 30 },
          { admissionId: "a1", serviceDate: "2026-01-20", visits: 1, minutes: 30 },
          { admissionId: "a1", serviceDate: "2026-01-26", visits: 1, minutes: 30 },
        ],
      }),
    );
    expect(input).toMatchObject({ totalElectionPeriods: 2, periodsWithSkilledNursingGap: 1 });
  });

  it("counts a visit regardless of its recorded duration", async () => {
    // Indicator 2 asks WHETHER a nurse came; a missing start/end bracket is a documentation gap, not a
    // care gap, and must not manufacture one.
    const input = await resolveHciIndicator02Input(
      REQUEST("hci_indicator_02", "2026-01-01", "2026-01-20"),
      seamsOf({
        epSpans: [span("2026-01-01", "2026-01-20")],
        days: [
          { admissionId: "a1", serviceDate: "2026-01-02", visits: 1, minutes: 0 },
          { admissionId: "a1", serviceDate: "2026-01-08", visits: 1, minutes: 0 },
          { admissionId: "a1", serviceDate: "2026-01-14", visits: 1, minutes: 0 },
        ],
      }),
    );
    expect(input).toMatchObject({ periodsWithSkilledNursingGap: 0 });
  });
});

describe("the three claims-file indicators resolve a DECLARED absence, not a throw", () => {
  it.each(["hci_indicator_05", "hci_indicator_06", "hci_indicator_07"])(
    "%s shapes an input carrying its reason",
    (code) => {
      const input = resolveHciUnavailableIndicatorInput(REQUEST(code)) as {
        unavailable: { reason: string; requires: string };
      };
      expect(input.unavailable.reason.length).toBeGreaterThan(40);
      expect(input.unavailable.requires.length).toBeGreaterThan(20);
    },
  );

  it("refuses loudly for a code it was routed but does not declare", () => {
    expect(() => resolveHciUnavailableIndicatorInput(REQUEST("hci_indicator_08"))).toThrow(
      /HCI_UNAVAILABLE_INDICATORS does not declare it/,
    );
  });
});

describe("the HCI composite reads its ten inputs off the value ledger", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    numerator: 1,
    denominator: 1,
    ratio: "1.0000",
    thresholdMet: true,
    computationSnapshot: {},
    ...over,
  });

  /** A fake `QualityMeasureValueRepository` answering `findCurrent` from a per-code map. */
  const valuesOf = (byCode: Record<string, unknown>) =>
    ({
      async findCurrent(measureCode: string) {
        return byCode[measureCode] ?? null;
      },
    }) as never;

  const ALL_CODES = Array.from(
    { length: 10 },
    (_, i) => `hci_indicator_${String(i + 1).padStart(2, "0")}`,
  );

  it("scores when all ten current rows exist and none is un-computable", async () => {
    const byCode = Object.fromEntries(ALL_CODES.map((c) => [c, row()]));
    const input = await resolveHciCompositeInput(REQUEST("hci_composite"), {
      values: valuesOf(byCode),
    });
    const r = computeHciScore(input as never);
    expect(r.numerator).toBe(10);
    expect(r.bandColor).toBe("green");
  });

  it("suppresses when an indicator has no current row yet", async () => {
    const byCode = Object.fromEntries(ALL_CODES.slice(0, 9).map((c) => [c, row()]));
    const input = await resolveHciCompositeInput(REQUEST("hci_composite"), {
      values: valuesOf(byCode),
    });
    const r = computeHciScore(input as never);
    expect(isDataUnavailable(r)).toBe(true);
    expect(r.computationSnapshot.notYetComputedIndicators).toEqual(["indicator_10"]);
  });

  it("carries the unavailable MARKER through the persisted snapshot, not just the in-memory result", async () => {
    // This is the round trip that matters: the composite runs as its own job, long after the indicator
    // that suppressed. Its only evidence is the `computation_snapshot` column.
    const byCode = Object.fromEntries(ALL_CODES.map((c) => [c, row()]));
    byCode.hci_indicator_05 = row({
      denominator: 0,
      ratio: null,
      thresholdMet: null,
      computationSnapshot: { dataUnavailable: true, unavailableReason: "no claims feed" },
    });
    const input = await resolveHciCompositeInput(REQUEST("hci_composite"), {
      values: valuesOf(byCode),
    });
    const r = computeHciScore(input as never);
    expect(isDataUnavailable(r)).toBe(true);
    expect(r.computationSnapshot.unavailableIndicators).toEqual(["indicator_05"]);
  });

  it("does not mistake a LOW-N row for an un-computable one", async () => {
    const byCode = Object.fromEntries(ALL_CODES.map((c) => [c, row()]));
    byCode.hci_indicator_02 = row({ denominator: 0, ratio: null, thresholdMet: null });
    const input = await resolveHciCompositeInput(REQUEST("hci_composite"), {
      values: valuesOf(byCode),
    });
    const r = computeHciScore(input as never);
    expect(isDataUnavailable(r)).toBe(false);
    expect(r.numerator).toBe(9);
  });
});

describe("indicator 2's calculator consumes the resolver's shape", () => {
  it("round-trips through computeHciIndicator02", async () => {
    const input = await resolveHciIndicator02Input(
      REQUEST("hci_indicator_02", "2026-01-01", "2026-02-01"),
      seamsOf({
        epSpans: [
          { admissionId: "a1", electionPeriodId: "ep1", from: "2026-01-01", to: "2026-02-01" },
          { admissionId: "a2", electionPeriodId: "ep2", from: "2026-01-01", to: "2026-02-01" },
        ],
      }),
    );
    const r = computeHciIndicator02(input as never);
    expect(r.denominator).toBe(2);
    expect(r.numerator).toBe(2);
    expect(r.rate).toBe(1);
    // Lower-is-better: a 100% gap rate must NOT read as meeting the threshold.
    expect(r.thresholdMet).toBe(false);
  });
});
