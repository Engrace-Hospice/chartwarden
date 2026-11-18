// apps/web/src/modules/08-encounters — the pure half of My notes (ADR-0113 slice 1). Pure leaf: no React, no client.
// The SERVER decided each note's stage and deadline (the same clock the gate and the alerts use); this only labels, orders and counts
// them. A note whose clock is null is a LEGACY note (a draft from before the clock existed, no backfill): it shows as "Legacy", has no
// deadline and never alerts, so it sorts after every clocked note and counts in neither KPI.
import type { StatusTone } from "@chartwarden/ui";
import { formatClosureInstant } from "../../shell/closure-instant";
import { type NoteStage, STAGE_LABEL, STAGE_TONE } from "./closure-model";

export type { NoteStage };
// Where an open note is worked on is the shell's (the banner links there too); re-exported so this screen's imports keep one home.
export { noteHref, openNoteLabel } from "../../shell/note-href";

/** `GET /encounters/my-drafts` rows carry this per note. */
export interface NoteClosure {
  readonly clockStartedAt: string | null;
  readonly deadlineAt: string | null;
  readonly stage: NoteStage;
}

export interface ClosureSortable {
  readonly closure: NoteClosure;
}

export const LEGACY_LABEL = "Legacy";

export const isLegacyNote = (closure: NoteClosure): boolean => closure.clockStartedAt === null;

/** A pill carries its meaning in the label, never in colour alone. */
export function closureLabel(closure: NoteClosure): string {
  return isLegacyNote(closure) ? LEGACY_LABEL : STAGE_LABEL[closure.stage];
}

export function closureTone(closure: NoteClosure): StatusTone {
  return isLegacyNote(closure) ? "neutral" : STAGE_TONE[closure.stage];
}

/** "Due Nov 17, 6:00 AM" under the pill; a legacy note has no deadline to show. */
export function deadlineText(closure: NoteClosure): string {
  return closure.deadlineAt === null
    ? "No deadline"
    : `Due ${formatClosureInstant(closure.deadlineAt)}`;
}

export type ClosureFilter = "" | "overdue" | "at_risk" | "legacy";

/** Whether a note belongs to a closure filter: `overdue` covers overdue and escalated; `legacy` is the clockless notes. */
export function matchesClosureFilter(closure: NoteClosure, filter: ClosureFilter): boolean {
  if (filter === "") return true;
  if (filter === "legacy") return isLegacyNote(closure);
  if (filter === "at_risk") return !isLegacyNote(closure) && closure.stage === "at_risk";
  return closure.stage === "overdue" || closure.stage === "escalated";
}

export interface ClosureCounts {
  /** Overdue plus escalated: past their deadline. */
  readonly overdue: number;
  readonly atRisk: number;
}

export function closureCounts(rows: readonly ClosureSortable[]): ClosureCounts {
  const count = (filter: ClosureFilter): number =>
    rows.filter((r) => matchesClosureFilter(r.closure, filter)).length;
  return { overdue: count("overdue"), atRisk: count("at_risk") };
}

const NO_DEADLINE_LAST = Number.POSITIVE_INFINITY;

const deadlineOf = (row: ClosureSortable): number =>
  row.closure.deadlineAt === null ? NO_DEADLINE_LAST : Date.parse(row.closure.deadlineAt);

/** Nearest deadline first, legacy notes last. Stable (ties keep their order); never mutates its input. */
export function sortByDeadline<T extends ClosureSortable>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const left = deadlineOf(a);
    const right = deadlineOf(b);
    if (left === right) return 0;
    return left < right ? -1 : 1;
  });
}
