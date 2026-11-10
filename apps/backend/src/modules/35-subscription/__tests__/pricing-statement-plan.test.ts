// Slice 2 (tenant pricing) — the PURE decisions of the monthly statement: the calendar (days live), the mode history, which months need a
// statement, which late money rides the next open one, and the figures of a row. No database and no clock: every money case is numeric.
import { describe, expect, it } from "vitest";
import {
  type ModeHistoryRow,
  firstOfNextMonthIso,
  modeChangeEffectiveOn,
  modeInForceOn,
  nextModeCreatedAt,
  pendingModeAfter,
} from "../pricing/contract-mode";
import { type Transition, lifetimeFromTransitions } from "../pricing/statement-inputs";
import {
  CENSUS_SWEEP_INTERVAL_HOURS,
  calendarMonthOf,
  daysLiveInMonth,
  expectedCensusDays,
  liveWindowsOf,
  monthsFromThrough,
} from "../pricing/statement-period";
import {
  type ContractFacts,
  type ExistingStatement,
  MIN_CENSUS_COVERAGE_PERCENT,
  buildStatementValues,
  figuresOf,
  isSparseCensus,
  planMonths,
  priorPeriodLinesFor,
} from "../pricing/statement-plan";

const d = (iso: string) => new Date(iso);
const NOV = calendarMonthOf(d("2026-11-15T00:00:00Z"));
const DEC = calendarMonthOf(d("2026-12-15T00:00:00Z"));
const live = (
  from: string,
  to: string | null = null,
  pauses: { from: string; to: string | null }[] = [],
) =>
  liveWindowsOf({
    liveFrom: d(from),
    endedAt: to ? d(to) : null,
    pauses: pauses.map((p) => ({ from: d(p.from), to: p.to ? d(p.to) : null })),
  });

describe("daysLiveInMonth: the go-live day counts, so does a cancel day (D2)", () => {
  it("go-live on the 1st is the whole month; go-live mid-month counts that day: Nov 20 is 11 of 30; the last day is 1", () => {
    expect(daysLiveInMonth(NOV, live("2026-11-01T00:00:00Z"))).toBe(30);
    expect(daysLiveInMonth(NOV, live("2026-11-20T15:30:00Z"))).toBe(11);
    expect(daysLiveInMonth(NOV, live("2026-11-30T23:59:59Z"))).toBe(1);
  });

  it("a go-live in an earlier month is every day; a go-live after the month is none", () => {
    expect(daysLiveInMonth(NOV, live("2026-10-20T00:00:00Z"))).toBe(30);
    expect(daysLiveInMonth(NOV, live("2026-12-01T00:00:00Z"))).toBe(0);
    expect(daysLiveInMonth(DEC, live("2026-12-01T00:00:00Z"))).toBe(31);
  });

  it("the month a subscription was canceled in is billed for the days used (the cancel day counts); later months are not billed", () => {
    const windows = live("2026-10-01T00:00:00Z", "2026-11-20T14:00:00Z");
    expect(daysLiveInMonth(NOV, windows)).toBe(20);
    expect(daysLiveInMonth(DEC, windows)).toBe(0);
    // canceled at exactly midnight: that day was not used
    expect(daysLiveInMonth(NOV, live("2026-10-01T00:00:00Z", "2026-11-21T00:00:00Z"))).toBe(20);
  });

  it("a pause takes its days out, keeping the days it began and ended on (the tenant used part of them)", () => {
    const paused = live("2026-10-01T00:00:00Z", null, [
      { from: "2026-11-10T09:00:00Z", to: "2026-11-15T09:00:00Z" },
    ]);
    expect(daysLiveInMonth(NOV, paused)).toBe(30 - 4); // Nov 11, 12, 13, 14 are out
    const stillPaused = live("2026-10-01T00:00:00Z", null, [
      { from: "2026-11-15T09:00:00Z", to: null },
    ]);
    expect(daysLiveInMonth(NOV, stillPaused)).toBe(15);
    expect(daysLiveInMonth(DEC, stillPaused)).toBe(0);
  });

  it("a month has 28, 29, 30 or 31 days and the count follows", () => {
    const feb = calendarMonthOf(d("2028-02-10T00:00:00Z"));
    expect(daysLiveInMonth(feb, live("2028-01-01T00:00:00Z"))).toBe(29);
    expect(daysLiveInMonth(feb, live("2028-02-29T10:00:00Z"))).toBe(1);
  });

  it("monthsFromThrough lists every month, across a year boundary", () => {
    expect(
      monthsFromThrough(d("2026-11-20T00:00:00Z"), d("2027-02-02T00:00:00Z")).map((m) => m.key),
    ).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(monthsFromThrough(d("2026-12-01T00:00:00Z"), d("2026-11-30T00:00:00Z"))).toEqual([]);
  });
});

describe("the billing service mode history (D6): a change takes effect from the 1st of the NEXT month", () => {
  const row = (
    billingServiceMode: ModeHistoryRow["billingServiceMode"],
    effectiveFrom: string,
    createdAt = "2026-10-20T00:00:00Z",
  ): ModeHistoryRow => ({
    id: `${effectiveFrom}:${createdAt}:${billingServiceMode}`,
    billingServiceMode,
    effectiveFrom,
    createdAt: d(createdAt),
  });

  it("the mode in force on a date is the latest row at or before it; the newest row wins a tie", () => {
    const history = [
      row("billing_software", "2026-10-20"),
      row("managed_billing", "2026-12-01", "2026-11-28T10:00:00Z"),
      row("none", "2026-12-01", "2026-11-29T10:00:00Z"),
    ];
    expect(modeInForceOn(history, "2026-10-19")).toBeNull();
    expect(modeInForceOn(history, "2026-11-30")).toBe("billing_software");
    expect(modeInForceOn(history, "2026-12-01")).toBe("none");
  });

  it("uses the immutable row id as the final order when database timestamps tie", () => {
    const at = "2026-11-28T10:00:00Z";
    const history = [
      { ...row("managed_billing", "2026-12-01", at), id: "00000000-0000-4000-8000-000000000001" },
      { ...row("none", "2026-12-01", at), id: "00000000-0000-4000-8000-000000000002" },
    ];
    expect(modeInForceOn(history, "2026-12-01")).toBe("none");
  });

  it("timestamps the serialized append after the history even when its request transaction started first", () => {
    const history = [row("billing_software", "2026-11-01", "2026-11-28T10:00:00.000Z")];
    expect(nextModeCreatedAt(d("2026-11-28T09:59:59.000Z"), history).toISOString()).toBe(
      "2026-11-28T10:00:00.001Z",
    );
  });

  it("a recorded change that has not taken effect is pending; once its date passes it is not", () => {
    const history = [
      row("billing_software", "2026-10-20"),
      row("managed_billing", "2026-12-01", "2026-11-28T10:00:00Z"),
    ];
    expect(pendingModeAfter(history, "2026-11-28")).toEqual({
      billingServiceMode: "managed_billing",
      effectiveOn: "2026-12-01",
    });
    expect(pendingModeAfter(history, "2026-12-01")).toBeNull();
  });

  it("a pending row that names the mode already in force withdraws the pending change (the operator changed their mind)", () => {
    const history = [
      row("billing_software", "2026-10-20"),
      row("managed_billing", "2026-12-01", "2026-11-28T10:00:00Z"),
      row("billing_software", "2026-12-01", "2026-11-28T11:00:00Z"),
    ];
    expect(pendingModeAfter(history, "2026-11-28")).toBeNull();
    expect(modeInForceOn(history, "2026-12-01")).toBe("billing_software");
  });

  it("the 1st of next month, across a year end; a live tenant (or one with a statement) waits, an onboarding tenant with none changes today", () => {
    expect(firstOfNextMonthIso(d("2026-11-28T10:00:00Z"))).toBe("2026-12-01");
    expect(firstOfNextMonthIso(d("2026-12-31T23:59:59Z"))).toBe("2027-01-01");
    const at = d("2026-11-28T10:00:00Z");
    expect(modeChangeEffectiveOn(at, { tenantIsLive: true, hasStatement: true })).toBe(
      "2026-12-01",
    );
    expect(modeChangeEffectiveOn(at, { tenantIsLive: true, hasStatement: false })).toBe(
      "2026-12-01",
    );
    expect(modeChangeEffectiveOn(at, { tenantIsLive: false, hasStatement: true })).toBe(
      "2026-12-01",
    );
    expect(modeChangeEffectiveOn(at, { tenantIsLive: false, hasStatement: false })).toBe(
      "2026-11-28",
    );
  });
});

// ── a contract's facts: prices are the demo prices of the live suite ──
const PRICING = {
  perUserPriceCents: 10_000,
  bands: [
    { minAdc: 0, monthlyFeeCents: 100_000 },
    { minAdc: 10, monthlyFeeCents: 200_000 },
    { minAdc: 17, monthlyFeeCents: 300_000 },
    { minAdc: 26, monthlyFeeCents: 400_000 },
    { minAdc: 30, monthlyFeeCents: 500_000 },
  ],
  billingSoftwareBps: 100,
  managedBillingBps: 400,
  minimumMonthlyCents: null,
};
const facts = (over: Partial<ContractFacts> & { liveFrom: Date }): ContractFacts => ({
  organizationId: "org-1",
  subscriptionId: "sub-1",
  contractId: "contract-1",
  planId: "plan-1",
  currencyCode: "USD",
  implementationFeeCents: 250_000,
  pricing: PRICING,
  modeHistory: [
    {
      id: "mode-initial",
      billingServiceMode: "billing_software",
      effectiveFrom: "2026-10-20",
      createdAt: d("2026-10-20T00:00:00Z"),
    },
  ],
  windows: liveWindowsOf({ liveFrom: over.liveFrom, endedAt: null, pauses: [] }),
  statements: [],
  ...over,
});
const stored = (
  over: Partial<ExistingStatement> & { periodYearMonth: string },
): ExistingStatement => ({
  id: `st-${over.periodYearMonth}`,
  status: "final",
  netCollectionsCents: 0,
  netCollectionsRemittanceCount: 0,
  billingServiceMode: "billing_software",
  billingBps: 100,
  priorPeriodLines: [],
  figures: "",
  ...over,
});

describe("planMonths: which months still need a statement", () => {
  it("from go-live to the current month; a go-live on Nov 20 and a sweep on Nov 25 is one draft month of 11 live days", () => {
    const work = planMonths(
      facts({ liveFrom: d("2026-11-20T08:00:00Z") }),
      d("2026-11-25T00:00:00Z"),
    );
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      daysLive: 11,
      mode: "billing_software",
      finalize: false,
      settlement: false,
    });
    expect(work[0]?.period.key).toBe("2026-11");
  });

  it("a month closes only after its grace: Dec 3 leaves November a draft, Dec 7 finalizes it", () => {
    const f = facts({ liveFrom: d("2026-11-01T00:00:00Z") });
    expect(planMonths(f, d("2026-12-03T00:00:00Z")).map((w) => [w.period.key, w.finalize])).toEqual(
      [
        ["2026-11", false],
        ["2026-12", false],
      ],
    );
    expect(planMonths(f, d("2026-12-07T00:00:00Z")).map((w) => [w.period.key, w.finalize])).toEqual(
      [
        ["2026-11", true],
        ["2026-12", false],
      ],
    );
  });

  it("a month that is already final is not planned again", () => {
    const f = facts({
      liveFrom: d("2026-11-01T00:00:00Z"),
      statements: [stored({ periodYearMonth: "2026-11" })],
    });
    expect(planMonths(f, d("2026-12-07T00:00:00Z")).map((w) => w.period.key)).toEqual(["2026-12"]);
  });

  it("a CLOSED month finalizes whatever the subscription has become since: canceled Nov 20, swept Dec 10, November still finalizes for its 20 days", () => {
    const f = facts({
      liveFrom: d("2026-11-01T00:00:00Z"),
      windows: live("2026-11-01T00:00:00Z", "2026-11-20T14:00:00Z"),
    });
    const work = planMonths(f, d("2026-12-10T00:00:00Z"));
    expect(work.map((w) => [w.period.key, w.daysLive, w.finalize, w.settlement])).toEqual([
      ["2026-11", 20, true, false],
      // December has no live day: only a candidate settlement statement (written solely if it has late money to carry)
      ["2026-12", 0, false, true],
    ]);
  });

  it("a month that was entirely paused is skipped when it is past; the current one is a settlement candidate", () => {
    const f = facts({
      liveFrom: d("2026-10-25T00:00:00Z"),
      windows: live("2026-10-25T00:00:00Z", null, [{ from: "2026-11-01T00:00:00Z", to: null }]),
    });
    expect(
      planMonths(f, d("2026-12-10T00:00:00Z")).map((w) => [w.period.key, w.daysLive, w.settlement]),
    ).toEqual([
      ["2026-10", 7, false],
      ["2026-12", 0, true],
    ]);
  });

  it("prices each month with the mode in force on its first billed day: a change recorded Nov 28 for Dec 1 leaves November as it was", () => {
    const f = facts({
      liveFrom: d("2026-11-01T00:00:00Z"),
      modeHistory: [
        {
          id: "mode-initial",
          billingServiceMode: "billing_software",
          effectiveFrom: "2026-10-20",
          createdAt: d("2026-10-20T00:00:00Z"),
        },
        {
          id: "mode-next",
          billingServiceMode: "managed_billing",
          effectiveFrom: "2026-12-01",
          createdAt: d("2026-11-28T10:00:00Z"),
        },
      ],
    });
    expect(planMonths(f, d("2026-12-03T00:00:00Z")).map((w) => [w.period.key, w.mode])).toEqual([
      ["2026-11", "billing_software"],
      ["2026-12", "managed_billing"],
    ]);
  });

  it("refuses to plan from a contract with no mode in force", () => {
    expect(() =>
      planMonths(
        facts({ liveFrom: d("2026-11-01T00:00:00Z"), modeHistory: [] }),
        d("2026-11-05T00:00:00Z"),
      ),
    ).toThrow(/billing service mode/);
  });

  it("a past month with NO live day but a stored DRAFT (a settlement statement) stays planned and FINALIZES after its grace; without a stored draft it is skipped", () => {
    const ended = live("2026-11-01T00:00:00Z", "2026-11-20T14:00:00Z");
    const settlementDraft = stored({ periodYearMonth: "2026-12", status: "draft" });
    const f = facts({
      liveFrom: d("2026-11-01T00:00:00Z"),
      windows: ended,
      statements: [stored({ periodYearMonth: "2026-11" }), settlementDraft],
    });
    // Jan 3: December is inside its grace, still a draft; January is the current month (a new settlement candidate)
    expect(
      planMonths(f, d("2027-01-03T00:00:00Z")).map((w) => [w.period.key, w.settlement, w.finalize]),
    ).toEqual([
      ["2026-12", true, false],
      ["2027-01", true, false],
    ]);
    // Jan 7: December's grace has passed, so it finalizes
    expect(
      planMonths(f, d("2027-01-07T00:00:00Z")).find((w) => w.period.key === "2026-12"),
    ).toMatchObject({
      settlement: true,
      daysLive: 0,
      finalize: true,
    });
    // the same history with no stored December: no December work at all
    const bare = facts({
      liveFrom: d("2026-11-01T00:00:00Z"),
      windows: ended,
      statements: [stored({ periodYearMonth: "2026-11" })],
    });
    expect(planMonths(bare, d("2027-01-07T00:00:00Z")).map((w) => w.period.key)).toEqual([
      "2027-01",
    ]);
  });

  it("a go-live in the future plans nothing", () => {
    expect(
      planMonths(facts({ liveFrom: d("2027-01-10T00:00:00Z") }), d("2026-11-05T00:00:00Z")),
    ).toEqual([]);
  });
});

describe("priorPeriodLinesFor: late money is carried, never lost, never re-billed into the closed month (D4)", () => {
  // November closed at $16,500.50 collected (3 remittances) at 1%; a $40,000 835 dated Nov 29 posted on Dec 8
  const november = stored({
    periodYearMonth: "2026-11",
    netCollectionsCents: 1_650_050,
    netCollectionsRemittanceCount: 3,
    billingBps: 100,
  });
  const net = (cents: number, count: number) =>
    new Map([["2026-11", { netCents: cents, remittanceCount: count, pendingCount: 0 }]]);

  it("the $40,000 dated Nov 29 and posted Dec 8 becomes a $400.00 line on the December statement, with its source month and rate", () => {
    const lines = priorPeriodLinesFor(DEC, [november], net(5_650_050, 4));
    expect(lines).toEqual([
      {
        sourceYearMonth: "2026-11",
        netCollectionsCents: 4_000_000,
        remittanceCount: 1,
        billingServiceMode: "billing_software",
        billingBps: 100,
        feeCents: 40_000,
      },
    ]);
  });

  it("is carried ONCE: once a FINAL statement holds the line, the same money is not carried again; a later $100 is", () => {
    const decemberFinal = stored({
      periodYearMonth: "2026-12",
      priorPeriodLines: [
        {
          sourceYearMonth: "2026-11",
          netCollectionsCents: 4_000_000,
          remittanceCount: 1,
          billingServiceMode: "billing_software",
          billingBps: 100,
          feeCents: 40_000,
        },
      ],
    });
    const jan = calendarMonthOf(d("2027-01-10T00:00:00Z"));
    expect(priorPeriodLinesFor(jan, [november, decemberFinal], net(5_650_050, 4))).toEqual([]);
    const more = priorPeriodLinesFor(jan, [november, decemberFinal], net(5_660_050, 5));
    expect(more).toMatchObject([
      { netCollectionsCents: 10_000, feeCents: 100, remittanceCount: 1 },
    ]);
  });

  it("a DRAFT statement's own lines are not 'already carried': the draft recomputes the same line on every sweep", () => {
    const decemberDraft = stored({
      periodYearMonth: "2026-12",
      status: "draft",
      priorPeriodLines: [
        {
          sourceYearMonth: "2026-11",
          netCollectionsCents: 4_000_000,
          remittanceCount: 1,
          billingServiceMode: "billing_software",
          billingBps: 100,
          feeCents: 40_000,
        },
      ],
    });
    expect(priorPeriodLinesFor(DEC, [november, decemberDraft], net(5_650_050, 4))).toHaveLength(1);
  });

  it("an EARLIER DRAFT's lines count as carried for a later draft: the lines ride the earliest open statement, never two at once", () => {
    const line = {
      sourceYearMonth: "2026-11",
      netCollectionsCents: 4_000_000,
      remittanceCount: 1,
      billingServiceMode: "billing_software" as const,
      billingBps: 100,
      feeCents: 40_000,
    };
    const decemberDraft = stored({
      periodYearMonth: "2026-12",
      status: "draft",
      priorPeriodLines: [line],
    });
    const jan = calendarMonthOf(d("2027-01-10T00:00:00Z"));
    // January sees December's draft line as carried: no duplicate on the later draft
    expect(priorPeriodLinesFor(jan, [november, decemberDraft], net(5_650_050, 4))).toEqual([]);
    // the same money a further $100 later is carried alone, on the later draft
    expect(priorPeriodLinesFor(jan, [november, decemberDraft], net(5_660_050, 5))).toMatchObject([
      { netCollectionsCents: 10_000 },
    ]);
    // while December itself, which never counts its own lines, still gets the whole line
    expect(priorPeriodLinesFor(DEC, [november, decemberDraft], net(5_650_050, 4))).toHaveLength(1);
  });

  it("uses the SOURCE month's own rate even when the mode changed since, and none for a month that billed outside ChartWarden", () => {
    const managedNovember = stored({
      ...november,
      billingServiceMode: "managed_billing",
      billingBps: 400,
    });
    expect(priorPeriodLinesFor(DEC, [managedNovember], net(5_650_050, 4))[0]).toMatchObject({
      billingBps: 400,
      feeCents: 160_000,
    });
    const noneNovember = stored({ ...november, billingServiceMode: "none", billingBps: 0 });
    expect(priorPeriodLinesFor(DEC, [noneNovember], net(5_650_050, 4))).toEqual([]);
  });

  it("is never a credit (a month that now collects LESS) and never a line for a draft or a later month", () => {
    expect(priorPeriodLinesFor(DEC, [november], net(1_000_000, 2))).toEqual([]);
    expect(priorPeriodLinesFor(NOV, [november], net(5_650_050, 4))).toEqual([]); // not earlier than the target
    expect(
      priorPeriodLinesFor(DEC, [stored({ ...november, status: "draft" })], net(5_650_050, 4)),
    ).toEqual([]);
  });

  it("a delta too small to round to a cent waits and accumulates rather than being lost", () => {
    // 49 cents at 1% is 0.49 cents: no line yet; 50 cents is 0.5 cents -> 1
    expect(priorPeriodLinesFor(DEC, [november], net(1_650_099, 3))).toEqual([]);
    expect(priorPeriodLinesFor(DEC, [november], net(1_650_150, 4))).toMatchObject([
      { netCollectionsCents: 100, feeCents: 1 },
    ]);
  });
});

describe("buildStatementValues: the figures of a statement", () => {
  const nov20 = facts({ liveFrom: d("2026-11-20T08:00:00Z") });
  const work = planMonths(nov20, d("2026-11-25T00:00:00Z"))[0]!;
  const meters = {
    daily: [12, 12, 12],
    staff: { count: 4, basis: "identity_filtered" as const },
    collections: { netCents: 1_500_050, remittanceCount: 3, pendingCount: 2 },
  };
  const build = (
    over: {
      isFirstStatement?: boolean;
      priorLines?: Parameters<typeof buildStatementValues>[0]["priorLines"];
    } = {},
  ) =>
    buildStatementValues({
      facts: nov20,
      work,
      meters,
      priorLines: over.priorLines ?? [],
      isFirstStatement: over.isFirstStatement ?? true,
      at: d("2026-11-25T00:00:00Z"),
    });

  it("a mid-month go-live: the $2,000 band prorated by 11/30 is $733.33, the implementation fee is not prorated, the 1% billing fee is on what was collected", () => {
    const v = build();
    expect(v).toMatchObject({
      daysLive: 11,
      adcDaysInPeriod: 30,
      bandFeeCents: 200_000,
      perUserSubtotalCents: 40_000,
      platformFeeCents: 73_333,
      billingFeeCents: 15_001,
      oneTimeFeeCents: 250_000,
      minimumAdjustmentCents: 0,
      priorPeriodFeeCents: 0,
      totalCents: 73_333 + 15_001 + 250_000,
      status: "draft",
      needsReview: false, // a draft with 2 pending remittances is routine
    });
  });

  it("only the first statement carries the implementation fee", () => {
    expect(build({ isFirstStatement: false }).oneTimeFeeCents).toBe(0);
  });

  it("a prior-period line adds its fee to the total and is stored with its source month", () => {
    const line = {
      sourceYearMonth: "2026-10",
      netCollectionsCents: 4_000_000,
      remittanceCount: 1,
      billingServiceMode: "billing_software" as const,
      billingBps: 100,
      feeCents: 40_000,
    };
    const v = build({ isFirstStatement: false, priorLines: [line] });
    expect(v.priorPeriodLines).toEqual([line]);
    expect(v.priorPeriodFeeCents).toBe(40_000);
    expect(v.totalCents).toBe(73_333 + 15_001 + 40_000);
  });

  it("flags a statement for review: an unfiltered staff count always; pending remittances only once the month is final", () => {
    const unfiltered = buildStatementValues({
      facts: nov20,
      work,
      meters: { ...meters, staff: { count: 9, basis: "ledger_unfiltered" } },
      priorLines: [],
      isFirstStatement: true,
      at: d("2026-11-25T00:00:00Z"),
    });
    expect(unfiltered.needsReview).toBe(true);
    const closing = buildStatementValues({
      facts: nov20,
      work: { ...work, finalize: true },
      meters,
      priorLines: [],
      isFirstStatement: true,
      at: d("2026-12-07T00:00:00Z"),
    });
    expect(closing).toMatchObject({ status: "final", needsReview: true });
  });

  describe("a closed month billed on a sparse census is flagged for review (the month freezes on the mean of the days observed)", () => {
    const fullMonth = facts({ liveFrom: d("2026-10-20T00:00:00Z") });
    const nov = planMonths(fullMonth, d("2026-12-07T00:00:00Z")).find(
      (w) => w.period.key === "2026-11",
    )!;
    const closeOn = (observedDays: number, finalize = true) =>
      buildStatementValues({
        facts: fullMonth,
        work: { ...nov, finalize },
        meters: {
          daily: Array.from({ length: observedDays }, () => 12),
          staff: { count: 4, basis: "identity_filtered" as const },
          // nothing pending, so the census is the only reason a statement could be flagged
          collections: { netCents: 1_500_050, remittanceCount: 3, pendingCount: 0 },
        },
        priorLines: [],
        isFirstStatement: false,
        at: d("2026-12-07T00:00:00Z"),
      });

    it("25 of 30 days down (5 observed) is flagged; one missed day (29 observed) is not", () => {
      expect(closeOn(5)).toMatchObject({ status: "final", adcDaysObserved: 5, needsReview: true });
      expect(closeOn(29)).toMatchObject({ status: "final", needsReview: false });
    });

    it("the threshold is MIN_CENSUS_COVERAGE_PERCENT of the live days: exactly 80% passes, one day less is flagged", () => {
      expect(MIN_CENSUS_COVERAGE_PERCENT).toBe(80);
      expect(closeOn(24).needsReview).toBe(false); // 24 of 30
      expect(closeOn(23).needsReview).toBe(true);
      expect(isSparseCensus(8, 10)).toBe(false);
      expect(isSparseCensus(7, 10)).toBe(true);
      expect(isSparseCensus(0, 0)).toBe(false); // no live day, nothing expected
    });

    it("an open month is never flagged on it: its days have not happened yet", () => {
      expect(closeOn(5, false)).toMatchObject({ status: "draft", needsReview: false });
    });
  });

  describe("sparse is judged against the days a sweep COULD have observed, not the days live (a short month has no slack, and an edge day may hold no sweep)", () => {
    /** November closed for a contract that went live at `liveFrom`, with `observed` census days. */
    const novemberClosed = (liveFrom: string, observed: number) => {
      const f = facts({ liveFrom: d(liveFrom) });
      const work = planMonths(f, d("2026-12-07T00:00:00Z")).find(
        (w) => w.period.key === "2026-11",
      )!;
      return {
        work,
        values: buildStatementValues({
          facts: f,
          work: { ...work, finalize: true },
          meters: {
            daily: Array.from({ length: observed }, () => 12),
            staff: { count: 4, basis: "identity_filtered" as const },
            collections: { netCents: 1_500_050, remittanceCount: 3, pendingCount: 0 },
          },
          priorLines: [],
          isFirstStatement: false,
          at: d("2026-12-07T00:00:00Z"),
        }),
      };
    };

    it("a go-live at 18:30 on the 27th of a 30-day month: 4 days live, but the last sweep of the 27th (18:00) had run, so 3 can be observed; 3 observed is healthy", () => {
      const healthy = novemberClosed("2026-11-27T18:30:00Z", 3);
      expect(healthy.work.daysLive).toBe(4);
      expect(healthy.values.needsReview).toBe(false); // 3 of the 4 days live was 75%, below 80%: the old rule flagged a healthy census
      expect(novemberClosed("2026-11-27T18:30:00Z", 2).values.needsReview).toBe(true); // a real gap still is
    });

    it("a 4-live-day month from midnight expects 4: one missing day is below 80% and flagged, none is not", () => {
      const missing = novemberClosed("2026-11-27T00:00:00Z", 3);
      expect(missing.work.daysLive).toBe(4);
      expect(missing.values.needsReview).toBe(true);
      expect(novemberClosed("2026-11-27T00:00:00Z", 4).values.needsReview).toBe(false);
    });

    it("a full month expects 30: 24 of 30 is exactly 80% and passes, 23 does not", () => {
      expect(novemberClosed("2026-10-20T00:00:00Z", 24).values.needsReview).toBe(false);
      expect(novemberClosed("2026-10-20T00:00:00Z", 23).values.needsReview).toBe(true);
    });

    it("7 of 11 days (a go-live at 08:00 on the 20th, so the 20th holds the 12:00 sweep) is sparse; 9 of 11 is not", () => {
      const sparse = novemberClosed("2026-11-20T08:00:00Z", 7);
      expect(sparse.work.daysLive).toBe(11);
      expect(sparse.values.needsReview).toBe(true);
      expect(novemberClosed("2026-11-20T08:00:00Z", 9).values.needsReview).toBe(false);
    });

    it("expectedCensusDays counts a day only when a sweep instant falls inside a live window", () => {
      // sweeps at 00:00, 06:00, 12:00 and 18:00 UTC
      expect(CENSUS_SWEEP_INTERVAL_HOURS).toBe(6);
      expect(24 % CENSUS_SWEEP_INTERVAL_HOURS).toBe(0);
      const expected = (
        from: string,
        to: string | null,
        pauses: { from: string; to: string | null }[] = [],
      ) => expectedCensusDays(NOV, live(from, to, pauses));
      expect(expected("2026-10-01T00:00:00Z", null)).toBe(30);
      expect(expected("2026-11-30T18:00:00Z", null)).toBe(1); // a sweep at exactly the go-live instant is inside
      expect(expected("2026-11-30T18:00:01Z", null)).toBe(0); // go-live after the last sweep of the month: nothing can be observed
      expect(daysLiveInMonth(NOV, live("2026-11-30T18:00:01Z"))).toBe(1); // although the day is live and is billed
      // canceled at 05:00 on the 10th: that day still holds its 00:00 sweep; canceled at 00:00 exactly it does not
      expect(expected("2026-10-01T00:00:00Z", "2026-11-10T05:00:00Z")).toBe(10);
      expect(expected("2026-10-01T00:00:00Z", "2026-11-10T00:00:00Z")).toBe(9);
      // a pause takes its days out, keeping a day that holds a sweep outside it (paused 13:00 on the 10th to 05:00 on the 12th)
      expect(
        expected("2026-10-01T00:00:00Z", null, [
          { from: "2026-11-10T13:00:00Z", to: "2026-11-12T05:00:00Z" },
        ]),
      ).toBe(30 - 1); // only the 11th loses its census: the 10th keeps 00:00, 06:00 and 12:00, the 12th its 06:00 onwards
    });
  });

  it("a settlement statement reads no meter: zero staff, no census, no collections, no platform fee, no one-time fee, only its prior-period lines", () => {
    const line = {
      sourceYearMonth: "2026-11",
      netCollectionsCents: 4_000_000,
      remittanceCount: 1,
      billingServiceMode: "billing_software" as const,
      billingBps: 100,
      feeCents: 40_000,
    };
    const v = buildStatementValues({
      facts: nov20,
      work: {
        period: DEC,
        daysLive: 0,
        mode: "billing_software",
        finalize: false,
        settlement: true,
      },
      meters,
      priorLines: [line],
      isFirstStatement: true,
      at: d("2026-12-08T00:00:00Z"),
    });
    expect(v).toMatchObject({
      staffCount: 0,
      adcDaysObserved: 0,
      netCollectionsCents: 0,
      platformFeeCents: 0,
      oneTimeFeeCents: 0,
      billingFeeCents: 0,
      daysLive: 0,
      priorPeriodFeeCents: 40_000,
      totalCents: 40_000,
    });
  });

  it("figuresOf is the same for the same figures, ignores jsonb key order and timestamps, and differs when a figure moves", () => {
    const line = {
      sourceYearMonth: "2026-10",
      netCollectionsCents: 100,
      remittanceCount: 1,
      billingServiceMode: "billing_software" as const,
      billingBps: 100,
      feeCents: 1,
    };
    const a = build({ priorLines: [line] });
    // jsonb returns keys in its own order; the figures string must not care
    const reordered = {
      ...a,
      priorPeriodLines: [
        {
          feeCents: 1,
          billingBps: 100,
          billingServiceMode: "billing_software" as const,
          remittanceCount: 1,
          netCollectionsCents: 100,
          sourceYearMonth: "2026-10",
        },
      ],
    };
    expect(figuresOf(reordered)).toBe(figuresOf(a));
    const relabelled = { ...a, computedAt: d("2030-01-01T00:00:00Z"), finalizedAt: null };
    expect(figuresOf(relabelled)).toBe(figuresOf(a));
    expect(figuresOf({ ...a, staffCount: a.staffCount + 1 })).not.toBe(figuresOf(a));
    expect(figuresOf({ ...a, totalCents: a.totalCents + 1 })).not.toBe(figuresOf(a));
  });
});

describe("lifetimeFromTransitions: the pauses and the end of a subscription", () => {
  const at = (iso: string): Date => new Date(iso);
  const t = (from: Transition["from"], to: Transition["to"], iso: string): Transition => ({
    from,
    to,
    at: at(iso),
  });
  const sub = (
    status: Parameters<typeof lifetimeFromTransitions>[1]["status"],
    updated: string,
    canceled: string | null = null,
    pausedUntil: string | null = null,
  ) => ({
    status,
    canceledAt: canceled ? at(canceled) : null,
    updatedAt: at(updated),
    pausedUntil: pausedUntil ? at(pausedUntil) : null,
  });
  /** `lifetimeFromTransitions` as of a run on 2026-11-26 unless a test says otherwise. */
  const lifetimeAt = (
    transitions: Transition[],
    row: ReturnType<typeof sub>,
    now = at("2026-11-26T00:00:00Z"),
  ) => lifetimeFromTransitions(transitions, row, now);

  it("a pause opens on a transition into paused and closes on the next one out of it", () => {
    const life = lifetimeAt(
      [
        t(null, "active", "2026-10-20T00:00:00Z"),
        t("active", "paused", "2026-11-10T09:00:00Z"),
        t("paused", "active", "2026-11-15T09:00:00Z"),
      ],
      sub("active", "2026-11-15T09:00:00Z"),
    );
    expect(life).toEqual({
      endedAt: null,
      pauses: [{ from: at("2026-11-10T09:00:00Z"), to: at("2026-11-15T09:00:00Z") }],
    });
  });

  it("an open pause stays open while the subscription IS paused", () => {
    const life = lifetimeAt(
      [t("active", "paused", "2026-11-15T09:00:00Z")],
      sub("paused", "2026-11-15T09:00:00Z"),
    );
    expect(life.pauses).toEqual([{ from: at("2026-11-15T09:00:00Z"), to: null }]);
  });

  it("an open pause on a subscription that is NOT paused (resumed by a path that wrote no history) closes at the row's updated_at, not never", () => {
    const life = lifetimeAt(
      [t("active", "paused", "2026-11-15T09:00:00Z")],
      sub("active", "2026-11-20T10:00:00Z"),
    );
    expect(life.pauses).toEqual([
      { from: at("2026-11-15T09:00:00Z"), to: at("2026-11-20T10:00:00Z") },
    ]);
    // and it prices: Nov 16..19 are the fully paused days (the 15th and the 20th were partly used)
    const windows = liveWindowsOf({
      liveFrom: d("2026-11-01T00:00:00Z"),
      endedAt: life.endedAt,
      pauses: life.pauses,
    });
    expect(daysLiveInMonth(NOV, windows)).toBe(30 - 4);
  });

  it("an open pause is closed at the NEXT transition after it, not at updated_at, which drifts on unrelated writes", () => {
    // paused 11-10, then a later row that does not leave `paused` through the ledger (the resume wrote none); the row's own
    // updated_at (11-28) moved on for an unrelated reason and must not decide when the pause ended
    const life = lifetimeAt(
      [
        t("active", "paused", "2026-11-10T09:00:00Z"),
        t("active", "canceled", "2026-11-20T10:00:00Z"),
      ],
      sub("canceled", "2026-11-28T00:00:00Z", "2026-11-20T10:00:00Z"),
    );
    expect(life.pauses).toEqual([
      { from: at("2026-11-10T09:00:00Z"), to: at("2026-11-20T10:00:00Z") },
    ]);
  });

  it("every stale open pause is repaired: one followed by another pause closes where the next pause starts", () => {
    const life = lifetimeAt(
      [
        t("active", "paused", "2026-11-05T09:00:00Z"),
        t("active", "paused", "2026-11-12T09:00:00Z"), // the first was resumed by a path that wrote no row
        t("paused", "active", "2026-11-14T09:00:00Z"),
        t("active", "paused", "2026-11-18T09:00:00Z"),
      ],
      sub("active", "2026-11-25T00:00:00Z"),
    );
    expect(life.pauses).toEqual([
      { from: at("2026-11-05T09:00:00Z"), to: at("2026-11-12T09:00:00Z") },
      { from: at("2026-11-12T09:00:00Z"), to: at("2026-11-14T09:00:00Z") },
      // the LAST open pause has nothing after it: it still falls back to the row's updated_at
      { from: at("2026-11-18T09:00:00Z"), to: at("2026-11-25T00:00:00Z") },
    ]);
  });

  it("a paused->paused row (a plan change during a pause) keeps the pause open", () => {
    const life = lifetimeAt(
      [
        t("active", "paused", "2026-11-10T09:00:00Z"),
        t("paused", "paused", "2026-11-12T09:00:00Z"),
      ],
      sub("paused", "2026-11-12T09:00:00Z"),
    );
    expect(life.pauses).toEqual([{ from: at("2026-11-10T09:00:00Z"), to: null }]);
  });

  it("a pause with a plan change inside it closes at the resume, not at the plan change", () => {
    const life = lifetimeAt(
      [
        t("active", "paused", "2026-11-10T09:00:00Z"),
        t("paused", "paused", "2026-11-12T09:00:00Z"),
        t("paused", "active", "2026-11-16T09:00:00Z"),
      ],
      sub("active", "2026-11-16T09:00:00Z"),
    );
    expect(life.pauses).toEqual([
      { from: at("2026-11-10T09:00:00Z"), to: at("2026-11-16T09:00:00Z") },
    ]);
  });

  it("the end is canceled_at, else the cancel transition, else the last write; none while the subscription runs", () => {
    expect(
      lifetimeAt([], sub("canceled", "2026-11-25T00:00:00Z", "2026-11-20T14:00:00Z")).endedAt,
    ).toEqual(at("2026-11-20T14:00:00Z"));
    expect(
      lifetimeAt(
        [t("active", "canceled", "2026-11-19T00:00:00Z")],
        sub("canceled", "2026-11-25T00:00:00Z"),
      ).endedAt,
    ).toEqual(at("2026-11-19T00:00:00Z"));
    expect(lifetimeAt([], sub("canceled", "2026-11-25T00:00:00Z")).endedAt).toEqual(
      at("2026-11-25T00:00:00Z"),
    );
    expect(lifetimeAt([], sub("active", "2026-11-25T00:00:00Z")).endedAt).toBeNull();
  });

  describe("a pause with an end date is over at that date, whether or not the hourly sweep has resumed the row yet", () => {
    const UNTIL = "2026-12-15T00:00:00.000Z";
    const PAUSED_AT = "2026-11-10T09:00:00Z";
    const pauseRow = (iso: string, until: string | null = UNTIL): Transition => ({
      ...t("active", "paused", iso),
      reasonCode: "platform_ops_pause",
      detail: until ? `paused_until=${until}` : null,
    });

    it("a still-paused subscription whose date has passed stops being paused at the date", () => {
      const life = lifetimeAt(
        [pauseRow(PAUSED_AT)],
        sub("paused", PAUSED_AT, null, UNTIL),
        at("2026-12-20T00:00:00Z"),
      );
      expect(life.pauses).toEqual([{ from: at(PAUSED_AT), to: at(UNTIL) }]);
      // and it bills: 15 through 31 December are live (17 days), 1 through 14 paused
      const windows = liveWindowsOf({
        liveFrom: d("2026-11-01T00:00:00Z"),
        endedAt: life.endedAt,
        pauses: life.pauses,
      });
      expect(daysLiveInMonth(DEC, windows)).toBe(17);
    });

    it("a date still in the future changes nothing: the pause stays open", () => {
      const life = lifetimeAt(
        [pauseRow(PAUSED_AT)],
        sub("paused", PAUSED_AT, null, UNTIL),
        at("2026-12-14T23:59:59Z"),
      );
      expect(life.pauses).toEqual([{ from: at(PAUSED_AT), to: null }]);
    });

    it("an open-ended pause (no date) is never closed by the clock", () => {
      const life = lifetimeAt(
        [pauseRow(PAUSED_AT, null)],
        sub("paused", PAUSED_AT),
        at("2027-06-01T00:00:00Z"),
      );
      expect(life.pauses).toEqual([{ from: at(PAUSED_AT), to: null }]);
    });

    it("a resume AFTER the date still ends the pause at the date (the resume cleared the row's date; the ledger kept it)", () => {
      const life = lifetimeAt(
        [pauseRow(PAUSED_AT), t("paused", "active", "2026-12-20T09:00:00Z")],
        sub("active", "2026-12-20T09:00:00Z"),
        at("2026-12-21T00:00:00Z"),
      );
      expect(life.pauses).toEqual([{ from: at(PAUSED_AT), to: at(UNTIL) }]);
    });

    it("the pause-resume sweep does not move the lifetime: the row resumed at its date (the ledger dated at the date) reads exactly as the row still paused", () => {
      const sweptAt = "2026-12-20T03:05:00Z"; // the sweep's instant: an hour-scale distance from the date, and NOT what decides
      const beforeSweep = lifetimeAt(
        [pauseRow(PAUSED_AT)],
        sub("paused", PAUSED_AT, null, UNTIL),
        at(sweptAt),
      );
      for (const readAt of [sweptAt, "2026-12-21T00:00:00Z", "2027-02-01T00:00:00Z"]) {
        const afterSweep = lifetimeAt(
          [
            pauseRow(PAUSED_AT),
            { ...t("paused", "active", UNTIL), reasonCode: "platform_ops_pause_lapsed" },
          ],
          sub("active", sweptAt), // the row's updated_at is the sweep's instant
          at(readAt),
        );
        expect(afterSweep).toEqual(beforeSweep);
      }
      expect(beforeSweep.pauses).toEqual([{ from: at(PAUSED_AT), to: at(UNTIL) }]);
    });

    it("a resume BEFORE the date ends the pause at the resume", () => {
      const life = lifetimeAt(
        [pauseRow(PAUSED_AT), t("paused", "active", "2026-11-20T09:00:00Z")],
        sub("active", "2026-11-20T09:00:00Z"),
        at("2026-12-21T00:00:00Z"),
      );
      expect(life.pauses).toEqual([{ from: at(PAUSED_AT), to: at("2026-11-20T09:00:00Z") }]);
    });

    it("a suspension after a lapsed operator pause is a NEW pause: the ledger the consumer writes (pause, lapse at the date, suspension) reads as two", () => {
      const life = lifetimeAt(
        [
          pauseRow(PAUSED_AT),
          { ...t("paused", "active", UNTIL), reasonCode: "platform_ops_pause_lapsed" },
          {
            ...t("active", "paused", "2026-12-20T00:00:00Z"),
            reasonCode: "org_suspended_by_platform_admin",
            detail: "compliance_hold",
          },
        ],
        sub("paused", "2026-12-20T00:00:00Z"),
        at("2026-12-21T00:00:00Z"),
      );
      expect(life.pauses).toEqual([
        { from: at(PAUSED_AT), to: at(UNTIL) },
        { from: at("2026-12-20T00:00:00Z"), to: null },
      ]);
    });

    describe("an organization suspension that arrives while a dated pause is still running makes the pause open-ended", () => {
      const SUSPENDED_AT = "2026-12-05T00:00:00Z";
      /** The ledger the consumer writes: the pause, then a paused -> paused row for the suspension (the row's own date is cleared with it). */
      const suspensionRow: Transition = {
        ...t("paused", "paused", SUSPENDED_AT),
        reasonCode: "org_suspended_by_platform_admin",
        detail: "compliance_hold",
      };

      it("the date no longer ends the pause: it stays open past the date", () => {
        const life = lifetimeAt(
          [pauseRow(PAUSED_AT), suspensionRow],
          sub("paused", SUSPENDED_AT), // paused_until was cleared with the conversion
          at("2026-12-20T00:00:00Z"),
        );
        expect(life.pauses).toEqual([{ from: at(PAUSED_AT), to: null }]);
      });

      it("the statement does not move at the conversion: read between the suspension and the old date, the lifetime is the same with or without the row", () => {
        for (const readAt of [
          "2026-12-05T00:00:01Z",
          "2026-12-10T12:00:00Z",
          "2026-12-14T23:59:59Z",
        ]) {
          const before = lifetimeAt(
            [pauseRow(PAUSED_AT)],
            sub("paused", PAUSED_AT, null, UNTIL),
            at(readAt),
          );
          const after = lifetimeAt(
            [pauseRow(PAUSED_AT), suspensionRow],
            sub("paused", SUSPENDED_AT),
            at(readAt),
          );
          expect(after).toEqual(before);
        }
      });

      it("only a SUSPENSION voids the date: a paused -> paused row of another reason (a plan change) leaves it in force", () => {
        const life = lifetimeAt(
          [
            pauseRow(PAUSED_AT),
            { ...t("paused", "paused", SUSPENDED_AT), reasonCode: "plan_changed" },
          ],
          sub("paused", SUSPENDED_AT, null, UNTIL),
          at("2026-12-20T00:00:00Z"),
        );
        expect(life.pauses).toEqual([{ from: at(PAUSED_AT), to: at(UNTIL) }]);
      });

      it("a pause that ended before the suspension is not reopened by it", () => {
        const life = lifetimeAt(
          [
            pauseRow(PAUSED_AT),
            t("paused", "active", "2026-11-20T09:00:00Z"),
            suspensionRow, // (a stray row: the subscription was active, the consumer would not write this)
          ],
          sub("active", SUSPENDED_AT),
          at("2026-12-20T00:00:00Z"),
        );
        expect(life.pauses).toEqual([{ from: at(PAUSED_AT), to: at("2026-11-20T09:00:00Z") }]);
      });
    });

    it("a date that is exactly `at` has passed: the pause is over at the date (the boundary is inclusive)", () => {
      const life = lifetimeAt(
        [pauseRow(PAUSED_AT)],
        sub("paused", PAUSED_AT, null, UNTIL),
        at(UNTIL),
      );
      expect(life.pauses).toEqual([{ from: at(PAUSED_AT), to: at(UNTIL) }]);
      // one millisecond earlier it has not
      const before = lifetimeAt(
        [pauseRow(PAUSED_AT)],
        sub("paused", PAUSED_AT, null, UNTIL),
        new Date(at(UNTIL).getTime() - 1),
      );
      expect(before.pauses).toEqual([{ from: at(PAUSED_AT), to: null }]);
    });

    it("only an operator's pause is read for an end date: a suspension reason that looks like one is free text, not a date", () => {
      const suspended = (
        detail: string,
        reasonCode = "org_suspended_by_platform_admin",
      ): Transition => ({
        ...t("active", "paused", PAUSED_AT),
        reasonCode,
        detail,
      });
      const lookalike = `paused_until=${UNTIL}`;
      // the M2 suspension writes its free-text reason into the same column: never an end date, whatever it says
      expect(
        lifetimeAt(
          [suspended(lookalike), t("paused", "active", "2026-12-20T09:00:00Z")],
          sub("active", "2026-12-20T09:00:00Z"),
          at("2026-12-21T00:00:00Z"),
        ).pauses,
      ).toEqual([{ from: at(PAUSED_AT), to: at("2026-12-20T09:00:00Z") }]);
      // and from an operator's pause the format is exact: trailing text, a different spelling of the instant or an offset all read as none
      for (const detail of [
        `${lookalike} (customer request)`,
        "paused_until=2026-12-15",
        "paused_until=2026-12-15T00:00:00Z",
        "paused_until=2026-12-15T01:00:00.000+01:00",
      ]) {
        expect(
          lifetimeAt(
            [suspended(detail, "platform_ops_pause")],
            sub("paused", PAUSED_AT),
            at("2026-12-20T00:00:00Z"),
          ).pauses,
          detail,
        ).toEqual([{ from: at(PAUSED_AT), to: null }]);
      }
    });

    it("a date at or before the pause itself, or one that is not an instant, is ignored", () => {
      const early = lifetimeAt(
        [pauseRow(PAUSED_AT, "2026-11-01T00:00:00.000Z")],
        sub("paused", PAUSED_AT),
        at("2026-12-20T00:00:00Z"),
      );
      expect(early.pauses).toEqual([{ from: at(PAUSED_AT), to: null }]);
      const garbage = lifetimeAt(
        [pauseRow(PAUSED_AT, "not-a-date")],
        sub("paused", PAUSED_AT),
        at("2026-12-20T00:00:00Z"),
      );
      expect(garbage.pauses).toEqual([{ from: at(PAUSED_AT), to: null }]);
    });
  });
});
