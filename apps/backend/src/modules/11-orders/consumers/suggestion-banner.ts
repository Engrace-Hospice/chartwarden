// apps/backend/src/modules/11-orders/consumers/suggestion-banner.ts — the shared per-patient order-
// suggestion banner state shape (M11-T07, spec §2.7 D7). The §4.5 `assessment-trigger` (M9) and
// `hope-trigger` (M10) consumers both maintain this derived state.
//
// This is a DERIVED-STATE pattern — there is no `order_suggestion` table (D7). The live consumer projects
// suggestions into Valkey under `orders:suggestion:<patientId>` (TTL 7 days) and emits
// `m11.order.suggestion_state_changed` so the patient-chart banner refreshes. Critically, M11 NEVER creates
// an order from a suggestion — the banner is informative; the clinician's click-through to `POST /orders`
// (carrying `triggeringAssessmentId` / `triggeringHopeAssessmentId`) is the gating action (§2.7 / W-AS-01).
import type { OrderKind } from "@wardenx/types";

/** Which clinical source produced a suggestion (the triggering-id column the eventual order carries). */
export type SuggestionSource = "assessment" | "hope";

/** One entry in a patient's order-suggestion banner (§2.7). Keyed by `triggeringId` so a created order with
 * the matching `triggering_assessment_id` / `triggering_hope_assessment_id` drops the banner downstream. */
export interface OrderSuggestionEntry {
  /** The triggering assessment / HOPE-assessment id — the dedup + drop key, stored as the order's FK. */
  readonly triggeringId: string;
  /** Which read seam resolves the trigger (assessment vs HOPE), i.e. which FK column the order writes. */
  readonly source: SuggestionSource;
  /** The rule / severity token that fired (`esas_symptom_ge_7`, `painad_ge_4`, `j2051:severe`, …). */
  readonly trigger: string;
  /** The order kind the clinician is nudged toward (§2.1 trigger column) — a hint, never auto-applied. */
  readonly suggestedKind: OrderKind;
}

/** The effect a trigger delivery resolved: add the suggestion to the banner, or skip (with the reason). */
export type SuggestionAction =
  /** A non-qualifying rule/severity, a redelivery (already present), or the clinician already acted. */
  | { readonly kind: "skip"; readonly reason: SuggestionSkipReason }
  /** Add the entry to the patient's banner state and emit `m11.order.suggestion_state_changed`. */
  | { readonly kind: "add_suggestion"; readonly patientId: string; readonly entry: OrderSuggestionEntry };

/** Why a trigger delivery added nothing to the banner (all audited for reconciliation, never a hard error). */
export type SuggestionSkipReason =
  /** The rule id (M9) / severity (M10) is below the §2.7 banner threshold. */
  | "below_threshold"
  /** The banner already carries a suggestion for this `triggeringId` (idempotent redelivery). */
  | "already_suggested"
  /** An active order already references this `triggeringId` — the clinician acted; do not re-raise (§2.7). */
  | "order_already_created";

/** The idempotency / drop facts the live consumer reads before deciding (so the decider stays pure). */
export interface SuggestionFacts {
  /** A banner entry already exists for this `triggeringId` (a redelivery) — skip to avoid a duplicate. */
  readonly alreadySuggested: boolean;
  /** An active `order_record` already carries this `triggeringId` — the clinician acted; do not re-raise. */
  readonly orderAlreadyCreated: boolean;
}
