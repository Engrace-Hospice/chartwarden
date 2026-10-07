import {
  type HippsRateTable,
  type RhcCarryOverInput,
  type RhcHetsPeriod,
  addDaysIso,
  calculateHipps,
  computeRhcCarryOver,
} from "@wardenx/billing";
// @wardenx/billing — the two-tier RHC carry-over across stays (ours + other hospices' per HETS). Pure.
// CMS: Claims Processing Manual ch. 11 §30.2 + CR 9201 / R3326CP (see rhc-carry-over.ts header).
import { describe, expect, it } from "vitest";

const OTHER_NPI = "1649726464";
const OUR_NPI = "1234567893";

const run = (over: Partial<RhcCarryOverInput>) =>
  computeRhcCarryOver({ electionDate: "2026-02-16", internalStays: [], hets: null, ...over });
const hets = (periods: RhcHetsPeriod[], extra: { stale?: boolean; truncated?: boolean } = {}) => ({
  stale: extra.stale ?? false,
  truncated: extra.truncated ?? false,
  periods,
});
const billed = (startDate: string, endDate: string | null, hospiceNpi = OTHER_NPI) =>
  ({ kind: "benefit_period", startDate, endDate, hospiceNpi }) as const;

describe("computeRhcCarryOver — the manual's example (ch. 11 §30.2)", () => {
  it("elected 01/10, revoked 01/30, re-elected 02/16 → 21 days carry (both ends inclusive)", () => {
    // Arrange / Act
    const r = run({ internalStays: [{ start: "2026-01-10", end: "2026-01-30", ref: "adm-1" }] });
    // Assert
    expect(r.priorDays).toBe(21);
    expect(r.basis).toBe("internal_only");
    expect(r.daysSinceLastCare).toBe(17);
    expect(r.chain).toEqual([
      expect.objectContaining({
        source: "internal",
        start: "2026-01-10",
        end: "2026-01-30",
        countedDays: 21,
        ref: "adm-1",
      }),
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("feeds calculateHipps so day 61 (the first low-rate day) is 03/27", () => {
    const { priorDays } = run({ internalStays: [{ start: "2026-01-10", end: "2026-01-30" }] });
    const rates: HippsRateTable = {
      rhcDays1to60PerDiemCents: 20_000,
      rhcDays61PlusPerDiemCents: 16_000,
      chcHourlyRateCents: 6_667,
      ircPerDiemCents: 50_000,
      gipPerDiemCents: 100_000,
      rhcLaborShare: "0.6600",
      chcLaborShare: "0.6800",
      ircLaborShare: "0.5400",
      gipLaborShare: "0.6400",
    };
    const hipps = calculateHipps({
      claimServiceFrom: "2026-03-01",
      claimServiceTo: "2026-03-28",
      hospiceAdmissionDate: "2026-02-16",
      priorHospiceDays: priorDays,
      levelOfCarePeriods: [
        { levelOfCare: "routine_home_care", from: "2026-02-16", to: "2026-03-28" },
      ],
      rateTable: rates,
      wageIndexCcn: "381588",
      wageIndexFiscalYear: 2025,
      wageIndexFactorDecimal: "1.0000",
    });
    // 21 + 39 high days (02/16 – 03/26), then 03/27 – 03/28 low.
    expect(hipps.rhcDays1to60).toBe(26);
    expect(hipps.rhcDays61Plus).toBe(2);
    expect(hipps.segments.find((s) => s.rhcDayBucket === "days_61_plus")?.dateFrom).toBe(
      "2026-03-27",
    );
  });
});

describe("computeRhcCarryOver — other hospices via HETS", () => {
  it("counts another hospice's period that ended within 60 days of the new election", () => {
    const r = run({ hets: hets([billed("2025-12-20", "2026-01-05")]) });
    expect(r.priorDays).toBe(17);
    expect(r.basis).toBe("hets_merged");
    expect(r.chain[0]).toMatchObject({ source: "hets", hospiceNpi: OTHER_NPI, countedDays: 17 });
  });

  it("a gap of 61 days resets the count; exactly 60 still carries", () => {
    const election = "2026-02-16";
    const endedAt = (gap: number) => addDaysIso(election, -gap);
    const reset = run({ hets: hets([billed("2025-11-01", endedAt(61))]) });
    expect(reset.priorDays).toBe(0);
    expect(reset.chain).toEqual([]);
    const carried = run({ hets: hets([billed(addDaysIso(endedAt(60), -9), endedAt(60))]) });
    expect(carried.priorDays).toBe(10);
  });

  it("walks a chain of three stays (ours, another hospice, ours) and stops at the first gap over 60", () => {
    const r = run({
      electionDate: "2026-06-01",
      internalStays: [
        { start: "2026-05-01", end: "2026-05-10" }, // 10 days, gap 22 to 06/01
        { start: "2026-02-01", end: "2026-02-05" }, // 5 days, gap 50 to 03/27
        { start: "2025-06-01", end: "2025-06-30" }, // gap > 60 → not counted
      ],
      hets: hets([billed("2026-03-27", "2026-04-05")]), // 10 days, gap 26 to 05/01
    });
    expect(r.priorDays).toBe(25);
    expect(r.chain.map((s) => [s.source, s.start])).toEqual([
      ["internal", "2026-02-01"],
      ["hets", "2026-03-27"],
      ["internal", "2026-05-01"],
    ]);
  });

  it("never double counts days where our records and HETS overlap; our records win for our stay", () => {
    const r = run({
      internalStays: [{ start: "2026-01-10", end: "2026-01-30", ref: "adm-1" }],
      // HETS reports our own stay (one day longer) and another hospice the week before it (sharing 01/10).
      hets: hets([billed("2026-01-10", "2026-01-31", OUR_NPI), billed("2026-01-03", "2026-01-10")]),
      ownProviderNpis: [OUR_NPI],
    });
    // 01/03–01/09 at the other hospice (7) + our 01/10–01/30 (21); HETS's extra 01/31 for OUR NPI is ignored.
    expect(r.priorDays).toBe(28);
    expect(r.chain).toEqual([
      expect.objectContaining({ source: "hets", hospiceNpi: OTHER_NPI, countedDays: 7 }),
      expect.objectContaining({ source: "internal", countedDays: 21 }),
    ]);
  });

  it("without our NPIs, a HETS row overlapping our stay by 2+ days is read as that same stay", () => {
    const r = run({
      internalStays: [{ start: "2026-01-10", end: "2026-01-30" }],
      hets: hets([billed("2026-01-10", "2026-01-31", OUR_NPI)]),
    });
    expect(r.priorDays).toBe(21);
    expect(r.chain).toHaveLength(1);
  });

  it("a transfer is continuous: the hand-off day is counted once and the new stay starts the next count day", () => {
    // Transferred to us on 02/16: the other hospice's period runs to (and past) the transfer day in CWF.
    const r = run({ hets: hets([billed("2026-01-20", "2026-04-19")]) });
    expect(r.priorDays).toBe(27); // 01/20 – 02/15
    expect(r.chain[0]).toMatchObject({ end: "2026-02-15" });
    expect(r.daysSinceLastCare).toBe(1);
  });

  it("ignores HETS rows for the new election itself (start on/after the election date)", () => {
    const r = run({
      hets: hets([
        { kind: "election", startDate: "2026-02-16", endDate: null, hospiceNpi: OUR_NPI },
      ]),
    });
    expect(r.priorDays).toBe(0);
    expect(r.warnings).toEqual([]);
  });
});

describe("computeRhcCarryOver — uncertain histories (conservative, with warnings)", () => {
  it("an unbilled election at another hospice is assumed to run until the next known care", () => {
    const r = run({
      hets: hets([
        { kind: "election", startDate: "2026-02-01", endDate: null, hospiceNpi: OTHER_NPI },
      ]),
    });
    expect(r.priorDays).toBe(15); // 02/01 – 02/15
    expect(r.chain[0]).toMatchObject({ kind: "election", endAssumed: true });
    expect(r.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(["hets_unbilled_election", "open_span_assumed_continuous"]),
    );
  });

  it("a NOE inside a billed period adds nothing and raises no warning", () => {
    const r = run({
      hets: hets([
        { kind: "election", startDate: "2026-01-01", endDate: null, hospiceNpi: OTHER_NPI },
        billed("2026-01-01", "2026-01-10"),
      ]),
    });
    expect(r.priorDays).toBe(10);
    expect(r.warnings).toEqual([]);
  });

  it("a billed period with no end ends at start + days used − 1", () => {
    const r = run({
      hets: hets([{ ...billed("2026-01-01", null), daysUsed: 12 }]),
    });
    expect(r.priorDays).toBe(12);
    expect(r.warnings.map((w) => w.code)).toEqual(["hets_end_from_days_used"]);
  });

  it("a truncated history whose chain reaches its oldest row is flagged as a minimum", () => {
    const r = run({ hets: hets([billed("2026-01-01", "2026-01-10")], { truncated: true }) });
    expect(r.priorDays).toBe(10);
    expect(r.warnings.map((w) => w.code)).toEqual(["hets_history_truncated"]);
  });

  it("a truncated history does not matter once the chain stops on a gap", () => {
    const r = run({ hets: hets([billed("2025-01-01", "2025-01-10")], { truncated: true }) });
    expect(r.warnings).toEqual([]);
  });

  it("a stale check is merged under basis hets_stale with a warning", () => {
    const r = run({ hets: hets([billed("2026-01-01", "2026-01-10")], { stale: true }) });
    expect(r.basis).toBe("hets_stale");
    expect(r.priorDays).toBe(10);
    expect(r.warnings.map((w) => w.code)).toEqual(["hets_stale"]);
  });

  it("our stay with no recorded ending is assumed continuous up to the new election", () => {
    const r = run({ internalStays: [{ start: "2026-02-01", end: null }] });
    expect(r.priorDays).toBe(15);
    expect(r.warnings.map((w) => w.code)).toEqual(["open_span_assumed_continuous"]);
  });
});

describe("computeRhcCarryOver — the 60-day cap", () => {
  it("caps at 60 (no high-rate day left) and stops walking", () => {
    const r = run({
      electionDate: "2026-06-01",
      internalStays: [{ start: "2026-03-01", end: "2026-05-20" }],
      hets: hets([billed("2026-01-01", "2026-02-20")]),
    });
    expect(r.chainDays).toBe(81);
    expect(r.priorDays).toBe(60);
    expect(r.chain).toHaveLength(1); // the HETS period is never reached
  });
});

describe("computeRhcCarryOver — a transfer-in's sending hospice span (8xC, ch. 11 §20.1.3)", () => {
  const sending = {
    start: "2026-01-20",
    end: "2026-02-16",
    ref: "adm-xfer",
    atOtherHospice: true,
    hospiceNpi: OTHER_NPI,
  } as const;

  it("counts the sending hospice's inherited-period days up to the day before the transfer date", () => {
    // Arrange / Act — transfer-in on 02/16 (= our day 1); the sending hospice ran 01/20 … 02/16.
    const r = run({ internalStays: [sending] });
    // Assert — the shared hand-off day is our day 1, so 01/20 … 02/15 = 27 days carry.
    expect(r.priorDays).toBe(27);
    expect(r.chain).toEqual([
      expect.objectContaining({
        source: "internal",
        kind: "sending_hospice",
        start: "2026-01-20",
        end: "2026-02-15",
        hospiceNpi: OTHER_NPI,
        countedDays: 27,
      }),
    ]);
  });

  it("keeps the sending hospice's HETS row (not taken as our stay) and never double counts the overlap", () => {
    // Arrange — HETS shows the sending hospice's billed period from 01/01 (an earlier start than M6 recorded).
    const r = run({
      internalStays: [sending],
      hets: hets([billed("2026-01-01", "2026-02-16")]),
    });
    // Assert — 01/01 … 02/15 = 46 days, each counted once.
    expect(r.priorDays).toBe(46);
    expect(r.chainDays).toBe(46);
    expect(r.chain.reduce((n, s) => n + s.countedDays, 0)).toBe(46);
    expect(r.chain.some((s) => s.source === "hets")).toBe(true);
  });

  it("an own stay overlapping the same HETS row still drops it (our dates win)", () => {
    const r = run({
      internalStays: [{ start: "2026-01-01", end: "2026-02-10", ref: "adm-ours" }],
      hets: hets([billed("2026-01-01", "2026-02-10")]),
    });
    expect(r.chain.every((s) => s.source === "internal")).toBe(true);
  });
});
