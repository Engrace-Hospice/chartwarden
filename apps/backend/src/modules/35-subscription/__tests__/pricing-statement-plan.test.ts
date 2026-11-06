// Slice 2 (tenant pricing) — the PURE decisions of the monthly statement: the calendar (days live), the mode history, which months need a
// statement, which late money rides the next open one, and the figures of a row. No database and no clock: every money case is numeric.
import { describe, expect, it } from "vitest";
import {
  type ModeHistoryRow,
  firstOfNextMonthIso,
  modeChangeEffectiveOn,
  modeInForceOn,
  pendingModeAfter,
} from "../pricing/contract-mode";
import { type Transition, lifetimeFromTransitions } from "../pricing/statement-inputs";
import {
  calendarMonthOf,
  daysLiveInMonth,
  liveWindowsOf,
  monthsFromThrough,
} from "../pricing/statement-period";
import {
  type ContractFacts,
  type ExistingStatement,
  buildStatementValues,
  figuresOf,
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
          billingServiceMode: "billing_software",
          effectiveFrom: "2026-10-20",
          createdAt: d("2026-10-20T00:00:00Z"),
        },
        {
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
  ) => ({
    status,
    canceledAt: canceled ? at(canceled) : null,
    updatedAt: at(updated),
  });

  it("a pause opens on a transition into paused and closes on the next one out of it", () => {
    const life = lifetimeFromTransitions(
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
    const life = lifetimeFromTransitions(
      [t("active", "paused", "2026-11-15T09:00:00Z")],
      sub("paused", "2026-11-15T09:00:00Z"),
    );
    expect(life.pauses).toEqual([{ from: at("2026-11-15T09:00:00Z"), to: null }]);
  });

  it("an open pause on a subscription that is NOT paused (resumed by a path that wrote no history) closes at the row's updated_at, not never", () => {
    const life = lifetimeFromTransitions(
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

  it("the end is canceled_at, else the cancel transition, else the last write; none while the subscription runs", () => {
    expect(
      lifetimeFromTransitions([], sub("canceled", "2026-11-25T00:00:00Z", "2026-11-20T14:00:00Z"))
        .endedAt,
    ).toEqual(at("2026-11-20T14:00:00Z"));
    expect(
      lifetimeFromTransitions(
        [t("active", "canceled", "2026-11-19T00:00:00Z")],
        sub("canceled", "2026-11-25T00:00:00Z"),
      ).endedAt,
    ).toEqual(at("2026-11-19T00:00:00Z"));
    expect(lifetimeFromTransitions([], sub("canceled", "2026-11-25T00:00:00Z")).endedAt).toEqual(
      at("2026-11-25T00:00:00Z"),
    );
    expect(lifetimeFromTransitions([], sub("active", "2026-11-25T00:00:00Z")).endedAt).toBeNull();
  });
});
