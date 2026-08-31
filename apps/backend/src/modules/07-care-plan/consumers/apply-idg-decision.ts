// apps/backend/src/modules/07-care-plan/consumers/apply-idg-decision.ts — the M7 side of the M14 IDG
// consumer (M7-T08, spec §7.9 / §11 D4). PURE DECISION CORE.
//
// The `apply-idg-decision` worker is M7's subscriber to Module 14's `idg.decision_recorded` outbox
// event. When an IDG meeting records a clinically-actionable decision (add/update/discontinue a
// problem/goal/intervention), M14 publishes a typed {@link IdgDecisionPayload}; the live worker opens a
// draft `idg_review` version if none is open and persists the mutations as a governed proposal. The
// active care-plan rows are updated only after the IDG review reaches quorum and publishes. Per §4.8 the
// consumer is NOT a published seam: it composes M7's own element + version services so the lifecycle
// machines stay authoritative.
//
// The worker runs under a restricted `system` actor holding only `care_plan.idg_revise` (T4 STRIDE): it
// validates the payload against the `IdgDecisionPayload` TypeBox schema (runtime parse at the boot
// binding) and REFUSES a `discontinue` of a `terminal`-kind problem — terminal-problem discontinuation
// requires the explicit RN + physician co-sign path, not an IDG automation. Idempotency is keyed on
// `idgDecisionId`: a redelivery whose decision a version already records is a no-op (§11 D4).
//
// The production binding is ./../outbox-consumers/m14-idg-decision-recorded.ts. This PURE policy core
// remains independently tested: given the parsed payload + the facts
// the worker reads (idempotency marker, the care-plan root status, the open draft version if any, the
// set of terminal problems), it returns the {@link IdgApplyAction} descriptor the live handler executes
// through M7's element/version services. The consumed event name is a STRING literal only (no M14
// schema import): M7 reads M14 solely through the foundation outbox, never via a `dependsOn` edge.
import type {
  CarePlanId,
  GoalId,
  IdgDecisionChange,
  IdgDecisionPayload,
  IdgMeetingId,
  InterventionDiscipline,
  InterventionId,
  ProblemId,
} from "@wardenx/types";

// ── The facts the worker reads before deciding (resolved by the live consumer from M7 services) ───────

/** Everything the worker must read before it can decide, surfaced as data so {@link decideIdgDecision}
 * stays pure. The Wave-F consumer resolves these from the durable IDG proposal/application table
 * (idempotency), the care_plan root row (status), the open draft version, and the snapshot's problems. */
export interface IdgApplyFacts {
  /** A prior durable IDG proposal/application row already records this `idgDecisionId` (§11 D4). */
  readonly alreadyApplied: boolean;
  /** The plan root accepts revisions only while `active` (a discharged plan is closed; D2). */
  readonly planActive: boolean;
  /** The open (`draft`/`in_review`) `idg_review` version to apply into, or null → open a fresh v2. */
  readonly openDraftVersionId: string | null;
  /** Problems on the working set whose `kind='terminal'` — a `discontinue` of these is refused (T4). */
  readonly terminalProblemIds: ReadonlyArray<ProblemId>;
}

// ── The element mutation the worker applies (executed through M7's element service) ───────────────────

/** A single element mutation the worker applies to the draft version, translated from one
 * {@link IdgDecisionChange}. `add` carries no `elementId` (the service mints one); `update`/`discontinue`
 * carry the referenced id. `discipline` is echoed for an intervention `add` so the service tags it. */
export interface PlannedElementMutation {
  readonly target: IdgDecisionChange["target"];
  readonly op: IdgDecisionChange["op"];
  readonly elementId?: ProblemId | GoalId | InterventionId;
  readonly discipline?: InterventionDiscipline;
}

// ── The effect descriptor the decider returns (executed by the Wave-F consumer) ───────────────────────

/** The effect the worker resolved for an `idg.decision_recorded` delivery. The live consumer executes
 * exactly one: a no-op skip, a contract-violation refusal, or the apply (open-or-reuse draft + mutate). */
export type IdgApplyAction =
  /** A redelivery whose decision a version already records — skip, audit `care_plan.idg.idempotent_skip`. */
  | { readonly kind: "idempotent_skip" }
  /** A contract violation (terminal-discontinue / closed plan / malformed change) — refuse, no DB write. */
  | { readonly kind: "refuse"; readonly reason: IdgRefusalReason }
  /** The happy path — open a draft `idg_review` version if none is open, then apply `mutations` to it. */
  | {
      readonly kind: "apply";
      readonly idgDecisionId: string;
      readonly idgMeetingId: IdgMeetingId;
      readonly planId: CarePlanId;
      /** True → open a fresh draft v2 first; false → reuse {@link IdgApplyAction.targetVersionId}. */
      readonly openNewDraft: boolean;
      /** The open draft to apply into when `openNewDraft=false`; null when a fresh draft is opened. */
      readonly targetVersionId: string | null;
      readonly mutations: ReadonlyArray<PlannedElementMutation>;
    };

/** The refusal reasons the worker records on `care_plan.idg.contract_violation_refused` (T4 forensic). */
export type IdgRefusalReason =
  | "plan_not_active"
  | "no_changes"
  | "missing_element_id"
  | "terminal_problem_discontinue";

// ── The pure decision core (§7.9 / §11 D4) ────────────────────────────────────────────────────────────

/**
 * Decide the single effect to apply for an `idg.decision_recorded` delivery (§7.9, pure). The worker
 * resolves {@link IdgApplyFacts} from the idempotency audit log + the care-plan aggregate, then this
 * returns the {@link IdgApplyAction} descriptor. Idempotency (D4) is checked first; then the contract
 * guards (active plan, non-empty changes, well-formed update/discontinue, the T4 terminal-discontinue
 * rejection); the surviving changes become {@link PlannedElementMutation}s applied to an open-or-fresh
 * draft `idg_review` version.
 */
export function decideIdgDecision(
  payload: IdgDecisionPayload,
  facts: IdgApplyFacts,
): IdgApplyAction {
  // D4 — a version already records this decision: a redelivery is a no-op (idempotent on idgDecisionId).
  if (facts.alreadyApplied) return { kind: "idempotent_skip" };

  // D2 — revisions only land on an active plan (a discharged plan's care plan is closed).
  if (!facts.planActive) return { kind: "refuse", reason: "plan_not_active" };

  // A decision with no element mutations carries no work — treat as a contract violation (defensive).
  if (payload.changes.length === 0) return { kind: "refuse", reason: "no_changes" };

  const terminal = new Set<ProblemId>(facts.terminalProblemIds);
  const mutations: PlannedElementMutation[] = [];
  for (const change of payload.changes) {
    const id = elementIdOf(change);
    // update/discontinue must reference an existing element; add mints a new one (no id).
    if (change.op !== "add" && id === undefined) {
      return { kind: "refuse", reason: "missing_element_id" };
    }
    // T4 — a `discontinue` of a terminal problem is rejected (needs the RN + physician co-sign path).
    if (
      change.target === "problem" &&
      change.op === "discontinue" &&
      id !== undefined &&
      terminal.has(id)
    ) {
      return { kind: "refuse", reason: "terminal_problem_discontinue" };
    }
    mutations.push({
      target: change.target,
      op: change.op,
      ...(id !== undefined ? { elementId: id } : {}),
      ...(change.target === "intervention" && change.discipline
        ? { discipline: change.discipline }
        : {}),
    });
  }

  return {
    kind: "apply",
    idgDecisionId: payload.idgDecisionId,
    idgMeetingId: payload.idgMeetingId,
    planId: payload.planId,
    openNewDraft: facts.openDraftVersionId === null,
    targetVersionId: facts.openDraftVersionId,
    mutations,
  };
}

/** The referenced element id on a change, by target (undefined for an `add`). */
function elementIdOf(change: IdgDecisionChange): ProblemId | GoalId | InterventionId | undefined {
  switch (change.target) {
    case "problem":
      return change.problemId;
    case "goal":
      return change.goalId;
    case "intervention":
      return change.interventionId;
  }
}
