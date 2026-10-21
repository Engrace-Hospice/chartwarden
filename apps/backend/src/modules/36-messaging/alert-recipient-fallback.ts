// apps/backend/src/modules/36-messaging/alert-recipient-fallback.ts - GAP-049.
//
// A quality alert whose seeded `role_set` rule resolves to NOBODY (the tenant never provisioned the
// `qapi_coordinator` / `infection_control_lead` role, or every holder is inactive) is still PERSISTED by the emitter
// - with no deliveries - and `alert` is UNIQUE on (organization_id, correlation_id). So the same correlation id can
// never page again, and a critical sentinel-incident page would be dropped without a trace.
//
// `emitWithRecipientFallback` turns that silent drop into a loud, routed one: when the first emit resolves zero
// recipients it logs a structured warning and re-emits the SAME alert ONCE under the fallback event type (a seeded
// `tenant_admins` rule) and a `:fb` correlation id of its own, so the dedupe cannot swallow it. Whether to provision
// those tenant roles is the GAP-006 tenant-role-template cluster's question, not this module's.
import type { AlertEmitter, AlertSeverity } from "@chartwarden/messaging";

export const QUALITY_RECIPIENT_FALLBACK_EVENT_TYPE = "m30.alerts.recipient_fallback";

export interface FallbackEmitInput {
  readonly eventType: string;
  readonly severity: AlertSeverity;
  readonly correlationId: string;
  readonly payload: Record<string, unknown>;
}

export type FallbackWarn = (message: string, context: Record<string, string>) => void;

/** Emit, and when nobody was resolved page the tenant admins instead. Ids and event names only in the log. */
export async function emitWithRecipientFallback(
  alerts: AlertEmitter,
  organizationId: string,
  input: FallbackEmitInput,
  warn?: FallbackWarn,
): Promise<{ readonly alertId: string; readonly resolvedRecipientCount: number }> {
  const first = await alerts.emit(organizationId, input);
  if (first.resolvedRecipientCount > 0) return first;
  warn?.("quality alert resolved no recipients; paging tenant admins", {
    organizationId,
    eventType: input.eventType,
    correlationId: input.correlationId,
  });
  const fallback = await alerts.emit(organizationId, {
    eventType: QUALITY_RECIPIENT_FALLBACK_EVENT_TYPE,
    severity: input.severity,
    correlationId: `${input.correlationId}:fb`,
    payload: {
      ...input.payload,
      eventType: QUALITY_RECIPIENT_FALLBACK_EVENT_TYPE,
      originalEventType: input.eventType,
    },
  });
  if (fallback.resolvedRecipientCount === 0) {
    warn?.("quality alert fallback also resolved no recipients; the page reached nobody", {
      organizationId,
      eventType: input.eventType,
      correlationId: input.correlationId,
    });
  }
  return fallback;
}
