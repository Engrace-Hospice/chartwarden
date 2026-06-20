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
    },
  ): Promise<{ alertId: string; resolvedRecipientCount: number }>;
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
