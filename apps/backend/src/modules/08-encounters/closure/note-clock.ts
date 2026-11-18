// apps/backend/src/modules/08-encounters/closure/note-clock.ts — visit-note 24h closure clock (slice 1).
//
// PURE and deterministic: every instant is passed in (the cron tick / request supplies `asOf`), there is
// no `Date.now()`, no IO, no db/fastify import. SQL only finds "the member's oldest clocked open note";
// this file decides what that means, so the SQL and the rule cannot drift.
//
// For a tenant threshold T (hours, default 24) measured from `clockStartedAt` (the clinician's arrival):
//   ok        elapsed <  T - 6h
//   at_risk   elapsed >= T - 6h   (info alert)
//   overdue   elapsed >= T        (warn alert)
//   escalated elapsed >= T + 12h  (warn alert, supervisor copied)
// Elapsed time is absolute hours (no calendar/DST math). The alert stage always uses the TRUE clock;
// only the BLOCK instant (`blockFrom`) honours `enforceFrom`, the grace window a tenant gets when it
// moves to `block` so already-overdue notes are not blocked the instant the mode flips.
import { addHours, hoursBetween } from "../cosignature/sla-clock";

/** `at_risk` begins this many hours BEFORE the threshold (T - 6h). */
export const AT_RISK_LEAD_HOURS = 6;
/** `escalated` begins this many hours AFTER the threshold (T + 12h). */
export const ESCALATION_LAG_HOURS = 12;

export type NoteClosureStage = "ok" | "at_risk" | "overdue" | "escalated";
/** Per-tenant obligation mode (`documentation_obligation_mode`). */
export type NoteClosureMode = "off" | "warn" | "block";
export type ClosureVerdict = "clear" | "warn" | "blocked";

export interface NoteClosureInput {
  /**
   * The clinician's arrival instant. `null` = a legacy / un-clocked note: it never alerts and never
   * blocks (stage `ok`, no deadline, no block instant) — the caller does not backfill old drafts.
   */
  readonly clockStartedAt: Date | null;
  readonly asOf: Date;
  readonly thresholdHours: number;
  /** Set when the tenant moved to `block`; only ever delays `blockFrom`. `null`/`undefined` = no grace. */
  readonly enforceFrom?: Date | null;
}

export interface NoteClosureDecision {
  readonly stage: NoteClosureStage;
  /** `clockStartedAt + T`; `null` for an un-clocked note. */
  readonly deadlineAt: Date | null;
  /** Hours past `deadlineAt` (0 until overdue). */
  readonly hoursOverdue: number;
  /** `max(clockStartedAt, enforceFrom) + T`; `null` for an un-clocked note. Blocking uses this, alerts do not. */
  readonly blockFrom: Date | null;
}

function plusHours(instant: Date, hours: number): Date {
  return new Date(addHours(instant.toISOString(), hours));
}

function hoursFromTo(from: Date, to: Date): number {
  return hoursBetween(from.toISOString(), to.toISOString());
}

function assertValidInstant(name: string, instant: Date): void {
  if (Number.isNaN(instant.getTime())) throw new RangeError(`${name} is not a valid instant`);
}

function stageForElapsed(elapsedHours: number, thresholdHours: number): NoteClosureStage {
  if (elapsedHours >= thresholdHours + ESCALATION_LAG_HOURS) return "escalated";
  if (elapsedHours >= thresholdHours) return "overdue";
  if (elapsedHours >= thresholdHours - AT_RISK_LEAD_HOURS) return "at_risk";
  return "ok";
}

/** Decide where one note sits on its closure clock at `asOf`. Throws RangeError on an invalid instant or threshold. */
export function decideNoteClosure(input: NoteClosureInput): NoteClosureDecision {
  const { clockStartedAt, asOf, thresholdHours, enforceFrom } = input;
  if (!Number.isFinite(thresholdHours) || thresholdHours <= 0) {
    throw new RangeError("thresholdHours must be a positive finite number");
  }
  assertValidInstant("asOf", asOf);
  if (enforceFrom) assertValidInstant("enforceFrom", enforceFrom);
  if (clockStartedAt === null) {
    return { stage: "ok", deadlineAt: null, hoursOverdue: 0, blockFrom: null };
  }
  assertValidInstant("clockStartedAt", clockStartedAt);

  const deadlineAt = plusHours(clockStartedAt, thresholdHours);
  const enforceStart =
    enforceFrom && enforceFrom.getTime() > clockStartedAt.getTime() ? enforceFrom : clockStartedAt;
  return {
    stage: stageForElapsed(hoursFromTo(clockStartedAt, asOf), thresholdHours),
    deadlineAt,
    hoursOverdue: Math.max(0, hoursFromTo(deadlineAt, asOf)),
    blockFrom: plusHours(enforceStart, thresholdHours),
  };
}

/**
 * What the caller should do with a decision under the tenant `mode`. `off` is always clear; `warn`
 * never blocks; `block` refuses once `asOf >= blockFrom` unless a supervisor override is active (the
 * override lifts only the block — the note is still overdue, so it degrades to `warn`). An `at_risk`
 * note is `clear` here: its signal is the alert, not the verdict.
 */
export function closureVerdict(
  mode: NoteClosureMode,
  decision: NoteClosureDecision,
  overrideActive: boolean,
  asOf: Date,
): ClosureVerdict {
  if (mode === "off") return "clear";
  const pastBlockFrom =
    decision.blockFrom !== null && asOf.getTime() >= decision.blockFrom.getTime();
  if (mode === "block" && pastBlockFrom && !overrideActive) return "blocked";
  return decision.stage === "overdue" || decision.stage === "escalated" ? "warn" : "clear";
}
