// Non-transient refusal rules for M7's `idg.decision_recorded` proposal builder (m14-idg-decision-recorded.ts):
// the typed refusal the handler persists as a durable `conflict` application, and the guards that reuse the
// §2.2.3 element machines (lifecycle/elements.ts) plus the T4 terminal-problem rule. Pure: no IO.
import {
  CarePlanStateError,
  type GoalLifecycleState,
  type ProblemLifecycleState,
} from "../lifecycle";
import {
  assertProblemEditable,
  guardGoalStatusChange,
  guardProblemStatusChange,
} from "../routes/element-transitions";

/**
 * A deliberate, NON-transient refusal: this decision can never become a proposal (an invalid mutation, an
 * element machine or the T4 rule says no, the plan is not active, another version is open). Retrying cannot
 * change the outcome, so {@link buildM7IdgDecisionConsumer} persists a durable `conflict` application plus an
 * audit event and acks the outbox row instead of throwing it into the retry/dead-letter loop. Messages carry
 * codes and ids, never record content or raw payload values. Thrown while parsing the event envelope (before
 * any ids are known) it is not caught, so a malformed envelope still dead-letters.
 */
export class IdgProposalRefusal extends Error {
  readonly code: string;
  /** The human-readable reason, without the module prefix (stored as `conflict_reason`). */
  readonly reason: string;
  constructor(code: string, reason: string) {
    super(`m7.apply-idg-decision: ${reason}`);
    this.name = "IdgProposalRefusal";
    this.code = code;
    this.reason = reason;
  }
}

export const invalidPayload = (message: string): IdgProposalRefusal =>
  new IdgProposalRefusal("invalid_payload", message);

export const notFound = (kind: string, id: string): IdgProposalRefusal =>
  new IdgProposalRefusal("element_not_found", `${kind} '${id}' not found on the plan`);

/** Run an element-machine transition purely as a guard; its CarePlanStateError becomes a typed refusal. */
export function guardTransition(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    if (error instanceof CarePlanStateError) {
      throw new IdgProposalRefusal(error.code.toLowerCase(), error.message);
    }
    throw error;
  }
}

/**
 * Guard an IDG `problem_update` against the SAME rules apply/finalize enforce (routes/element-transitions.ts), so a
 * proposal this accepts can always be applied: a resolved/inactive problem is read-only history (any edit is
 * refused), an unchanged or absent status is a no-op, and a change runs the §2.2.3 machine. T4 (M7 spec §Threat
 * model): IDG automation never resolves/deactivates a `terminal`-kind problem. M14's `problem_update` has no
 * resolution-note field, so the machine's note guard (RESOLUTION_NOTE_REQUIRED) refuses every IDG resolve, and
 * nothing re-activates a resolved/inactive problem.
 */
export function guardProblemStatus(
  before: { readonly kind: string; readonly status: ProblemLifecycleState },
  to: ProblemLifecycleState | undefined,
): void {
  guardTransition(() => assertProblemEditable(before.status));
  if (to !== undefined && to !== before.status && before.kind === "terminal") {
    throw new IdgProposalRefusal(
      "terminal_problem_status_change",
      "an IDG decision cannot resolve or deactivate a terminal problem (needs the RN + physician co-sign path)",
    );
  }
  guardTransition(() => guardProblemStatusChange(before.status, to, ""));
}

/**
 * Guard an IDG `goal_update` the way apply/finalize do: a met / not_met / discontinued goal is read-only history
 * (any edit is refused), an unchanged or absent status is a no-op, and a change runs the §2.2.3 graph.
 */
export function guardGoalStatus(
  from: GoalLifecycleState,
  to: GoalLifecycleState | undefined,
): void {
  guardTransition(() => guardGoalStatusChange(from, to));
}
