// @wardenx/messaging — the `AlertEmitter` + `RecipientResolver` published seam contracts (§4.6).
//
// M36-T06. `AlertEmitter` is the ONE boot-validated cross-module surface M36 publishes (Wave-B
// acceptance): a producer module emits a typed event and M36 resolves the firing rules, the
// recipients (dynamically, at emit time — §2.1.3), and the fan-out plan. The real implementation
// (../seams) composes the M36-T04 resolution/fan-out engine over injected source-of-truth ports;
// this file is the leaf-free interface every consumer imports.

import type { AlertSeverity } from "./kinds";

/**
 * M36 — emit an event for routing (§4.6). M36 resolves `alert_rule`s matching `eventType`, the
 * recipients each rule names (care_team / on_call / discipline / role_set / …, resolved against
 * the source-of-truth seam NOW, not when the rule was written), and the per-recipient fan-out
 * (in-app floor always, out-of-band per preference + quiet-hours/vacation). PHI in `payload` is
 * tagged so it never traverses the out-of-band sanitizer (§4.7); the seam itself only routes.
 */
export interface AlertEmitter {
  emit(
    orgId: string,
    input: {
      eventType: string; // matches alert_rule.event_type
      payload: Record<string, unknown>; // structured; PHI fields handled by the §4.7 sanitizer
      severity: AlertSeverity;
      correlationId: string;
      /**
       * F-199 — OPT-IN. A repeat emit with the SAME `correlationId` is absorbed by the `(org, correlation_id)` dedupe
       * (one page per window). With `countRepeats` the absorbed repeat is COUNTED instead of vanishing: the alert's
       * `payload.occurrences` starts at 1 and each repeat increments it atomically, WITHOUT paging again. Off by
       * default, because a redelivered event that re-emits the same id is idempotent, not an occurrence.
       */
      countRepeats?: boolean;
    },
  ): Promise<{
    alertId: string;
    resolvedRecipientCount: number;
    /** F-199 — the alert's occurrence count AFTER this emit; present only when `countRepeats` was set. */
    occurrences?: number;
    /**
     * ADR-0079 — how many out-of-band (non in-app) deliveries this emit PLANNED, across all recipients. 0 means the alert reaches
     * the in-app inbox only (no verified endpoint, policy flag off, or the rule is in-app only); a caller that promised a page
     * uses it to degrade visibly. Planned is not delivered: the dispatcher can still fail the row (no vendor transport today).
     */
    outOfBandPlanned?: number;
  }>;
}

/**
 * M36 — a named recipient resolver (§4.6). The built-in set is wired by M36-T04
 * (`createRecipientResolverRegistry`); later modules contribute their ADR-0024 cross-module
 * resolvers (`ordering_provider` / `intake_supervisor` / `admissions_team`) onto the same
 * registry at their own boot (M36-T09) without an import edge. This is the published shape of
 * such a contribution.
 */
export interface RecipientResolver {
  readonly name:
    | "care_team"
    | "on_call"
    | "discipline"
    | "role_set"
    | "tenant_admins"
    | "user_list"
    | "broadcast"
    | "permission_holders"
    // ADR-0024 cross-module composition resolvers (recipient resolution moved from M14):
    | "ordering_provider"
    | "ordering_provider_with_active_orders_for_physician"
    | "intake_supervisor"
    | "admissions_team";
  /** Returns recipient `user_id`s. */
  resolve(
    orgId: string,
    args: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): Promise<readonly string[]>;
}
