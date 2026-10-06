// @wardenx/billing — the two-tier RHC day-count CARRY-OVER across hospice stays (ours AND other hospices').
// PURE: no clock, no I/O. Feeds `calculateHipps`'s `priorHospiceDays`.
//
// CMS RULE (Medicare Claims Processing Manual, Pub. 100-04, ch. 11 §30.2; CR 9201 / Transmittal R3326CP):
//   - "A hospice day billed at the RHC level in the first 60 days of a hospice election is paid at the high RHC
//     rate … Medicare systems count 60 days from the date of admission regardless of whether some days are
//     covered or non-covered."
//   - "For a hospice patient that is discharged and readmitted to hospice services within 60 days of the
//     discharge, the hospice days will continue to follow the patient. If the hospice patient is discharged
//     from hospice care for more than 60 days a new election to hospice will initiate a reset of the patient's
//     60-day window." R3326CP §I.B.4 adds the prior days "count toward his/her patient days for the RECEIVING
//     hospice" — so days at ANOTHER hospice count (CWF is beneficiary-level), and the Pricer is fed "the number
//     of days from a prior hospice benefit period if identified by CWF as part of the first 60 days of RHC"
//     (ch. 11 Pricer input record, positions 65-66). Medicare computes the carry itself; ours must MATCH it.
//   - Manual example: elected 01/10, revoked 01/30 → "accounts for 21 days" (BOTH ends inclusive — the
//     revocation/discharge day is a hospice day), re-elected 02/16 → "an additional 39 days", day 61 on 03/27.
//
// COUNTING RULE IMPLEMENTED
//   1. Every prior span counts its days INCLUSIVELY (start … end). Spans are clipped to end the day BEFORE the
//      new election (a transfer's hand-off day is billed by both hospices but is one beneficiary day, and is
//      day 1 of the new stay), and a span starting on/after the new election is not "prior".
//   2. Overlapping or touching spans merge into one continuous block (a same-day / next-day transfer is
//      continuous care, no gap) — a calendar day is never counted twice.
//   3. Walk back from the new election: a block continues the count when (next start − block end) ≤ 60 days
//      ("readmitted within 60 days of the discharge"); the first larger gap stops the walk (the window reset).
//   4. The result is capped at 60: at 60 or more prior days no high-rate day is left, more is irrelevant.
//   AMBIGUITY (flagged, documented reading implemented): "within 60 days of the discharge" (readmit date ≤
//   discharge + 60) and "discharged … for more than 60 days" (days strictly between > 60) differ by exactly one
//   day — a readmission 61 days after the discharge date. We implement the first (gap of 61 → reset).
//
// MERGE OF OUR RECORDS WITH HETS (CWF) — each HETS row is a NOE ("election", a single date) or a billed
// benefit period. Preference: our own records for our stays; HETS for other hospices.
//   - A HETS row from one of OUR NPIs (or, when our NPIs are not supplied, one overlapping one of our stays by
//     2+ days — two hospices can only share a transfer day) that overlaps our stay is dropped: our dates win.
//   - Other HETS rows are kept; their days overlapping ours are attributed to our stay (never double counted).
//   - A NOE with no billed period covering its date is an UNBILLED election (claims lag): its end is unknown.
// CONSERVATIVE CHOICES (documented, each raises a warning):
//   - An open-ended span (no end date: an unbilled NOE, or our stay with no recorded ending) is assumed to have
//     run until the day before the next known care (another span or the new election). Over-counting prior
//     days only moves days to the LOW rate, so the expected payment is never overstated.
//   - A billed HETS period with no end but a days-used count ends at start + daysUsed − 1.
//   - A TRUNCATED HETS history (the 180-row cap) whose chain reaches its oldest row is a LOWER bound.
//   - A stale HETS check is still merged (basis `hets_stale`); the caller decides how to warn.
import type { IsoDate } from "../contracts";
import { fromEpochDay, toEpochDay } from "../domain/dates";
import { RHC_HIGH_TIER_LAST_DAY } from "./calculator";

/** Max gap (days from a stay's last day to the next stay's first day) that still continues the count. */
export const RHC_CARRY_OVER_MAX_GAP_DAYS = 60;
/** Two hospices may share exactly one day (the transfer day); a longer overlap is the same stay. */
const SAME_STAY_MIN_OVERLAP_DAYS = 2;

export type RhcCarryOverSource = "internal" | "hets";
export type RhcCarryOverBasis = "internal_only" | "hets_merged" | "hets_stale";

/** One of OUR earlier stays (M6). */
export interface RhcInternalStay {
  readonly start: IsoDate | null;
  /** The stay-ending date (discharge / revocation / transfer); null when no ending is recorded. */
  readonly end: IsoDate | null;
  /** An opaque reference shown back to the biller (the admission id). */
  readonly ref?: string | null;
  /**
   * The days were at ANOTHER hospice but are on our records — a transfer-in's sending hospice (the inherited
   * period up to the transfer date). Counted like our stays, but never taken as "our stay" when deciding whether a
   * HETS row duplicates one of ours (that row is the other hospice's, its days merge without double counting).
   */
  readonly atOtherHospice?: boolean;
  /** The other hospice's NPI, when `atOtherHospice` and captured. */
  readonly hospiceNpi?: string | null;
}

/** One HETS 271 hospice row (`eligibility_check.parsed_payload.hospicePeriods[]`). */
export interface RhcHetsPeriod {
  readonly kind: "election" | "benefit_period";
  readonly startDate: IsoDate;
  readonly endDate: IsoDate | null;
  readonly hospiceNpi: string | null;
  readonly daysUsed?: number | null;
}

export interface RhcHetsHistory {
  /** The check is past its freshness window. */
  readonly stale: boolean;
  /** HETS hit its return cap — older rows may be missing. */
  readonly truncated: boolean;
  readonly periods: readonly RhcHetsPeriod[];
}

export interface RhcCarryOverInput {
  /** The new election / admission date (day 1 of the stay being billed, before the carry). */
  readonly electionDate: IsoDate;
  readonly internalStays: readonly RhcInternalStay[];
  /** null when no usable HETS hospice history is on file. */
  readonly hets: RhcHetsHistory | null;
  /** Our own billing NPIs (HETS rows from these are our stays). Optional; see the header. */
  readonly ownProviderNpis?: readonly string[];
}

export type RhcCarryOverWarningCode =
  | "open_span_assumed_continuous"
  | "hets_unbilled_election"
  | "hets_end_from_days_used"
  | "hets_history_truncated"
  | "hets_stale";

export interface RhcCarryOverWarning {
  readonly code: RhcCarryOverWarningCode;
  readonly message: string;
}

/** A span the count used, with the days attributed to it (overlaps go to our records first). */
export interface RhcCountedSpan {
  readonly source: RhcCarryOverSource;
  readonly start: IsoDate;
  /** The last day counted (clipped to the day before the new election; assumed when `endAssumed`). */
  readonly end: IsoDate;
  readonly endAssumed: boolean;
  readonly countedDays: number;
  readonly hospiceNpi: string | null;
  readonly kind: "stay" | "election" | "benefit_period";
  readonly ref: string | null;
}

export interface RhcCarryOverResult {
  /** Prior hospice days carried into the new stay's RHC count, capped at 60. */
  readonly priorDays: number;
  /** The uncapped day total of the counted chain (≥ priorDays). */
  readonly chainDays: number;
  readonly chain: readonly RhcCountedSpan[];
  readonly basis: RhcCarryOverBasis;
  readonly warnings: readonly RhcCarryOverWarning[];
  /** Days from the most recent prior day of care to the new election (null with no prior care). */
  readonly daysSinceLastCare: number | null;
}

interface Span {
  readonly source: RhcCarryOverSource;
  readonly kind: RhcCountedSpan["kind"];
  readonly start: number;
  /** null = open-ended (resolved below). */
  readonly end: number | null;
  readonly endAssumedFromDaysUsed: boolean;
  readonly hospiceNpi: string | null;
  readonly ref: string | null;
  /** Lower = wins a shared day. */
  readonly priority: number;
  /** One of OUR stays (not a recorded other-hospice span); only these make a HETS row a duplicate. */
  readonly ownStay: boolean;
}

const overlapDays = (a: Span, b: Span): number => {
  if (a.end === null || b.end === null) {
    const aEnd = a.end ?? Number.POSITIVE_INFINITY;
    const bEnd = b.end ?? Number.POSITIVE_INFINITY;
    return Math.max(0, Math.min(aEnd, bEnd) - Math.max(a.start, b.start) + 1);
  }
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start) + 1);
};

function internalSpans(stays: readonly RhcInternalStay[]): Span[] {
  return stays
    .filter((s): s is RhcInternalStay & { start: IsoDate } => s.start !== null)
    .map((s) => ({
      source: "internal",
      kind: "stay",
      start: toEpochDay(s.start),
      end: s.end ? toEpochDay(s.end) : null,
      endAssumedFromDaysUsed: false,
      hospiceNpi: s.atOtherHospice ? (s.hospiceNpi ?? null) : null,
      ref: s.ref ?? null,
      priority: 0,
      ownStay: s.atOtherHospice !== true,
    }));
}

function hetsSpans(
  hets: RhcHetsHistory,
  recorded: readonly Span[],
  ownNpis: ReadonlySet<string>,
): Span[] {
  // Only OUR stays can make a HETS row a duplicate; a recorded other-hospice span (a transfer-in's sending
  // hospice) overlapping a HETS row is that hospice's own record — both are kept and their days merge.
  const internal = recorded.filter((s) => s.ownStay);
  const billed: Span[] = hets.periods
    .filter((p) => p.kind === "benefit_period")
    .map((p) => {
      const start = toEpochDay(p.startDate);
      const fromDaysUsed =
        p.endDate === null && typeof p.daysUsed === "number" && p.daysUsed > 0
          ? start + p.daysUsed - 1
          : null;
      return {
        source: "hets",
        kind: "benefit_period",
        start,
        end: p.endDate ? toEpochDay(p.endDate) : fromDaysUsed,
        endAssumedFromDaysUsed: fromDaysUsed !== null,
        hospiceNpi: p.hospiceNpi,
        ref: null,
        priority: 1,
        ownStay: false,
      };
    });
  const covered = (day: number): boolean =>
    billed.some((b) => day >= b.start && (b.end === null || day <= b.end));
  // A NOE inside a billed period adds nothing; one outside every billed period is an unbilled election.
  const unbilledNoes: Span[] = hets.periods
    .filter((p) => p.kind === "election" && !covered(toEpochDay(p.startDate)))
    .map((p) => ({
      source: "hets",
      kind: "election",
      start: toEpochDay(p.startDate),
      end: p.endDate ? toEpochDay(p.endDate) : null,
      endAssumedFromDaysUsed: false,
      hospiceNpi: p.hospiceNpi,
      ref: null,
      priority: 2,
      ownStay: false,
    }));
  const isOurs = (s: Span): boolean => {
    if (s.hospiceNpi !== null && ownNpis.has(s.hospiceNpi)) return true;
    // Without our NPIs, a 2+ day overlap with one of our stays can only be that same stay.
    return (
      ownNpis.size === 0 && internal.some((i) => overlapDays(i, s) >= SAME_STAY_MIN_OVERLAP_DAYS)
    );
  };
  return [...billed, ...unbilledNoes].filter(
    (s) => !(isOurs(s) && internal.some((i) => overlapDays(i, s) > 0)),
  );
}

/** The per-row HETS warnings, raised only for rows that are actually prior care. */
function warnHetsRows(spans: readonly Span[], warn: (w: RhcCarryOverWarning) => void): void {
  for (const s of spans) {
    if (s.source !== "hets") continue;
    if (s.endAssumedFromDaysUsed) {
      warn({
        code: "hets_end_from_days_used",
        message: `HETS reports no end for the period starting ${fromEpochDay(s.start)}; its end was taken from the days-used count.`,
      });
    }
    if (s.kind === "election" && s.end === null) {
      warn({
        code: "hets_unbilled_election",
        message: `HETS shows an election on ${fromEpochDay(s.start)}${s.hospiceNpi ? ` (NPI ${s.hospiceNpi})` : ""} with no billed period yet; its end date is unknown.`,
      });
    }
  }
}

/** Resolve open ends: assume care ran until the day before the next known care (or the new election). */
function closeOpenSpans(
  spans: readonly Span[],
  electionDay: number,
  warn: (w: RhcCarryOverWarning) => void,
): (Span & { end: number; endAssumed: boolean })[] {
  return spans.map((s) => {
    if (s.end !== null) return { ...s, end: s.end, endAssumed: s.endAssumedFromDaysUsed };
    const nextStart = Math.min(
      electionDay,
      ...spans.filter((o) => o.start > s.start).map((o) => o.start),
    );
    warn({
      code: "open_span_assumed_continuous",
      message: `The ${s.source === "internal" ? "earlier stay with us" : "HETS hospice record"} starting ${fromEpochDay(s.start)} has no end date; it is assumed to have run until ${fromEpochDay(nextStart - 1)} (the conservative reading — it can only lower the high-rate days).`,
    });
    return { ...s, end: nextStart - 1, endAssumed: true };
  });
}

interface Block {
  start: number;
  end: number;
  members: (Span & { end: number; endAssumed: boolean })[];
}

function mergeBlocks(spans: readonly (Span & { end: number; endAssumed: boolean })[]): Block[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const blocks: Block[] = [];
  for (const s of sorted) {
    const last = blocks.at(-1);
    // Touching (next day) or overlapping → continuous care.
    if (last && s.start <= last.end + 1) {
      blocks[blocks.length - 1] = {
        start: last.start,
        end: Math.max(last.end, s.end),
        members: [...last.members, s],
      };
    } else {
      blocks.push({ start: s.start, end: s.end, members: [s] });
    }
  }
  return blocks;
}

/** Attribute each day of a block to one member (our records first, then billed periods, then NOEs). */
function attribute(block: Block): RhcCountedSpan[] {
  const owner = new Map<number, number>();
  const ranked = block.members
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.priority - b.m.priority || a.m.start - b.m.start);
  for (const { m, i } of ranked) {
    for (let d = m.start; d <= m.end; d++) if (!owner.has(d)) owner.set(d, i);
  }
  return block.members
    .map((m, i) => ({
      source: m.source,
      kind: m.kind,
      start: fromEpochDay(m.start),
      end: fromEpochDay(m.end),
      endAssumed: m.endAssumed,
      countedDays: [...owner.values()].filter((o) => o === i).length,
      hospiceNpi: m.hospiceNpi,
      ref: m.ref,
    }))
    .filter((s) => s.countedDays > 0);
}

/**
 * The prior hospice days (ours + other hospices' per HETS) that carry into the RHC day count of a new election
 * on `electionDate`. See the header for the CMS rule, the counting rule and the conservative choices.
 */
export function computeRhcCarryOver(input: RhcCarryOverInput): RhcCarryOverResult {
  const electionDay = toEpochDay(input.electionDate);
  const warnings: RhcCarryOverWarning[] = [];
  const warn = (w: RhcCarryOverWarning): void => {
    if (!warnings.some((x) => x.code === w.code && x.message === w.message)) warnings.push(w);
  };
  const basis: RhcCarryOverBasis =
    input.hets === null ? "internal_only" : input.hets.stale ? "hets_stale" : "hets_merged";
  if (input.hets?.stale) {
    warn({
      code: "hets_stale",
      message:
        "The HETS eligibility check is stale; other hospices' recent days may be missing — refresh it.",
    });
  }

  const ours = internalSpans(input.internalStays);
  const theirs = input.hets
    ? hetsSpans(input.hets, ours, new Set(input.ownProviderNpis ?? []))
    : [];
  // Only care BEFORE the new election is prior; clip each span to the day before it.
  const prior = [...ours, ...theirs]
    .filter((s) => s.start < electionDay)
    .map((s) => (s.end !== null && s.end >= electionDay ? { ...s, end: electionDay - 1 } : s));
  warnHetsRows(prior, warn);
  const closed = closeOpenSpans(prior, electionDay, warn).map((s) =>
    s.end >= electionDay ? { ...s, end: electionDay - 1 } : s,
  );
  const blocks = mergeBlocks(closed);

  const chain: RhcCountedSpan[] = [];
  let total = 0;
  let cursor = electionDay;
  let reachedOldest = true;
  for (const block of [...blocks].reverse()) {
    if (cursor - block.end > RHC_CARRY_OVER_MAX_GAP_DAYS) {
      reachedOldest = false;
      break;
    }
    total += block.end - block.start + 1;
    chain.unshift(...attribute(block));
    cursor = block.start;
    if (total >= RHC_HIGH_TIER_LAST_DAY) {
      reachedOldest = false;
      break;
    }
  }
  if (input.hets?.truncated && reachedOldest && chain.length > 0) {
    warn({
      code: "hets_history_truncated",
      message:
        "HETS returned its maximum number of hospice records; older periods may be missing, so the carried days are a minimum.",
    });
  }
  const latest = blocks.at(-1);
  return {
    priorDays: Math.min(total, RHC_HIGH_TIER_LAST_DAY),
    chainDays: total,
    chain,
    basis,
    warnings,
    daysSinceLastCare: latest ? electionDay - latest.end : null,
  };
}
