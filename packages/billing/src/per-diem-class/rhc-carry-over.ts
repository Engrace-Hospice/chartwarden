// @wardenx/billing — the two-tier RHC day-count CARRY-OVER across hospice stays (ours AND other hospices').
// PURE: no clock, no I/O. Feeds `calculatePerDiemClass`'s `priorHospiceDays`.
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
// BOUNDED INPUT (the HETS rows are an EXTERNAL response — treated as untrusted):
//   - a row whose start is unparseable or outside [Medicare's 1965-07-30 start, election + the 4-month HETS look-ahead]
//     is ignored; an unparseable / out-of-range / inverted end is treated as unknown (closed conservatively); a
//     non-integer or absurd days-used count is ignored — each class raises one aggregated warning;
//   - at most the HETS maximum of 360 rows (180 NOEs + 180 billed periods) is considered, the most recent first;
//   - every span is clipped to end the day before the new election before merging, and the day attribution is
//     interval arithmetic — the work is O(n log n)-ish in the row count and independent of a span's LENGTH.
//
// SHARED CORE: the clip / merge / walk-back rule (1–3 above, + the 60-day stop) is `@wardenx/shared/rhc`, the one
// implementation M6's own fallback count (`rhcCarryOver`, which may not import this package) uses too.
import {
  type CarryBlock,
  RHC_CARRY_OVER_MAX_GAP_DAYS,
  clipToBeforeElection,
  mergeCarryBlocks,
  walkCarryChain,
} from "@wardenx/shared/rhc";
import type { IsoDate } from "../contracts";
import { fromEpochDay, toEpochDay } from "../domain/dates";
import { RHC_HIGH_TIER_LAST_DAY } from "./calculator";

/** Max gap (days from a stay's last day to the next stay's first day) that still continues the count. */
export { RHC_CARRY_OVER_MAX_GAP_DAYS };
/** Two hospices may share exactly one day (the transfer day); a longer overlap is the same stay. */
const SAME_STAY_MIN_OVERLAP_DAYS = 2;
/** Medicare began 1965-07-30 (no hospice day can precede it); the floor of a sane HETS date. */
export const RHC_EARLIEST_SANE_DATE: IsoDate = "1965-07-30";
/** HETS answers up to four months past the request date; the ceiling of a sane HETS date past the election. */
export const RHC_HETS_LOOK_AHEAD_DAYS = 124;
/** HETS returns at most 180 NOEs + 180 billed periods (HETS2024-1); more rows than this is a malformed answer. */
export const RHC_HETS_MAX_ROWS = 360;
/** A days-used count beyond a century is not a hospice benefit period. */
const MAX_SANE_DAYS_USED = 36_500;

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
  | "hets_stale"
  | "hets_row_ignored"
  | "hets_end_ignored"
  | "hets_rows_capped";

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
  /** `sending_hospice` = a transfer-in's sending hospice span recorded by us (`atOtherHospice`). */
  readonly kind: "stay" | "sending_hospice" | "election" | "benefit_period";
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

/** The epoch day of a strict `YYYY-MM-DD`, or null when it is not one (never NaN, never a throw). */
function safeEpochDay(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  try {
    const day = toEpochDay(iso);
    return Number.isInteger(day) ? day : null;
  } catch {
    return null;
  }
}

/** A sane end for a span starting on `start`: parseable, in range and not before the start; else null. */
function saneEnd(end: unknown, start: number, maxDay: number): number | null {
  const day = safeEpochDay(end);
  return day !== null && day >= start && day <= maxDay ? day : null;
}

function internalSpans(stays: readonly RhcInternalStay[], maxDay: number): Span[] {
  return stays.flatMap((s): Span[] => {
    const start = safeEpochDay(s.start);
    if (start === null) return [];
    return [
      {
        source: "internal",
        kind: s.atOtherHospice ? "sending_hospice" : "stay",
        start,
        end: saneEnd(s.end, start, maxDay),
        endAssumedFromDaysUsed: false,
        hospiceNpi: s.atOtherHospice ? (s.hospiceNpi ?? null) : null,
        ref: s.ref ?? null,
        priority: 0,
        ownStay: s.atOtherHospice !== true,
      },
    ];
  });
}

/** A HETS row with its dates parsed and bounded (see the header's BOUNDED INPUT). */
interface SaneHetsRow {
  readonly kind: RhcHetsPeriod["kind"];
  readonly start: number;
  readonly end: number | null;
  readonly daysUsed: number | null;
  readonly hospiceNpi: string | null;
}

/** Parse, bound and cap the external HETS rows; warn once per class of row it had to drop or repair. */
function saneHetsRows(
  periods: readonly RhcHetsPeriod[],
  minDay: number,
  maxDay: number,
  warn: (w: RhcCarryOverWarning) => void,
): SaneHetsRow[] {
  let ignored = 0;
  let endsIgnored = 0;
  const rows: SaneHetsRow[] = [];
  for (const p of periods) {
    const start = safeEpochDay(p.startDate);
    if (start === null || start < minDay || start > maxDay) {
      ignored += 1;
      continue;
    }
    const end = p.endDate === null ? null : saneEnd(p.endDate, start, maxDay);
    if (p.endDate !== null && end === null) endsIgnored += 1;
    const daysUsed =
      typeof p.daysUsed === "number" &&
      Number.isInteger(p.daysUsed) &&
      p.daysUsed > 0 &&
      p.daysUsed <= MAX_SANE_DAYS_USED
        ? p.daysUsed
        : null;
    rows.push({ kind: p.kind, start, end, daysUsed, hospiceNpi: p.hospiceNpi ?? null });
  }
  if (ignored > 0) {
    warn({
      code: "hets_row_ignored",
      message: `${ignored} HETS hospice record(s) were ignored: the start date is unreadable or outside ${RHC_EARLIEST_SANE_DATE} … ${fromEpochDay(maxDay)}.`,
    });
  }
  if (endsIgnored > 0) {
    warn({
      code: "hets_end_ignored",
      message: `${endsIgnored} HETS hospice record(s) had an unreadable or impossible end date; each is treated as having no end (the conservative reading).`,
    });
  }
  if (rows.length <= RHC_HETS_MAX_ROWS) return rows;
  warn({
    code: "hets_rows_capped",
    message: `HETS returned ${rows.length} hospice records, more than its ${RHC_HETS_MAX_ROWS}-record maximum; only the ${RHC_HETS_MAX_ROWS} most recent were counted.`,
  });
  return [...rows].sort((a, b) => b.start - a.start).slice(0, RHC_HETS_MAX_ROWS);
}

function hetsSpans(
  rows: readonly SaneHetsRow[],
  recorded: readonly Span[],
  ownNpis: ReadonlySet<string>,
): Span[] {
  // Only OUR stays can make a HETS row a duplicate; a recorded other-hospice span (a transfer-in's sending
  // hospice) overlapping a HETS row is that hospice's own record — both are kept and their days merge.
  const internal = recorded.filter((s) => s.ownStay);
  const billed: Span[] = rows
    .filter((p) => p.kind === "benefit_period")
    .map((p) => {
      const fromDaysUsed = p.end === null && p.daysUsed !== null ? p.start + p.daysUsed - 1 : null;
      return {
        source: "hets",
        kind: "benefit_period",
        start: p.start,
        end: p.end ?? fromDaysUsed,
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
  const unbilledNoes: Span[] = rows
    .filter((p) => p.kind === "election" && !covered(p.start))
    .map((p) => ({
      source: "hets",
      kind: "election",
      start: p.start,
      end: p.end,
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

/** The first index of the ascending `sorted` whose value is > `value` (`sorted.length` when none). */
function firstIndexAbove(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as number) > value) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Resolve open ends: assume care ran until the day before the next known care (or the new election). */
function closeOpenSpans(
  spans: readonly Span[],
  electionDay: number,
  warn: (w: RhcCarryOverWarning) => void,
): (Span & { end: number; endAssumed: boolean })[] {
  const starts = spans.map((o) => o.start).sort((a, b) => a - b);
  return spans.map((s) => {
    if (s.end !== null) return { ...s, end: s.end, endAssumed: s.endAssumedFromDaysUsed };
    // The first known start after this one (binary search over the sorted starts — no spread of an
    // unbounded array into Math.min).
    const next = starts[firstIndexAbove(starts, s.start)];
    const nextStart = next !== undefined && next < electionDay ? next : electionDay;
    warn({
      code: "open_span_assumed_continuous",
      message: `The ${s.source === "internal" ? "earlier stay with us" : "HETS hospice record"} starting ${fromEpochDay(s.start)} has no end date; it is assumed to have run until ${fromEpochDay(nextStart - 1)} (the conservative reading — it can only lower the high-rate days).`,
    });
    return { ...s, end: nextStart - 1, endAssumed: true };
  });
}

type ClosedSpan = Span & { end: number; endAssumed: boolean };
type Block = CarryBlock<ClosedSpan>;

/**
 * The days each member owns when every calendar day goes to ONE member: lower `priority` first, then the earlier
 * start, then input order (the order the per-day reference walk used). Interval arithmetic over the union of the
 * ranges already owned — the cost depends on the NUMBER of members, never on how many days a range spans.
 * @internal exported for the equivalence test.
 */
export function attributeOwnedDays(
  members: readonly { readonly start: number; readonly end: number; readonly priority: number }[],
): number[] {
  const ranked = members
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.priority - b.m.priority || a.m.start - b.m.start || a.i - b.i);
  const counted = members.map(() => 0);
  // Disjoint owned ranges, ascending by start.
  let owned: { start: number; end: number }[] = [];
  for (const { m, i } of ranked) {
    if (m.end < m.start) continue;
    // The first owned range that ends at or after this member's start.
    let lo = 0;
    let hi = owned.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((owned[mid] as { end: number }).end < m.start) lo = mid + 1;
      else hi = mid;
    }
    let j = lo;
    let alreadyOwned = 0;
    let mergedStart = m.start;
    let mergedEnd = m.end;
    while (j < owned.length && (owned[j] as { start: number }).start <= m.end) {
      const o = owned[j] as { start: number; end: number };
      alreadyOwned += Math.min(o.end, m.end) - Math.max(o.start, m.start) + 1;
      mergedStart = Math.min(mergedStart, o.start);
      mergedEnd = Math.max(mergedEnd, o.end);
      j += 1;
    }
    counted[i] = m.end - m.start + 1 - alreadyOwned;
    owned = [...owned.slice(0, lo), { start: mergedStart, end: mergedEnd }, ...owned.slice(j)];
  }
  return counted;
}

/** Attribute each day of a block to one member (our records first, then billed periods, then NOEs). */
function attribute(block: Block): RhcCountedSpan[] {
  const counted = attributeOwnedDays(block.members);
  return block.members
    .map((m, i) => ({
      source: m.source,
      kind: m.kind,
      start: fromEpochDay(m.start),
      end: fromEpochDay(m.end),
      endAssumed: m.endAssumed,
      countedDays: counted[i] ?? 0,
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

  const minDay = toEpochDay(RHC_EARLIEST_SANE_DATE);
  const maxDay = electionDay + RHC_HETS_LOOK_AHEAD_DAYS;
  const ours = internalSpans(input.internalStays, maxDay);
  const theirs = input.hets
    ? hetsSpans(
        saneHetsRows(input.hets.periods, minDay, maxDay, warn),
        ours,
        new Set(input.ownProviderNpis ?? []),
      )
    : [];
  // Only care BEFORE the new election is prior; clip each span to the day before it.
  const prior = [...ours, ...theirs]
    .filter((s) => s.start < electionDay)
    .map((s) => (s.end !== null && s.end >= electionDay ? { ...s, end: electionDay - 1 } : s));
  warnHetsRows(prior, warn);
  // An assumed end never passes the election either (the shared clip, rule 1).
  const closed = clipToBeforeElection(closeOpenSpans(prior, electionDay, warn), electionDay);
  const walked = walkCarryChain(mergeCarryBlocks(closed), electionDay);
  const chain: RhcCountedSpan[] = walked.blocks.flatMap(attribute);
  const total = walked.totalDays;
  if (input.hets?.truncated && walked.reachedOldest && chain.length > 0) {
    warn({
      code: "hets_history_truncated",
      message:
        "HETS returned its maximum number of hospice records; older periods may be missing, so the carried days are a minimum.",
    });
  }
  return {
    priorDays: Math.min(total, RHC_HIGH_TIER_LAST_DAY),
    chainDays: total,
    chain,
    basis,
    warnings,
    daysSinceLastCare: walked.latestEnd === null ? null : electionDay - walked.latestEnd,
  };
}
