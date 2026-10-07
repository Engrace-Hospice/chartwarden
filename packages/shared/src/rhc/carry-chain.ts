// @wardenx/shared/rhc — the two-tier RHC day-count CARRY-OVER chain core (Claims Processing Manual, Pub. 100-04,
// ch. 11 §30.2; CR 9201 / Transmittal R3326CP). PURE: no clock, no I/O, integer epoch days only.
//
// One implementation of the counting rule for its two callers, which sit in modules that may not import each
// other: @wardenx/billing's `computeRhcCarryOver` (M23 — merges our stays with the HETS cross-hospice history,
// attributes days, warns) and M6's `rhcCarryOver` (intake/benefit-period.ts — the readmission screen and the
// claim-range seam's fallback count, over our own records incl. a transfer-in's sending-hospice span). The CMS
// citations and the conservative choices are documented on `computeRhcCarryOver`; the rule itself:
//   1. Spans are inclusive (start … end). A span is clipped to end the day before the new election (a transfer's
//      hand-off day is billed by both hospices but is ONE beneficiary day, day 1 of the new stay); a span starting
//      on/after the election is not prior care.
//   2. Overlapping or next-day spans merge into one block — a calendar day is never counted twice.
//   3. Walk back from the election: a block continues the count when (next start − block end) ≤ 60 days; the
//      first larger gap resets the window. The walk stops once the 60-day high tier is used up.

/** Max gap (days from a stay's last day to the next stay's first day) that still continues the count. */
export const RHC_CARRY_OVER_MAX_GAP_DAYS = 60;
/** The RHC high rate covers days 1–60 of the (carried) day count. */
export const RHC_HIGH_TIER_LAST_DAY = 60;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** The UTC epoch day of a strict, real `YYYY-MM-DD` calendar date; null for anything else (never NaN / a throw). */
export function isoDateToEpochDay(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const match = ISO_DATE_RE.exec(iso);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return Math.floor(ms / MS_PER_DAY);
}

/** An inclusive run of hospice days, as epoch days. */
export interface CarryDaySpan {
  readonly start: number;
  readonly end: number;
}

/** Overlapping / touching spans merged into one run of continuous care. */
export interface CarryBlock<T extends CarryDaySpan> {
  readonly start: number;
  readonly end: number;
  readonly members: readonly T[];
}

export interface CarryChain<T extends CarryDaySpan> {
  /** The blocks the count continues through, oldest first. */
  readonly blocks: readonly CarryBlock<T>[];
  /** The days of those blocks (uncapped; ≥ 60 means no high-rate day is left). */
  readonly totalDays: number;
  /** The walk reached the oldest block (no gap reset and the high tier not used up before it). */
  readonly reachedOldest: boolean;
  /** The last prior day of care of ANY block (null with no prior care) — even one past a gap reset. */
  readonly latestEnd: number | null;
}

/** Rule 1: keep only prior care, each span ending at the latest the day before the new election. */
export function clipToBeforeElection<T extends CarryDaySpan>(
  spans: readonly T[],
  electionDay: number,
): T[] {
  return spans
    .filter((s) => s.start < electionDay)
    .map((s) => (s.end >= electionDay ? { ...s, end: electionDay - 1 } : s));
}

/** Rule 2: merge overlapping or next-day spans into blocks, ascending; each block keeps its members. */
export function mergeCarryBlocks<T extends CarryDaySpan>(spans: readonly T[]): CarryBlock<T>[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const blocks: CarryBlock<T>[] = [];
  for (const s of sorted) {
    const last = blocks.at(-1);
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

/** Rule 3: walk back from the election over ascending `blocks` (already clipped by rule 1). */
export function walkCarryChain<T extends CarryDaySpan>(
  blocks: readonly CarryBlock<T>[],
  electionDay: number,
): CarryChain<T> {
  const taken: CarryBlock<T>[] = [];
  let total = 0;
  let cursor = electionDay;
  let reachedOldest = true;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i] as CarryBlock<T>;
    if (cursor - block.end > RHC_CARRY_OVER_MAX_GAP_DAYS) {
      reachedOldest = false;
      break;
    }
    total += block.end - block.start + 1;
    taken.unshift(block);
    cursor = block.start;
    if (total >= RHC_HIGH_TIER_LAST_DAY) {
      // Older care is irrelevant once no high-rate day is left (and is not proven to be reached).
      reachedOldest = false;
      break;
    }
  }
  return {
    blocks: taken,
    totalDays: total,
    reachedOldest,
    latestEnd: blocks.at(-1)?.end ?? null,
  };
}
