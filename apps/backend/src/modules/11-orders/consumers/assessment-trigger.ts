// apps/backend/src/modules/11-orders/consumers/assessment-trigger.ts — the M9 significant-change banner
// consumer (M11-T07, spec §2.7 D7 / §4.5 / W-AS-01). PHASE-1 PURE DECISION CORE.
//
// M9 (Clinical Assessments) emits `m9.assessment.significant_change` when a threshold-crossing rule fires
// within the recording transaction. M11 subscribes: if the rule is one of the §2.7 order-suggestion rules
// (`esas_symptom_ge_7` → comfort medication; `painad_ge_4` → CBC lab, §2.1), it adds a suggestion to the
// patient's banner state and emits `m11.order.suggestion_state_changed`. M11 NEVER creates the order — the
// banner is informative; the clinician's click-through is the gate (§2.7). The consumed event name is a
// STRING literal only (no M9 schema import): M11 reads M9 solely through the foundation outbox, never via
// a `dependsOn` edge (§4 boundary rule).
import type { OrderKind } from "@chartwarden/types";
import type { SuggestionAction, SuggestionFacts } from "./suggestion-banner";

// ── The significant-change payload M11 consumes (M9 owns the canonical wire shape) ────────────────────

/** The `m9.assessment.significant_change` payload subset M11 reads. M9 owns the canonical type + the
 * `mN.` wire name; this leaf-typed projection is the single point to reconcile if M9 namespaces it
 * differently. `patientId` is resolved by the live worker from the envelope aggregate / a read seam. */
export interface SignificantChangePayload {
  readonly patientId: string;
  readonly assessmentId: string;
  /** The §2.4 rule id that fired (`esas_symptom_ge_7`, `painad_ge_4`, or another change rule M11 ignores). */
  readonly ruleId: string;
}

/** The §2.7 rule ids that raise an order-suggestion banner, mapped to the §2.1 suggested order kind. */
const SUGGESTION_RULES: Readonly<Record<string, OrderKind>> = {
  // ESAS-r symptom ≥ 7 → consider a comfort medication order (§2.1 comfort_kit trigger).
  esas_symptom_ge_7: "comfort_kit",
  // PAINAD ≥ 4 → consider a CBC / lab order (§2.1 lab trigger).
  painad_ge_4: "lab",
};

// ── The pure decision core (§2.7 D7 / §4.5 / W-AS-01) ─────────────────────────────────────────────────

/**
 * Decide the banner effect for an `m9.assessment.significant_change` delivery (pure). The worker resolves
 * {@link SuggestionFacts} (is the suggestion already present; did the clinician already create an order for
 * this assessment), then this returns the {@link SuggestionAction}. A rule outside the §2.7 set is skipped
 * `below_threshold`; a redelivery is skipped `already_suggested`; an assessment the clinician already acted
 * on is skipped `order_already_created`. The surviving delivery adds an `assessment`-sourced entry keyed by
 * the assessment id — the dedup + drop key the eventual `order_record.triggering_assessment_id` carries.
 */
export function decideAssessmentSuggestion(
  payload: SignificantChangePayload,
  facts: SuggestionFacts,
): SuggestionAction {
  const suggestedKind = SUGGESTION_RULES[payload.ruleId];
  if (!suggestedKind) return { kind: "skip", reason: "below_threshold" };
  if (facts.orderAlreadyCreated) return { kind: "skip", reason: "order_already_created" };
  if (facts.alreadySuggested) return { kind: "skip", reason: "already_suggested" };

  return {
    kind: "add_suggestion",
    patientId: payload.patientId,
    entry: {
      triggeringId: payload.assessmentId,
      source: "assessment",
      trigger: payload.ruleId,
      suggestedKind,
    },
  };
}
