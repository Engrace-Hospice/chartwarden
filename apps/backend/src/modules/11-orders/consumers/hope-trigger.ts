// apps/backend/src/modules/11-orders/consumers/hope-trigger.ts — the M10 HOPE J2051 banner consumer
// (M11-T07, spec §2.7 D7 / §4.5). PHASE-1 PURE DECISION CORE.
//
// M10 (HOPE Engine) emits `m10.hope.j2051_trigger_fired` when Section J's server-authoritative J2051
// evaluator fires at sign. M11 subscribes: if the symptom severity is `moderate` or `severe` (§2.7), it
// adds a suggestion to the patient's banner state and emits `m11.order.suggestion_state_changed`. As with
// the M9 consumer, M11 NEVER creates the order — the banner is informative; the clinician's click-through
// is the gate (§2.7). The consumed event name is a STRING literal only (no M10 schema import): M11 reads
// M10 solely through the foundation outbox, never via a `dependsOn` edge (§4 boundary rule).
import type { SuggestionAction, SuggestionFacts } from "./suggestion-banner";

// ── The J2051 trigger payload M11 consumes (M10 owns the canonical wire shape) ────────────────────────

/** The §2.7 HOPE severity ladder (mirrors M10's `j2051Severity`). Only `moderate` / `severe` raise a banner. */
export type HopeJ2051Severity = "none" | "mild" | "moderate" | "severe";

/** The `m10.hope.j2051_trigger_fired` payload subset M11 reads. M10 owns the canonical type + the `mN.`
 * wire name; this leaf-typed projection is the single point to reconcile if M10 namespaces it differently.
 * `patientId` is resolved by the live worker from the envelope aggregate / a read seam. */
export interface HopeJ2051TriggerPayload {
  readonly patientId: string;
  readonly assessmentId: string;
  /** The max J-item severity M10 evaluated; `moderate` / `severe` raise the §2.7 banner. */
  readonly maxSeverity: HopeJ2051Severity;
}

/** The §2.7 severities that raise an order-suggestion banner from a HOPE J2051 trigger. */
const BANNER_SEVERITIES: ReadonlySet<HopeJ2051Severity> = new Set<HopeJ2051Severity>([
  "moderate",
  "severe",
]);

// ── The pure decision core (§2.7 D7 / §4.5) ───────────────────────────────────────────────────────────

/**
 * Decide the banner effect for an `m10.hope.j2051_trigger_fired` delivery (pure). The worker resolves
 * {@link SuggestionFacts}, then this returns the {@link SuggestionAction}. A `none` / `mild` severity is
 * skipped `below_threshold`; a redelivery is skipped `already_suggested`; an assessment the clinician
 * already acted on is skipped `order_already_created`. The surviving delivery adds a `hope`-sourced entry
 * keyed by the HOPE assessment id — the dedup + drop key the eventual `order_record.triggering_hope_assessment_id`
 * carries. A J2051 symptom trigger nudges a comfort-medication order (§2.1 comfort_kit).
 */
export function decideHopeSuggestion(
  payload: HopeJ2051TriggerPayload,
  facts: SuggestionFacts,
): SuggestionAction {
  if (!BANNER_SEVERITIES.has(payload.maxSeverity))
    return { kind: "skip", reason: "below_threshold" };
  if (facts.orderAlreadyCreated) return { kind: "skip", reason: "order_already_created" };
  if (facts.alreadySuggested) return { kind: "skip", reason: "already_suggested" };

  return {
    kind: "add_suggestion",
    patientId: payload.patientId,
    entry: {
      triggeringId: payload.assessmentId,
      source: "hope",
      trigger: `j2051:${payload.maxSeverity}`,
      suggestedKind: "comfort_kit",
    },
  };
}
