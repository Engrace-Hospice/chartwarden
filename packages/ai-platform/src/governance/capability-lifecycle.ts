// @wardenx/ai-platform — §2.2 capability-lifecycle GOVERNANCE rules (M32-T03).
//
// `./lifecycle/state-machine` (T01) holds the EDGE SET — which (from, to, kind) triples exist. This
// file is the gate that decides whether a particular signer, with particular evidence, may WALK one of
// those edges, and what the `ai_capability` row must look like afterwards. Pure: no IO, no DB handle,
// no clock (the instant is an argument). `../../apps/backend/.../governance` writes the row and the
// `ai_capability_lifecycle_event` ledger entry through it.
//
// ── FOUR DECISIONS THAT ARE LOAD-BEARING ───────────────────────────────────────────────────────────
//
//  1. THE §5.7 FAST TRACK IS APPLIED, AND IT IS THE ARCHITECTURE DOCUMENT WINNING. §2.2's edge labels
//     put the Clinical Reviewer on the Stage-3 and Stage-4 gates unconditionally. AI Governance §5.7
//     ("Fast-Track for Low Risk") says a Low-risk capability needs AI Safety Owner sign-off and "No
//     Clinical Reviewer required". The architecture corpus wins over a module spec (repo authority
//     rule), so `aiRequiredSignerRoles` drops `clinical_reviewer` for `low` risk tier and for that tier
//     ONLY. The AI Safety Owner is never dropped — §5.7 keeps them on every gate — and the Privacy
//     Officer on the Stage-2 gate is untouched, because §5.7's example is explicitly "not PHI-bearing
//     in any meaningful way" and a low-risk capability that DOES touch PHI still passes Stage-2 whole.
//
//  2. THE RE-APPROVAL CLOCK STARTS AT FIRST APPROVAL, NOT AT THE FIRST RE-APPROVAL. §1.3 makes the
//     annual (High) / biennial (Medium) Stage-5 re-approval mandatory, and §3.2.1's
//     `ai_capability_reapproval_due_idx` is a PARTIAL index over `APPROVED`/`MONITORING`. A capability
//     that went live with a NULL `next_reapproval_due_at` would never appear in the sweep that reads
//     that index, so the mandate would silently never fire for exactly the capabilities it covers. So
//     entering APPROVED sets the due date, and every `reapproval` rolls it forward.
//
//  3. LOW RISK GETS A NULL DUE DATE, NOT A GUESSED CADENCE. AI Governance §5.6 states annual for High
//     and biennial for Medium and says nothing about Low; §5.7 fast-tracks Low to "standard
//     monitoring". Inventing (say) triennial would put a fabricated compliance deadline in front of an
//     auditor. NULL is the honest value and the column is nullable.
//
//  4. LEAVING THE SERVING STATES CLEARS THE DUE DATE. DEPRECATED and RETIRED fall outside the partial
//     index anyway; leaving a stale due date on the row would make a deprecated capability read as
//     overdue for a re-approval nobody intends to perform.
import type {
  AiCapabilityLifecycleState,
  AiCapabilityOwningRole,
  AiCapabilityRiskTier,
  AiLifecycleApprovalKind,
  AiLifecycleTransition,
} from "@wardenx/types";

import { aiLifecycleTransition } from "../lifecycle/state-machine";
import { type AiGovernanceRefusal, aiGovernanceRefusal } from "./errors";

/** The states in which a capability is live enough to owe a periodic re-approval (§3.2.1's index). */
export const AI_REAPPROVAL_BEARING_STATES: readonly AiCapabilityLifecycleState[] = [
  "APPROVED",
  "MONITORING",
];

/**
 * AI Governance §5.6 — the Stage-5 re-approval cadence, in months, per risk tier.
 * `null` for `low`: no authority states one (see decision 3).
 */
export const AI_REAPPROVAL_INTERVAL_MONTHS: {
  readonly [K in AiCapabilityRiskTier]: number | null;
} = {
  high: 12,
  medium: 24,
  low: null,
};

/** The roles that must sign this edge, after AI Governance §5.7's Low-risk relaxation (decision 1). */
export function aiRequiredSignerRoles(
  transition: AiLifecycleTransition,
  riskTier: AiCapabilityRiskTier,
): readonly AiCapabilityOwningRole[] {
  if (riskTier !== "low") return transition.requiredRoles;
  const relaxed = transition.requiredRoles.filter((r) => r !== "clinical_reviewer");
  // Defensive, not decorative: §5.7 removes the Clinical Reviewer, it does not remove the gate. An
  // edge whose ONLY required role were the clinical reviewer would otherwise become unsigned.
  return relaxed.length > 0 ? relaxed : transition.requiredRoles;
}

/** The `ai_capability` row as the lifecycle gate needs to see it. */
export interface AiLifecycleCapabilitySnapshot {
  readonly lifecycleState: AiCapabilityLifecycleState;
  readonly riskTier: AiCapabilityRiskTier;
  /** §3.2.1's `ai_capability_approved_has_template` input. */
  readonly currentPromptTemplateKey: string | null;
  /** ISO instant; `null` until the capability first reaches APPROVED. */
  readonly firstApprovedAt: string | null;
}

/** One signer's request to walk an edge. */
export interface AiLifecycleTransitionRequest {
  readonly toState: AiCapabilityLifecycleState;
  readonly approvalKind: AiLifecycleApprovalKind;
  readonly actorRole: AiCapabilityOwningRole;
  /** The signer's own words — `ai_capability_lifecycle_event.rationale_text`, NOT NULL. */
  readonly rationaleText: string;
  /** D10 evidence; `null` where the edge does not require it. */
  readonly linkedEvaluationRunId: string | null;
}

/** The column changes the accepted transition implies on `ai_capability`. */
export interface AiLifecyclePatch {
  readonly lifecycleState: AiCapabilityLifecycleState;
  /** Present only on the FIRST arrival at APPROVED. */
  readonly firstApprovedAt?: string;
  /** Present on a `reapproval`. */
  readonly lastReapprovedAt?: string;
  /** Always present: a serving state gets a due date (or `null` for Low), a non-serving state gets
   *  `null` (decision 4). `undefined` would leave a stale date behind, so this is never omitted. */
  readonly nextReapprovalDueAt: string | null;
}

/** The gate's verdict. */
export type AiLifecycleDecision =
  | {
      readonly ok: true;
      readonly transition: AiLifecycleTransition;
      readonly patch: AiLifecyclePatch;
    }
  | AiGovernanceRefusal;

/** Add whole months to an ISO instant, preserving the instant-of-day. */
function addMonths(isoInstant: string, months: number): string {
  const d = new Date(isoInstant);
  const target = new Date(d.getTime());
  target.setUTCMonth(target.getUTCMonth() + months);
  return target.toISOString();
}

/**
 * The re-approval due date a capability in `state` carries, given when it was (re)approved.
 * `null` in every non-serving state and for the Low tier (decisions 3 and 4).
 */
export function aiNextReapprovalDueAt(
  state: AiCapabilityLifecycleState,
  riskTier: AiCapabilityRiskTier,
  approvedAt: string,
): string | null {
  if (!AI_REAPPROVAL_BEARING_STATES.includes(state)) return null;
  const months = AI_REAPPROVAL_INTERVAL_MONTHS[riskTier];
  return months === null ? null : addMonths(approvedAt, months);
}

/**
 * Decide whether `request` may move `snapshot` — and if so, what the row becomes.
 *
 * Guard ORDER is deliberate and is the order an operator would want the error in: does the edge exist
 * at all → may this person sign it → is the evidence the edge demands present → does the destination
 * state leave the row legal → did the signer say why. Reversing the first two would tell a caller
 * "you may not sign that" about an edge that does not exist, which sends them to the wrong remedy.
 */
export function evaluateAiLifecycleTransition(
  snapshot: AiLifecycleCapabilitySnapshot,
  request: AiLifecycleTransitionRequest,
  at: string,
): AiLifecycleDecision {
  const transition = aiLifecycleTransition(
    snapshot.lifecycleState,
    request.toState,
    request.approvalKind,
  );
  if (transition === null) {
    return aiGovernanceRefusal(
      "AI_LIFECYCLE_INVALID_TRANSITION",
      `§2.2 has no ${request.approvalKind} edge from ${snapshot.lifecycleState} to ${request.toState}`,
    );
  }

  const requiredRoles = aiRequiredSignerRoles(transition, snapshot.riskTier);
  if (!requiredRoles.includes(request.actorRole)) {
    return aiGovernanceRefusal(
      "AI_LIFECYCLE_SIGNER_ROLE_INSUFFICIENT",
      `${transition.label} must be signed by one of [${requiredRoles.join(", ")}]; actor is ${request.actorRole}`,
    );
  }

  if (transition.requiresEvaluationRun && !request.linkedEvaluationRunId) {
    return aiGovernanceRefusal(
      "AI_LIFECYCLE_EVALUATION_RUN_REQUIRED",
      `${transition.label} requires a linked evaluation run (D10)`,
    );
  }

  if (
    AI_REAPPROVAL_BEARING_STATES.includes(request.toState) &&
    !snapshot.currentPromptTemplateKey
  ) {
    return aiGovernanceRefusal(
      "AI_LIFECYCLE_PROMPT_TEMPLATE_REQUIRED",
      `${request.toState} requires current_prompt_template_key (§3.2.1 ai_capability_approved_has_template)`,
    );
  }

  if (request.rationaleText.trim().length === 0) {
    return aiGovernanceRefusal(
      "AI_LIFECYCLE_RATIONALE_REQUIRED",
      "ai_capability_lifecycle_event.rationale_text may not be blank",
    );
  }

  // The instant the re-approval clock is measured FROM: a `reapproval` restarts it now, and so does a
  // first arrival at APPROVED. Every other move into a serving state (the APPROVED↔MONITORING pair)
  // inherits the existing anchor, because GA-ing an already-approved capability is not a new approval.
  const isReapproval = request.approvalKind === "reapproval";
  const isFirstApproval = request.toState === "APPROVED" && snapshot.firstApprovedAt === null;
  const anchor = isReapproval || isFirstApproval ? at : (snapshot.firstApprovedAt ?? at);

  const patch: AiLifecyclePatch = {
    lifecycleState: request.toState,
    ...(isFirstApproval ? { firstApprovedAt: at } : {}),
    ...(isReapproval ? { lastReapprovedAt: at } : {}),
    nextReapprovalDueAt: aiNextReapprovalDueAt(request.toState, snapshot.riskTier, anchor),
  };

  return { ok: true, transition, patch };
}
