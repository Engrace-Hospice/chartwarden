// @wardenx/ai-platform — §2.2 capability lifecycle state machine (M32-T01).
//
// D2's eight-state governance FSM as a PURE function of (fromState, approvalKind) → toState. No IO, no
// DB, no clock: `ai_capability_lifecycle_event` is the ledger, this is the rule the ledger must obey,
// and M32-T03 is what writes rows through it.
//
// The edge set is §2.2's mermaid diagram, edge for edge, plus the initial registration edge the §2.1
// ERD describes ("`from_state` nullable for the initial PROPOSED registration") and the diagram's
// `[*] --> PROPOSED` arrow draws.
//
// THE APPROVAL KIND NAMES THE GATE, NOT THE OUTCOME. §2.2 labels each promotion edge with the stage
// that authorises it (PROPOSED→DESIGN_REVIEW is "Stage-1 approval"), and the two rejection edges walk
// BACK through the same gate — so EVALUATION→PILOT and EVALUATION→PROPOSED are both
// `stage_3_evaluation`, told apart by `toState`. That is why a transition is keyed on the PAIR and not
// on the kind alone.
//
// TWO READS THIS FILE MAKES, both recorded because they would otherwise be re-litigated:
//
//  1. `stage_1_proposal` labels BOTH the registration edge (null→PROPOSED) and the first promotion
//     (PROPOSED→DESIGN_REVIEW). `ai_capability_lifecycle_event.approval_kind` is NOT NULL and no other
//     kind names a proposal, so registration has to use it. The two rows stay distinguishable by
//     `from_state IS NULL`: one is the proposal being FILED, the other the proposal being APPROVED.
//
//  2. `reapproval` gets the two SELF edges APPROVED→APPROVED and MONITORING→MONITORING, on top of the
//     diagram's MONITORING→APPROVED. §3.2.1 carries `last_reapproved_at` + `next_reapproval_due_at` and
//     indexes the due date over exactly those two states, and §2.2 says in as many words that continued
//     monitoring needs "no state change required typically, but the row reflects current monitoring
//     posture". A periodic reapproval that cannot be RECORDED without moving the capability would make
//     the due-date column unwritable.

import type {
  AiCapabilityConsumerPosture,
  AiCapabilityLifecycleState,
  AiLifecycleApprovalKind,
  AiLifecycleTransition,
} from "@wardenx/types";

/** The state a newly registered capability lands in (§2.2 `[*] --> PROPOSED`). */
export const AI_LIFECYCLE_INITIAL_STATE: AiCapabilityLifecycleState = "PROPOSED";

/**
 * Every legal edge of the §2.2 FSM.
 *
 * `requiredRoles` is §2.2's own edge labels: Stage-1 is the AI Safety Owner alone, Stage-2 adds the
 * Clinical Reviewer AND the Privacy Officer, Stages 3 and 4 are the AI Safety Owner + Clinical Reviewer.
 * Stage-5 GA is marked "automatic on continuous monitoring engagement" — automatic in TRIGGER, not in
 * accountability, so the row still records the AI Safety Owner as the signer.
 *
 * `requiresEvaluationRun` is true exactly where D10's evidence is the gate: entering PILOT (the Stage-3
 * evaluation results), entering APPROVED (the Stage-4 pilot results), a `reapproval`, and the
 * PILOT→EVALUATION rejection that sends a capability back for another run. A `deprecation`,
 * `retirement` or `incident_demotion` does NOT require one — demanding an evaluation run before a
 * SEV-1 demotion would be a 60-second D16 deadline gated on a job that takes hours.
 */
export const AI_LIFECYCLE_TRANSITIONS: readonly AiLifecycleTransition[] = [
  {
    fromState: null,
    toState: "PROPOSED",
    approvalKind: "stage_1_proposal",
    requiredRoles: ["ai_safety_owner"],
    requiresEvaluationRun: false,
    label: "register capability",
  },
  {
    fromState: "PROPOSED",
    toState: "DESIGN_REVIEW",
    approvalKind: "stage_1_proposal",
    requiredRoles: ["ai_safety_owner"],
    requiresEvaluationRun: false,
    label: "Stage-1 approval (AI Safety Owner)",
  },
  {
    fromState: "DESIGN_REVIEW",
    toState: "EVALUATION",
    approvalKind: "stage_2_design_review",
    requiredRoles: ["ai_safety_owner", "clinical_reviewer", "privacy_officer"],
    requiresEvaluationRun: false,
    label: "Stage-2 approval (AI Safety Owner + Clinical Reviewer + Privacy Officer)",
  },
  {
    fromState: "EVALUATION",
    toState: "PILOT",
    approvalKind: "stage_3_evaluation",
    requiredRoles: ["ai_safety_owner", "clinical_reviewer"],
    requiresEvaluationRun: true,
    label: "Stage-3 approval (AI Safety Owner + Clinical Reviewer)",
  },
  {
    fromState: "EVALUATION",
    toState: "PROPOSED",
    approvalKind: "stage_3_evaluation",
    requiredRoles: ["ai_safety_owner", "clinical_reviewer"],
    requiresEvaluationRun: false,
    label: "Stage-3 rejection (re-design needed)",
  },
  {
    fromState: "PILOT",
    toState: "APPROVED",
    approvalKind: "stage_4_pilot",
    requiredRoles: ["ai_safety_owner", "clinical_reviewer"],
    requiresEvaluationRun: true,
    label: "Stage-4 approval (AI Safety Owner + Clinical Reviewer)",
  },
  {
    fromState: "PILOT",
    toState: "EVALUATION",
    approvalKind: "stage_4_pilot",
    requiredRoles: ["ai_safety_owner", "clinical_reviewer"],
    requiresEvaluationRun: true,
    label: "Stage-4 rejection (re-evaluation needed)",
  },
  {
    fromState: "APPROVED",
    toState: "MONITORING",
    approvalKind: "stage_5_ga",
    requiredRoles: ["ai_safety_owner"],
    requiresEvaluationRun: false,
    label: "Stage-5 GA (automatic on continuous monitoring engagement)",
  },
  {
    fromState: "MONITORING",
    toState: "APPROVED",
    approvalKind: "reapproval",
    requiredRoles: ["ai_safety_owner", "clinical_reviewer"],
    requiresEvaluationRun: true,
    label: "continuous monitoring sustained",
  },
  {
    fromState: "APPROVED",
    toState: "APPROVED",
    approvalKind: "reapproval",
    requiredRoles: ["ai_safety_owner", "clinical_reviewer"],
    requiresEvaluationRun: true,
    label: "periodic reapproval (no state change)",
  },
  {
    fromState: "MONITORING",
    toState: "MONITORING",
    approvalKind: "reapproval",
    requiredRoles: ["ai_safety_owner", "clinical_reviewer"],
    requiresEvaluationRun: true,
    label: "periodic reapproval (no state change)",
  },
  {
    fromState: "APPROVED",
    toState: "DEPRECATED",
    approvalKind: "deprecation",
    requiredRoles: ["ai_safety_owner"],
    requiresEvaluationRun: false,
    label: "capability replaced by newer version",
  },
  {
    fromState: "MONITORING",
    toState: "DEPRECATED",
    approvalKind: "deprecation",
    requiredRoles: ["ai_safety_owner"],
    requiresEvaluationRun: false,
    label: "capability replaced",
  },
  {
    fromState: "APPROVED",
    toState: "DEPRECATED",
    approvalKind: "incident_demotion",
    requiredRoles: ["ai_safety_owner"],
    requiresEvaluationRun: false,
    label: "SEV-1 hallucination — automatic demotion per D16",
  },
  {
    fromState: "MONITORING",
    toState: "DEPRECATED",
    approvalKind: "incident_demotion",
    requiredRoles: ["ai_safety_owner"],
    requiresEvaluationRun: false,
    label: "SEV-1 hallucination — automatic demotion per D16",
  },
  {
    fromState: "DEPRECATED",
    toState: "RETIRED",
    approvalKind: "retirement",
    requiredRoles: ["ai_safety_owner"],
    requiresEvaluationRun: false,
    label: "transition period elapsed; no active tenants",
  },
];

/** The states a capability can reach from `from` (`null` = registration). */
export function aiLifecycleNextStates(
  from: AiCapabilityLifecycleState | null,
): readonly AiCapabilityLifecycleState[] {
  const seen = new Set<AiCapabilityLifecycleState>();
  for (const t of AI_LIFECYCLE_TRANSITIONS) {
    if (t.fromState === from) seen.add(t.toState);
  }
  return [...seen];
}

/**
 * Resolve the transition for a (from, to, approvalKind) triple, or `null` if the FSM forbids it.
 *
 * All three are required because none of the pairs identifies an edge on its own: APPROVED→DEPRECATED
 * is two different edges (`deprecation` vs `incident_demotion`) with different accountability, and
 * `stage_3_evaluation` is two different edges (approval vs rejection).
 */
export function aiLifecycleTransition(
  from: AiCapabilityLifecycleState | null,
  to: AiCapabilityLifecycleState,
  approvalKind: AiLifecycleApprovalKind,
): AiLifecycleTransition | null {
  return (
    AI_LIFECYCLE_TRANSITIONS.find(
      (t) => t.fromState === from && t.toState === to && t.approvalKind === approvalKind,
    ) ?? null
  );
}

/** True when the FSM permits the transition. Fails CLOSED: an unknown triple is not a transition. */
export function canAiLifecycleTransition(
  from: AiCapabilityLifecycleState | null,
  to: AiCapabilityLifecycleState,
  approvalKind: AiLifecycleApprovalKind,
): boolean {
  return aiLifecycleTransition(from, to, approvalKind) !== null;
}

/**
 * D16 — the state a SEV-1 hallucination demotes a capability to, or `null` when there is nothing to
 * demote. RETIRED and DEPRECATED are already past the point of re-activation, and a capability below
 * APPROVED was never reachable by a tenant in the first place; in every one of those cases the kill
 * switch is the whole response and no lifecycle row is written.
 */
export function aiSev1DemotionTarget(
  from: AiCapabilityLifecycleState,
): AiCapabilityLifecycleState | null {
  return from === "APPROVED" || from === "MONITORING" ? "DEPRECATED" : null;
}

/**
 * §2.2's "state semantics for the consumer" table.
 *
 * This is the LIFECYCLE leg only. It answers "does the registry permit this capability to serve?" and
 * nothing else — the tenant opt-in, the clinician opt-out, the kill switch, the token cap and the
 * Phase-1 `ai.full` flag are four further gates the invocation pipeline (M32-T04) applies on top, each
 * of which can turn a `generally_available` posture into a refusal. Reading this function as "the
 * capability is on" is the mistake it is documented to prevent.
 */
export function aiConsumerPostureFor(
  state: AiCapabilityLifecycleState,
): AiCapabilityConsumerPosture {
  switch (state) {
    case "PROPOSED":
    case "DESIGN_REVIEW":
    case "EVALUATION":
      return { kind: "unavailable", reason: "lifecycle_state_below_approved" };
    case "PILOT":
      return { kind: "pilot_tenants_only" };
    case "APPROVED":
    case "MONITORING":
      return { kind: "generally_available" };
    case "DEPRECATED":
      return { kind: "existing_opt_ins_only" };
    case "RETIRED":
      return { kind: "unavailable", reason: "lifecycle_state_retired" };
  }
}

/**
 * §2.2 EVALUATION — "accessible only via `/internal/ai/evaluation-runs` for evaluation-dataset
 * invocations". The one state where the consumer posture is `unavailable` and yet an invocation is
 * still legal, because the caller is an evaluation harness against a golden dataset rather than a
 * clinician against a chart. Kept as its own predicate so a route cannot reach it by accident: the
 * posture function alone would say "unavailable" and the evaluation route would have no way through.
 */
export function aiEvaluationDatasetInvocationsAllowed(state: AiCapabilityLifecycleState): boolean {
  return state === "EVALUATION" || state === "PILOT";
}
