// CW-PI-06 — Medicaid hospice pricing against effective-dated rate rows, swept rather than sampled. The rows, payers,
// localities, evidence and dollar figures are all invented. Nothing here is a payer's real rate: no EOCCO or OHA amount
// is loaded or verified (see docs/runbooks/m24-medicaid-rate-validation.md for what is needed before one can be).
//
// What is pinned, each against an expectation written here (a date predicate, a BigInt ratio), never taken from the code:
//   - a service day is priced only when exactly one rate row covers it and that row is verified; no row is a gap (never a
//     fabricated or carried-forward rate), two rows are ambiguous, a pending, expired or rejected row never prices;
//   - first and last effective days are inclusive, an adjacent change flips on the exact day, a one-day overlap is
//     ambiguous, a one-day gap is a gap, and a correction never revives the rate it replaced outside its own window;
//   - a service window is split into contiguous segments that agree with the single-day answers;
//   - the assessment instant is explicit: evidence verified at or before it is visible, one millisecond later is not;
//   - a claim-wide total exists only when every day is resolved, and is the exact sum of the day amounts (integer cents);
//   - hourly amounts equal the exact ratio under each configured rounding mode, and "exact only" refuses a fraction;
//   - a rate that is zero, negative or not a whole number of cents never prices a day;
//   - electronic submission is never available (every result carries submissionAvailable: false).
import { describe, expect, it } from "vitest";
import { assessHospicePricing } from "../src/hospice-pricing";
import {
  type PayerRatePolicyFact,
  type PayerRatePolicyLookup,
  resolvePayerRatePolicy,
  resolvePayerRatePolicySegments,
} from "../src/payer-rate-policy";

const ASSESSED_AT = "2026-03-01T12:00:00.000Z";
const payerContext = {
  organizationId: "synthetic-org",
  providerEntityId: "synthetic-provider",
  canonicalPayerId: "synthetic-payer",
  programKind: "managed_care" as const,
  serviceState: "OR",
  assessedAt: ASSESSED_AT,
  qualityReporting: {
    applicability: "required" as const,
    providerStatus: "meets" as const,
    evidenceReference: "evidence:synthetic-quality",
    evidenceVersion: 1,
    verifiedAt: "2026-02-01T00:00:00.000Z",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
  },
};

const lookupFor = (serviceFrom: string, serviceTo: string): PayerRatePolicyLookup => ({
  organizationId: "synthetic-org",
  providerEntityId: "synthetic-provider",
  canonicalPayerId: "synthetic-payer",
  programKind: "managed_care",
  serviceState: "OR",
  localityCode: "SYNTHETIC-LOCALITY",
  serviceCategory: "RHC",
  unitBasis: "per_day",
  electionDayNumber: null,
  serviceFrom,
  serviceTo,
  assessedAt: ASSESSED_AT,
  qualityReporting: payerContext.qualityReporting,
});

const rate = (
  id: string,
  rateCents: number,
  effectiveFrom: string,
  effectiveTo: string | null,
  extra: Partial<PayerRatePolicyFact> = {},
): PayerRatePolicyFact => ({
  id,
  organizationId: "synthetic-org",
  providerEntityId: "synthetic-provider",
  canonicalPayerId: "synthetic-payer",
  programKind: "managed_care",
  serviceState: "OR",
  localityCode: "SYNTHETIC-LOCALITY",
  serviceCategory: "RHC",
  unitBasis: "per_day",
  bucketFrom: null,
  bucketTo: null,
  rateCents,
  chargeCeilingCents: null,
  pricingMethod: "per_day",
  quantityConversionMethod: "daily_units",
  minimumDurationMethod: "not_applicable",
  minimumClinicalMinutes: null,
  methodologyVersion: 1,
  roundingMode: "not_applicable",
  roundingBoundary: "not_applicable",
  chargeCeilingMethod: "none",
  chargeCeilingBoundary: "not_applicable",
  qualityReportingApplicability: "required",
  qualityReportingStatus: "meets",
  sourceKind: "cco_contract",
  verificationStatus: "verified",
  effectiveFrom,
  effectiveTo,
  sourceDocumentRef: `doc:${id}`,
  verifiedAt: "2026-02-01T00:00:00.000Z",
  verifiedByMembershipId: "synthetic-reviewer",
  recordedByMembershipId: "synthetic-recorder",
  createdAt: "2026-02-01T00:00:00.000Z",
  supersedesId: null,
  version: 1,
  ...extra,
});

const DAY_MS = 86_400_000;
const isoOf = (epochDay: number): string => new Date(epochDay * DAY_MS).toISOString().slice(0, 10);
const epochDayOf = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;
const FIRST_DAY = epochDayOf("2026-01-01");
const LAST_DAY = epochDayOf("2027-01-31");
const eachDay = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => isoOf(from + i));

type DayOutcome =
  | { status: "qualified"; id: string }
  | { status: "missing"; reasonCode: "RATE_EFFECTIVE_PERIOD_GAP" }
  | { status: "ambiguous"; reasonCode: "MEDICAID_RATE_POLICY_AMBIGUOUS" }
  | { status: "unverified"; reasonCode: "RATE_SOURCE_UNVERIFIED" };

const qualified = (id: string): DayOutcome => ({ status: "qualified", id });
const GAP: DayOutcome = { status: "missing", reasonCode: "RATE_EFFECTIVE_PERIOD_GAP" };
const AMBIGUOUS: DayOutcome = { status: "ambiguous", reasonCode: "MEDICAID_RATE_POLICY_AMBIGUOUS" };
const UNVERIFIED: DayOutcome = { status: "unverified", reasonCode: "RATE_SOURCE_UNVERIFIED" };

interface Scenario {
  readonly name: string;
  readonly rates: readonly PayerRatePolicyFact[];
  /** What a single service day must resolve to, from the date alone. */
  readonly expected: (day: string) => DayOutcome;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "one open-ended row from 1 March",
    rates: [rate("A", 100, "2026-03-01", null)],
    expected: (d) => (d < "2026-03-01" ? GAP : qualified("A")),
  },
  {
    name: "a closed row (first and last day inclusive), then nothing",
    rates: [rate("A", 100, "2026-03-01", "2026-06-30")],
    expected: (d) => (d >= "2026-03-01" && d <= "2026-06-30" ? qualified("A") : GAP),
  },
  {
    name: "two adjacent rows: the change flips on 1 July, never earlier or later",
    rates: [rate("A", 100, "2026-03-01", "2026-06-30"), rate("B", 150, "2026-07-01", null)],
    expected: (d) => (d < "2026-03-01" ? GAP : d <= "2026-06-30" ? qualified("A") : qualified("B")),
  },
  {
    name: "two rows that overlap on one day: that day is ambiguous",
    rates: [rate("A", 100, "2026-03-01", "2026-06-30"), rate("B", 150, "2026-06-30", null)],
    expected: (d) =>
      d < "2026-03-01"
        ? GAP
        : d < "2026-06-30"
          ? qualified("A")
          : d === "2026-06-30"
            ? AMBIGUOUS
            : qualified("B"),
  },
  {
    name: "two rows with a one-day gap between them: the gap day is a gap, not either rate",
    rates: [rate("A", 100, "2026-03-01", "2026-06-29"), rate("B", 150, "2026-07-01", null)],
    expected: (d) =>
      d < "2026-03-01"
        ? GAP
        : d <= "2026-06-29"
          ? qualified("A")
          : d === "2026-06-30"
            ? GAP
            : qualified("B"),
  },
  {
    name: "a verified row and a pending row covering the same April days: those days are ambiguous",
    rates: [
      rate("A", 100, "2026-03-01", null),
      rate("P", 999, "2026-04-01", "2026-04-30", {
        verificationStatus: "pending",
        verifiedAt: null,
        verifiedByMembershipId: null,
      }),
    ],
    expected: (d) =>
      d < "2026-03-01" ? GAP : d >= "2026-04-01" && d <= "2026-04-30" ? AMBIGUOUS : qualified("A"),
  },
  {
    name: "a rejected draft over April never prices and does not hide the verified row under it",
    rates: [
      rate("A", 100, "2026-03-01", null),
      rate("R", 999, "2026-04-01", "2026-04-30", { verificationStatus: "rejected" }),
    ],
    expected: (d) => (d < "2026-03-01" ? GAP : qualified("A")),
  },
  {
    name: "an expired row alone: its days are unverified, every other day a gap, and it never prices",
    rates: [rate("E", 100, "2026-03-01", "2026-03-31", { verificationStatus: "expired" })],
    expected: (d) => (d >= "2026-03-01" && d <= "2026-03-31" ? UNVERIFIED : GAP),
  },
  {
    // A correction keeps the replaced row's identity and first day (the database refuses any other shape) and here ends it
    // earlier: after its last day the old open-ended rate is not revived.
    name: "a correction ends the replaced row earlier: after its last day the old rate is not revived",
    rates: [
      rate("A", 100, "2026-03-01", null),
      rate("B", 175, "2026-03-01", "2026-04-30", { supersedesId: "A", version: 2 }),
    ],
    expected: (d) => (d >= "2026-03-01" && d <= "2026-04-30" ? qualified("B") : GAP),
  },
];

describe.each(SCENARIOS)("effective-dated resolution: $name", (scenario) => {
  it("resolves every service day from 1 Jan 2026 to 31 Jan 2027 to exactly the expected outcome", () => {
    for (const day of eachDay(FIRST_DAY, LAST_DAY)) {
      const segments = resolvePayerRatePolicySegments(lookupFor(day, day), scenario.rates);
      expect(segments, day).toHaveLength(1);
      const want = scenario.expected(day);
      const got = segments[0];
      expect(got?.status, day).toBe(want.status);
      if (want.status === "qualified") {
        expect(got?.rate?.id, day).toBe(want.id);
        expect(got?.reasonCode, day).toBeNull();
      } else {
        expect(got?.rate, day).toBeNull(); // an unresolved day never carries a rate
        expect(got?.reasonCode, day).toBe(want.reasonCode);
      }
    }
  });

  it("splits any service window into contiguous segments that agree with the single-day answers", () => {
    for (let start = FIRST_DAY; start <= LAST_DAY - 45; start += 3) {
      for (const length of [1, 2, 7, 31, 45]) {
        const from = isoOf(start);
        const to = isoOf(start + length - 1);
        const segments = resolvePayerRatePolicySegments(lookupFor(from, to), scenario.rates);

        // contiguous, ordered, covering exactly [from, to]
        expect(segments[0]?.from, `${from}..${to}`).toBe(from);
        expect(segments[segments.length - 1]?.to, `${from}..${to}`).toBe(to);
        for (let i = 1; i < segments.length; i++) {
          expect(epochDayOf(segments[i]!.from), `${from}..${to}`).toBe(
            epochDayOf(segments[i - 1]!.to) + 1,
          );
        }
        // every day sits in a segment that carries the day's expected outcome
        for (const day of eachDay(start, start + length - 1)) {
          const segment = segments.find((s) => s.from <= day && day <= s.to);
          const want = scenario.expected(day);
          expect(segment?.status, `${day} in ${from}..${to}`).toBe(want.status);
          if (want.status === "qualified") expect(segment?.rate?.id).toBe(want.id);
        }
      }
    }
  });

  // resolvePayerRatePolicy answers a whole window with one rate. It is sound (a rate only when one row covers every day, a
  // partial answer only when every segment resolves) but not complete: a rejected draft whose edge falls inside the window
  // splits it into two segments that carry the same rate, and the helper then answers "partial". It is never a wrong rate,
  // and it has no production caller: pricing resolves one service day at a time (resolvePayerRatePolicySegments over a
  // one-day window), which a draft's edge cannot split.
  it("answers a whole window with a rate only when one row covers all of it (sound, never a wrong rate)", () => {
    for (let start = FIRST_DAY; start <= LAST_DAY - 45; start += 5) {
      for (const length of [1, 7, 31, 45]) {
        const from = isoOf(start);
        const to = isoOf(start + length - 1);
        const days = eachDay(start, start + length - 1).map((d) => scenario.expected(d));
        const result = resolvePayerRatePolicy(lookupFor(from, to), scenario.rates);
        const ids = new Set(days.map((d) => (d.status === "qualified" ? d.id : null)));
        const wholeWindowOneRate = ids.size === 1 && !ids.has(null);
        if (result.status === "qualified") {
          expect(wholeWindowOneRate, `${from}..${to}`).toBe(true);
          expect(result.rate.id).toBe([...ids][0]);
        } else {
          expect(result.rate, `${from}..${to}`).toBeNull(); // never a rate for a window it does not cover
          if (result.status === "partial") {
            expect(
              days.every((d) => d.status === "qualified"),
              `${from}..${to}`,
            ).toBe(true);
          }
        }
        if (!days.every((d) => d.status === "qualified")) {
          expect(result.status, `${from}..${to}`).not.toMatch(/^(qualified|partial)$/);
        }
      }
    }
  });

  it("prices a window only when every day resolves, as the exact sum of the day rates (the pricing path)", () => {
    const cents = new Map(scenario.rates.map((r) => [r.id, r.rateCents]));
    for (let start = FIRST_DAY; start <= LAST_DAY - 31; start += 5) {
      for (const length of [1, 7, 31]) {
        const dates = eachDay(start, start + length - 1);
        const outcomes = dates.map((d) => scenario.expected(d));
        const result = assessHospicePricing({
          serviceFrom: dates[0]!,
          serviceTo: dates[length - 1]!,
          assessedAt: ASSESSED_AT,
          days: dates.map(dailyInput),
          rates: [...scenario.rates],
        });
        const label = `${dates[0]}..${dates[length - 1]}`;
        expect(result.submissionAvailable, label).toBe(false);
        if (outcomes.every((o) => o.status === "qualified")) {
          const total = outcomes.reduce((sum, o) => sum + cents.get((o as { id: string }).id)!, 0);
          expect(result.status, label).toBe("fully_resolved");
          expect(result.reimbursementEstimateTotalCents, label).toBe(total);
        } else {
          expect(result.status, label).not.toBe("fully_resolved");
          expect(result.reimbursementEstimateTotalCents, label).toBeNull(); // unknown, never zero
        }
      }
    }
  });
});

describe("the assessment instant is explicit (evidence verified later is not visible)", () => {
  const verifiedAt = "2026-03-01T12:00:00.000Z";
  const row = rate("A", 100, "2026-03-01", null, {
    verifiedAt,
    createdAt: "2026-02-01T00:00:00.000Z",
  });
  const at = (assessedAt: string) =>
    resolvePayerRatePolicy({ ...lookupFor("2026-03-10", "2026-03-10"), assessedAt }, [row]);

  it("a row verified at the instant is visible, and one millisecond earlier it is not", () => {
    expect(at("2026-03-01T12:00:00.000Z")).toMatchObject({ status: "qualified" });
    const before = at("2026-03-01T11:59:59.999Z");
    expect(before.status).not.toBe("qualified");
    expect(before.rate).toBeNull();
  });

  it("a row created at the instant is visible; one created a millisecond later is not", () => {
    const atInstant = rate("A", 100, "2026-03-01", null, { createdAt: "2026-03-01T12:00:00.000Z" });
    expect(
      resolvePayerRatePolicy(lookupFor("2026-03-10", "2026-03-10"), [atInstant]),
    ).toMatchObject({
      status: "qualified",
    });
  });

  it("a row created after the instant is not visible either", () => {
    const late = rate("A", 100, "2026-03-01", null, { createdAt: "2026-03-01T12:00:00.001Z" });
    const result = resolvePayerRatePolicy(lookupFor("2026-03-10", "2026-03-10"), [late]);
    expect(result.status).not.toBe("qualified");
    expect(result.rate).toBeNull();
  });
});

describe("a rate that is not a positive whole number of cents never prices a day", () => {
  it.each([
    ["zero", 0],
    ["negative", -100],
    ["a fraction of a cent", 100.5],
    ["not a number", Number.NaN],
    ["beyond the safe integers", Number.MAX_SAFE_INTEGER + 1],
  ])("%s", (_label, rateCents) => {
    const result = resolvePayerRatePolicy(lookupFor("2026-03-10", "2026-03-10"), [
      rate("A", rateCents, "2026-03-01", null),
    ]);
    expect(result.status).not.toBe("qualified");
    expect(result.rate).toBeNull();
  });
});

// ---- pricing: assessHospicePricing -----------------------------------------------------------------------------------

const quantityEvidence = (
  date: string,
  serviceCategory: "RHC" | "CHC" = "RHC",
  unitBasis: "per_day" | "per_hour" = "per_day",
) => ({
  serviceDate: date,
  providerEntityId: "synthetic-provider",
  serviceCategory,
  unitBasis,
  sourceReference: `evidence:synthetic-quantity-${date}`,
  version: 1,
  verifiedAt: "2026-02-20T00:00:00.000Z",
});
const dailyInput = (serviceDate: string) => ({
  serviceDate,
  serviceCategory: "RHC" as const,
  unitBasis: "per_day" as const,
  localityCode: "SYNTHETIC-LOCALITY",
  localityEvidence: {
    localityCode: "SYNTHETIC-LOCALITY",
    serviceState: "OR",
    sourceReference: "evidence:synthetic-locality",
    version: 1,
    verifiedAt: "2026-02-20T00:00:00.000Z",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
  },
  electionDayEvidence: null,
  inpatientRespiteDayEvidence: null,
  quantity: { unitBasis: "per_day" as const, units: 1 },
  quantityEvidence: quantityEvidence(serviceDate),
  providerUsualCharge: null,
  payerContext,
});

describe("a claim-wide total is the exact sum of resolved days, and exists only when every day resolves", () => {
  const PERIOD_FROM = epochDayOf("2026-03-01");
  const DAYS = 10;
  const days = eachDay(PERIOD_FROM, PERIOD_FROM + DAYS - 1);
  const assess = (rates: PayerRatePolicyFact[]) =>
    assessHospicePricing({
      serviceFrom: days[0]!,
      serviceTo: days[DAYS - 1]!,
      assessedAt: ASSESSED_AT,
      days: days.map(dailyInput),
      rates,
    });

  it("for a rate change after each of the 10 days, the total is 101 x days before + 203 x days after", () => {
    for (let before = 0; before <= DAYS; before++) {
      const changeDay = isoOf(PERIOD_FROM + before); // first day at the new rate
      const lastOld = isoOf(PERIOD_FROM + before - 1);
      const rates = [
        ...(before > 0 ? [rate("old", 101, "2026-03-01", lastOld)] : []),
        ...(before < DAYS ? [rate("new", 203, changeDay, null)] : []),
      ];
      const result = assess(rates);
      expect(result.status, `${before} days at the old rate`).toBe("fully_resolved");
      expect(result.reimbursementEstimateTotalCents, `${before}`).toBe(
        101 * before + 203 * (DAYS - before),
      );
      expect(result.segments).toHaveLength(before === 0 || before === DAYS ? 1 : 2);
      expect(result.coversRequestedPeriod).toBe(true);
      expect(result.submissionAvailable).toBe(false);
      expect([
        result.actualBilledChargeTotalCents,
        result.payerAllowedAmountCents,
        result.actualPaymentCents,
      ]).toEqual([null, null, null]);
    }
  });

  it("with a one-day gap in the rates at any day, there is no total, and the gap day is not priced", () => {
    for (let gap = 0; gap < DAYS; gap++) {
      const gapDay = days[gap]!;
      const rates = [
        ...(gap > 0 ? [rate("old", 101, "2026-03-01", isoOf(PERIOD_FROM + gap - 1))] : []),
        ...(gap < DAYS - 1 ? [rate("new", 203, isoOf(PERIOD_FROM + gap + 1), null)] : []),
      ];
      const result = assess(rates);
      expect(result.status, gapDay).not.toBe("fully_resolved");
      expect(result.reimbursementEstimateTotalCents, gapDay).toBeNull();
      const gapSegment = result.segments.find(
        (s) => s.serviceFrom <= gapDay && gapDay <= s.serviceTo,
      );
      expect(gapSegment?.reimbursementEstimateCents, gapDay).toBeNull();
      expect(gapSegment?.rateEvidence, gapDay).toBeNull();
      expect(gapSegment?.reasonCodes, gapDay).toContain("RATE_EFFECTIVE_PERIOD_GAP");
      expect(result.submissionAvailable).toBe(false);
    }
  });

  it("with two rates covering the same day there is no total (ambiguous), however the overlap falls", () => {
    for (let overlap = 0; overlap < DAYS; overlap++) {
      const rates = [
        rate("a", 101, "2026-03-01", days[overlap]!),
        rate("b", 203, days[overlap]!, null),
      ];
      const result = assess(rates);
      expect(result.reimbursementEstimateTotalCents, days[overlap]).toBeNull();
      expect(result.status).not.toBe("fully_resolved");
    }
  });

  it("every result is a local estimate: no billed charge, no payer allowed amount, no payment, no submission", () => {
    const result = assess([rate("only", 150, "2026-03-01", null)]);
    expect(result).toMatchObject({
      status: "fully_resolved",
      reimbursementEstimateTotalCents: 1_500,
      actualBilledChargeTotalCents: null,
      payerAllowedAmountCents: null,
      actualPaymentCents: null,
      submissionAvailable: false,
    });
  });
});

describe("hourly amounts equal the exact ratio under each configured rounding mode", () => {
  const MODES = ["half_up", "half_even", "floor", "ceiling", "exact_only"] as const;
  type Mode = (typeof MODES)[number];
  const hourlyRate = (rateCents: number, roundingMode: Mode) =>
    rate("hourly", rateCents, "2026-03-01", null, {
      serviceCategory: "CHC",
      unitBasis: "per_hour",
      pricingMethod: "per_hour",
      quantityConversionMethod: "hourly_prorated_minutes",
      minimumDurationMethod: "not_required",
      roundingMode,
      roundingBoundary: "service_day",
    });
  const price = (rateCents: number, minutes: number, mode: Mode) =>
    assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt: ASSESSED_AT,
      days: [
        {
          ...dailyInput("2026-03-01"),
          serviceCategory: "CHC" as const,
          unitBasis: "per_hour" as const,
          quantity: { unitBasis: "per_hour" as const, clinicalMinutes: minutes },
          quantityEvidence: quantityEvidence("2026-03-01", "CHC", "per_hour"),
        },
      ],
      rates: [hourlyRate(rateCents, mode)],
    });

  /** rate x minutes / 60 rounded as the mode says, from integers only; null when exact_only meets a fraction. */
  const oracle = (rateCents: number, minutes: number, mode: Mode): bigint | null => {
    const numerator = BigInt(rateCents) * BigInt(minutes);
    const whole = numerator / 60n;
    const remainder = numerator % 60n;
    if (remainder === 0n) return whole;
    switch (mode) {
      case "exact_only":
        return null;
      case "floor":
        return whole;
      case "ceiling":
        return whole + 1n;
      case "half_up":
        return remainder >= 30n ? whole + 1n : whole;
      case "half_even":
        if (remainder > 30n) return whole + 1n;
        if (remainder < 30n) return whole;
        return whole % 2n === 0n ? whole : whole + 1n;
    }
  };

  it("pins the exact half-cent cases named in cents", () => {
    // 90 c/h for 1 minute is 1.5 c; 150 c/h for 1 minute is 2.5 c
    const cases: [number, number, Mode, number | null][] = [
      [90, 1, "half_up", 2],
      [90, 1, "half_even", 2],
      [90, 1, "floor", 1],
      [90, 1, "ceiling", 2],
      [90, 1, "exact_only", null],
      [150, 1, "half_up", 3],
      [150, 1, "half_even", 2],
      [150, 1, "floor", 2],
      [150, 1, "ceiling", 3],
      [150, 1, "exact_only", null],
      [6_000, 90, "exact_only", 9_000], // a whole number of cents is exact under every mode
      // A computed zero is a known amount, not an unknown: a 1 c/h rate for one minute floors to 0 c and is a resolved
      // zero (pinned as today's behavior; real hourly rates are orders of magnitude above a cent, and a rate of at least
      // one cent is the only guard). Unknown quantity or rate stays null, never 0.
      [1, 1, "floor", 0],
      [1, 1, "ceiling", 1],
    ];
    for (const [rateCents, minutes, mode, cents] of cases) {
      const result = price(rateCents, minutes, mode);
      expect(result.reimbursementEstimateTotalCents, `${rateCents}c/h x ${minutes}m ${mode}`).toBe(
        cents,
      );
      expect(result.status).toBe(cents === null ? "unsupported" : "fully_resolved");
    }
  });

  it("matches the integer oracle for 5 rates x 1 to 120 minutes x 5 modes, and never guesses a fraction", () => {
    for (const rateCents of [1, 5, 90, 101, 4_321]) {
      for (let minutes = 1; minutes <= 120; minutes++) {
        for (const mode of MODES) {
          const want = oracle(rateCents, minutes, mode);
          const result = price(rateCents, minutes, mode);
          const label = `${rateCents}c/h x ${minutes}m ${mode}`;
          expect(result.submissionAvailable, label).toBe(false);
          if (want === null) {
            expect(result.reimbursementEstimateTotalCents, label).toBeNull();
            expect(result.status, label).not.toBe("fully_resolved");
          } else {
            expect(result.reimbursementEstimateTotalCents, label).toBe(Number(want));
          }
        }
      }
    }
  });
});

describe("hourly rounding over several days: once per service day, or once over the whole segment", () => {
  const MODES = ["half_up", "half_even", "floor", "ceiling"] as const;
  type Mode = (typeof MODES)[number];
  type Boundary = "service_day" | "segment";
  const row = (rateCents: number, roundingMode: Mode, roundingBoundary: Boundary) =>
    rate("hourly", rateCents, "2026-03-01", null, {
      serviceCategory: "CHC",
      unitBasis: "per_hour",
      pricingMethod: "per_hour",
      quantityConversionMethod: "hourly_prorated_minutes",
      minimumDurationMethod: "not_required",
      roundingMode,
      roundingBoundary,
    });
  const priceDays = (rateCents: number, minutes: number[], mode: Mode, boundary: Boundary) => {
    const dates = eachDay(epochDayOf("2026-03-01"), epochDayOf("2026-03-01") + minutes.length - 1);
    return assessHospicePricing({
      serviceFrom: dates[0]!,
      serviceTo: dates[dates.length - 1]!,
      assessedAt: ASSESSED_AT,
      days: dates.map((date, i) => ({
        ...dailyInput(date),
        serviceCategory: "CHC" as const,
        unitBasis: "per_hour" as const,
        quantity: { unitBasis: "per_hour" as const, clinicalMinutes: minutes[i]! },
        quantityEvidence: quantityEvidence(date, "CHC", "per_hour"),
      })),
      rates: [row(rateCents, mode, boundary)],
    });
  };
  const rounded = (numerator: bigint, mode: Mode): bigint => {
    const whole = numerator / 60n;
    const remainder = numerator % 60n;
    if (remainder === 0n) return whole;
    if (mode === "floor") return whole;
    if (mode === "ceiling") return whole + 1n;
    if (mode === "half_up") return remainder >= 30n ? whole + 1n : whole;
    if (remainder > 30n) return whole + 1n;
    if (remainder < 30n) return whole;
    return whole % 2n === 0n ? whole : whole + 1n;
  };

  it("names the difference: 90 c/h for 1 minute on 2 days, half up, is 4 c per day and 3 c per segment", () => {
    expect(priceDays(90, [1, 1], "half_up", "service_day").reimbursementEstimateTotalCents).toBe(4);
    expect(priceDays(90, [1, 1], "half_up", "segment").reimbursementEstimateTotalCents).toBe(3);
  });

  it("matches the integer oracle for 1 to 4 days of mixed minutes, 4 rates, 4 modes, both boundaries", () => {
    const patterns = [[1], [1, 1], [29, 31], [1, 59, 30], [45, 45, 45, 45], [7, 13, 17, 19]];
    for (const rateCents of [1, 90, 101, 4_321]) {
      for (const minutes of patterns) {
        for (const mode of MODES) {
          const perDay = minutes.reduce((sum, m) => sum + rounded(BigInt(rateCents * m), mode), 0n);
          const whole = rounded(BigInt(rateCents * minutes.reduce((a, b) => a + b, 0)), mode);
          const label = `${rateCents}c/h x [${minutes}] ${mode}`;
          const day = priceDays(rateCents, minutes, mode, "service_day");
          const segment = priceDays(rateCents, minutes, mode, "segment");
          expect(day.reimbursementEstimateTotalCents, `${label} per day`).toBe(Number(perDay));
          expect(segment.reimbursementEstimateTotalCents, `${label} per segment`).toBe(
            Number(whole),
          );
          expect(day.submissionAvailable && segment.submissionAvailable).toBe(false);
        }
      }
    }
  });
});

describe("each hour or part, with a minimum clinical duration", () => {
  const MINIMUM = 480;
  const hourly = rate("hourly", 100, "2026-03-01", null, {
    serviceCategory: "CHC",
    unitBasis: "per_hour",
    pricingMethod: "per_hour",
    quantityConversionMethod: "hourly_each_hour_or_part",
    minimumDurationMethod: "minimum_minutes",
    minimumClinicalMinutes: MINIMUM,
    roundingMode: "not_applicable",
    roundingBoundary: "not_applicable",
  });
  const price = (minutes: number) =>
    assessHospicePricing({
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-01",
      assessedAt: ASSESSED_AT,
      days: [
        {
          ...dailyInput("2026-03-01"),
          serviceCategory: "CHC" as const,
          unitBasis: "per_hour" as const,
          quantity: { unitBasis: "per_hour" as const, clinicalMinutes: minutes },
          quantityEvidence: quantityEvidence("2026-03-01", "CHC", "per_hour"),
        },
      ],
      rates: [hourly],
    });

  it("below the minimum nothing is priced; from the minimum every started hour is one hour of rate", () => {
    for (let minutes = 1; minutes <= 1_440; minutes++) {
      const result = price(minutes);
      if (minutes < MINIMUM) {
        expect(result.reimbursementEstimateTotalCents, `${minutes} min`).toBeNull();
        expect(result.status, `${minutes} min`).toBe("unsupported");
      } else {
        const hours = Math.ceil(minutes / 60); // each hour or part
        expect(result.reimbursementEstimateTotalCents, `${minutes} min`).toBe(100 * hours);
      }
    }
  });
});
