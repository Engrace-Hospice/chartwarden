// apps/backend/src/modules/08-encounters/closure/my-notes.ts — the author's "My notes" projection (ADR-0113 slice 1).
//
// GET /api/v1/encounters/my-drafts returns the caller's OPEN notes (draft + finalized: a finalized note is not closed until it is
// signed) and, per row, where the note sits on its closure clock. The stage and deadline come from the SAME pure clock the request
// gate, the alerts and the overdue board use (note-clock.ts `decideNoteClosure`), fed the tenant's policy: nothing here re-derives
// an overdue predicate. A note with no clock (a legacy draft: no backfill) has a null clock, no deadline and stage `ok`, so it
// never alerts and never blocks. The stage is the TRUE clock stage whatever the tenant's mode: the clock is a fact, the mode only
// decides what an overdue note causes (nothing, an alert, a block).
import { type NoteClosureStage, decideNoteClosure } from "./note-clock";
import type { ClosurePolicy } from "./policy-service";

/** A note is open (not yet closed for its author) while it is in one of these statuses; signed / cosign_pending / cosigned are closed. */
export const MY_NOTE_OPEN_STATUSES = ["draft", "finalized"] as const;

/** One note's position on its closure clock, as it goes on the wire. */
export interface NoteClosureView {
  /** When the clock started; null for a legacy note that has none. */
  readonly clockStartedAt: string | null;
  /** `clockStartedAt` + the tenant threshold; null for a legacy note. */
  readonly deadlineAt: string | null;
  readonly stage: NoteClosureStage;
}

/** A view that carries its closure position. The shared EncounterView does NOT: only this projection does. */
export type WithClosure<T> = T & { readonly closure: NoteClosureView };

export function noteClosureView(
  clockStartedAt: Date | null,
  policy: ClosurePolicy,
  now: Date,
): NoteClosureView {
  const decision = decideNoteClosure({
    clockStartedAt,
    asOf: now,
    thresholdHours: policy.thresholdHours,
    enforceFrom: policy.enforceFrom,
  });
  return {
    clockStartedAt: clockStartedAt === null ? null : clockStartedAt.toISOString(),
    deadlineAt: decision.deadlineAt === null ? null : decision.deadlineAt.toISOString(),
    stage: decision.stage,
  };
}

const NO_CLOCK_LAST = Number.POSITIVE_INFINITY;

const clockOf = (note: { readonly closure: NoteClosureView }): number =>
  note.closure.clockStartedAt === null ? NO_CLOCK_LAST : Date.parse(note.closure.clockStartedAt);

/** Nearest deadline first (the deadline is the clock start plus one threshold, so the clock orders it), legacy notes last. Stable; does not mutate. */
export function sortByDeadline<T extends { readonly closure: NoteClosureView }>(
  notes: readonly T[],
): T[] {
  return [...notes].sort((a, b) => {
    const left = clockOf(a);
    const right = clockOf(b);
    if (left === right) return 0;
    return left < right ? -1 : 1;
  });
}

/** Adds `closure` to each view and orders them nearest-deadline first, legacy last. */
export function myNotesOf<T extends object>(
  rows: readonly { readonly view: T; readonly clockStartedAt: Date | null }[],
  policy: ClosurePolicy,
  now: Date,
): WithClosure<T>[] {
  return sortByDeadline(
    rows.map(({ view, clockStartedAt }) => ({
      ...view,
      closure: noteClosureView(clockStartedAt, policy, now),
    })),
  );
}
