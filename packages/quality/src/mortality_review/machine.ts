// @wardenx/quality — M30 §2.2 / D9 / §4.12 mortality_review lifecycle machine (P2a). Pure, IO-free.
//
// The mortality-review aggregate lifecycle (§2.2 — mirrors `m30_mortality_review_status`):
//
//   pending ─start→ in_progress ─complete→ completed
//     │  └markOverdue→ overdue ─resume→ in_progress
//     └markOverdue→ overdue ─complete→ completed
//
// NOTE on state names: the frozen `m30_mortality_review_status` pgEnum uses `pending` as the genesis state
// (NOT the spec's prose "created"); the schema wins. The four states are `pending → in_progress →
// completed`, with `overdue` as the automatic late-state. This is the M8/M11 lifecycle convention (NOT
// XState): a PURE `(state, event) → new state + side-effect list`, throwing a {@link MortalityReviewStateError}
// on an illegal transition or guard failure. Every fact a guard needs (dimensions complete, reviewer
// signature present, the W-M30-27 external-source cosign status, the system-actor + deadline facts for the
// overdue sweep) is resolved UPSTREAM and injected as event data — no IO, no DB, no clock.
import { WardenXError } from "@wardenx/types";
import type { schema } from "@wardenx/db";

/** The §2.2 mortality_review lifecycle state (mirrors `m30_mortality_review_status`). */
export type MortalityReviewState = schema.MortalityReview["status"];

// -----------------------------------------------------------------------------
// Failure-code catalog
// -----------------------------------------------------------------------------

/** The M30 mortality-review lifecycle failure-code catalog → canonical HTTP status. */
export const M30_MORTALITY_ERROR_STATUS = {
  // §2.2 — an event from a state that does not accept it.
  ILLEGAL_MORTALITY_TRANSITION: 409,
  // §2.2 `start` — a review cannot begin without an assigned reviewer.
  MORTALITY_REVIEWER_REQUIRED: 422,
  // §2.2 `complete` — all three dimensions (clinical / satisfaction / compliance) must be populated.
  MORTALITY_DIMENSIONS_INCOMPLETE: 422,
  // §2.2 `complete` — the Medical Director reviewer signature is required.
  MORTALITY_REVIEWER_SIGNATURE_REQUIRED: 422,
  // W-M30-27 `complete` — an external-source death cannot complete until the M6 discharge cosign lands.
  EXTERNAL_SOURCE_COSIGN_PENDING: 409,
  // §2.2 `markOverdue` — the automatic overdue sweep is a system-actor operation.
  MORTALITY_NOT_SYSTEM_ACTOR: 403,
  // §2.2 `markOverdue` — the completion deadline has not been reached.
  MORTALITY_DEADLINE_NOT_REACHED: 422,
  // W-M30-27 `markOverdue` — the completion clock is deferred (external-source, pre-cosign): no overdue.
  MORTALITY_COMPLETION_CLOCK_INACTIVE: 422,
} as const;

/** A machine-readable M30 mortality-review lifecycle failure code (§2.2). */
export type M30MortalityErrorCode = keyof typeof M30_MORTALITY_ERROR_STATUS;

/**
 * A guard / validation failure in the M30 mortality-review domain. Extends the M1 `WardenXError` envelope
 * base (the M11 `OrderStateError` precedent) so the Fastify error handler renders the precise code + HTTP
 * status with no cross-module import edge.
 */
export class MortalityReviewStateError extends WardenXError {
  constructor(code: M30MortalityErrorCode, message: string) {
    super(code, message, M30_MORTALITY_ERROR_STATUS[code]);
    this.name = "MortalityReviewStateError";
  }
}

/** Throw a {@link MortalityReviewStateError} when `condition` is false (guard helper). */
function require_(condition: boolean, code: M30MortalityErrorCode, message: string): asserts condition {
  if (!condition) throw new MortalityReviewStateError(code, message);
}

// -----------------------------------------------------------------------------
// Side effects + transition result
// -----------------------------------------------------------------------------

/** The §2.4 / §4.10 `m30.mortality_review.*` outbox events a transition may publish. */
export type MortalityOutboxEvent =
  | "m30.mortality_review.overdue"
  | "m30.mortality_review.completed";

/** One in-transaction side effect a transition declares (§2.4). The service layer runs these; never IO here. */
export type MortalitySideEffect =
  | { readonly kind: "audit"; readonly severity: "info" | "warn" }
  | { readonly kind: "outbox"; readonly event: MortalityOutboxEvent }
  | { readonly kind: "set_timestamp"; readonly field: string };

/** A transition's full result — the new state + its ordered side-effect list. */
export interface MortalityTransitionResult {
  readonly from: MortalityReviewState;
  readonly event: MortalityEvent["type"];
  readonly to: MortalityReviewState;
  readonly effects: ReadonlyArray<MortalitySideEffect>;
}

function result(
  from: MortalityReviewState,
  event: MortalityEvent["type"],
  to: MortalityReviewState,
  effects: ReadonlyArray<MortalitySideEffect>,
): MortalityTransitionResult {
  return { from, event, to, effects };
}

// -----------------------------------------------------------------------------
// Events (per-event facts resolved upstream and injected as data)
// -----------------------------------------------------------------------------

/** The §2.2 mortality_review lifecycle events. */
export type MortalityEvent =
  | {
      readonly type: "start";
      /** §2.2 — a reviewer (Medical Director or delegate) is assigned to the review. */
      readonly hasAssignedReviewer: boolean;
    }
  | {
      readonly type: "complete";
      /** §2.2 — all three dimensions are populated (`areAllDimensionsComplete`). */
      readonly dimensionsComplete: boolean;
      /** §2.2 — the Medical Director reviewer signature is present on the row. */
      readonly reviewerSignaturePresent: boolean;
      /**
       * W-M30-27 — for an external-source death, the M6 discharge cosign has landed (`cosignStatus ===
       * 'cosigned'`). Resolved upstream from the external-source metadata; ALWAYS `true` for internal-source
       * reviews (no cosign gate applies).
       */
      readonly externalSourceCosignSatisfied: boolean;
    }
  | {
      readonly type: "markOverdue";
      /** §2.2 — the automatic overdue sweep is fired by the system worker, not a human actor. */
      readonly isSystemActor: boolean;
      /** §2.2 — `now() >= targetCompletionAt`. */
      readonly deadlineReached: boolean;
      /**
       * W-M30-27 — the completion clock is active. `false` for an external-source review still awaiting the
       * M6 cosign (no completion target ⇒ no overdue, no reminders).
       */
      readonly completionClockActive: boolean;
    }
  | {
      readonly type: "resume";
    };

/** The legal §2.2 transition graph (from → events accepted). Guards are checked separately. */
export const MORTALITY_GRAPH: Readonly<
  Record<MortalityReviewState, ReadonlyArray<MortalityEvent["type"]>>
> = {
  pending: ["start", "markOverdue"],
  in_progress: ["complete", "markOverdue"],
  overdue: ["resume", "complete"],
  completed: [],
};

/**
 * Apply a mortality-review lifecycle event (§2.2). Throws {@link MortalityReviewStateError}
 * `ILLEGAL_MORTALITY_TRANSITION` if the event is not accepted from `from`, or the specific §2.2 / W-M30-27
 * guard code on a guard failure. Returns the new state + the ordered §2.4 side-effect list the service runs
 * in the review's optimistic-locked tx.
 */
export function transitionMortalityReview(
  from: MortalityReviewState,
  event: MortalityEvent,
): MortalityTransitionResult {
  if (!MORTALITY_GRAPH[from].includes(event.type)) {
    throw new MortalityReviewStateError(
      "ILLEGAL_MORTALITY_TRANSITION",
      `mortality review cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "start": {
      require_(
        event.hasAssignedReviewer,
        "MORTALITY_REVIEWER_REQUIRED",
        "a mortality review cannot begin without an assigned reviewer",
      );
      return result(from, event.type, "in_progress", [{ kind: "audit", severity: "info" }]);
    }

    case "complete": {
      require_(
        event.dimensionsComplete,
        "MORTALITY_DIMENSIONS_INCOMPLETE",
        "all three review dimensions (clinical, satisfaction, compliance) must be populated before completion",
      );
      require_(
        event.reviewerSignaturePresent,
        "MORTALITY_REVIEWER_SIGNATURE_REQUIRED",
        "the Medical Director reviewer signature is required to complete the review",
      );
      // W-M30-27 — an external-source death gates completion behind the M6 discharge cosign.
      require_(
        event.externalSourceCosignSatisfied,
        "EXTERNAL_SOURCE_COSIGN_PENDING",
        "the review cannot complete until the medical-director cosign of the external-source death-discharge",
      );
      return result(from, event.type, "completed", [
        { kind: "set_timestamp", field: "completed_at" },
        { kind: "audit", severity: "info" },
        { kind: "outbox", event: "m30.mortality_review.completed" },
      ]);
    }

    case "markOverdue": {
      require_(
        event.isSystemActor,
        "MORTALITY_NOT_SYSTEM_ACTOR",
        "only the overdue-sweep worker may mark a review overdue",
      );
      // W-M30-27 — a deferred completion clock (external-source, pre-cosign) cannot produce an overdue.
      require_(
        event.completionClockActive,
        "MORTALITY_COMPLETION_CLOCK_INACTIVE",
        "the completion clock is deferred (external-source death awaiting cosign); no overdue applies",
      );
      require_(
        event.deadlineReached,
        "MORTALITY_DEADLINE_NOT_REACHED",
        "the completion deadline has not been reached",
      );
      return result(from, event.type, "overdue", [
        { kind: "audit", severity: "warn" },
        { kind: "outbox", event: "m30.mortality_review.overdue" },
      ]);
    }

    case "resume": {
      // §2.2 — an overdue review resumes active work (overdue → in_progress).
      return result(from, event.type, "in_progress", [{ kind: "audit", severity: "info" }]);
    }
  }
}
