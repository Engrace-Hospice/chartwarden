import type { schema } from "@chartwarden/db";
// M31 ADR-0107 D7 - push to the people who can sign. `m31.signature_request.requested` and `.reminded` become ONE fixed, PHI-free alert per
// eligible person through M36's AlertEmitter seam; M36's own pipeline owns the endpoints, the sanitizer (generic wording, no document name,
// no patient, no request id), retries and endpoint health. The tenant comes from the envelope, never the payload.
//
//   * Eligible = a LIVE grant whose kind may sign this document (the authority matrix), resolved here, so a revoked caregiver gets nothing.
//   * A request that is no longer `pending` (signed, parked for review, withdrawn) sends nothing: a redelivered or late event is a no-op.
//   * The alert's correlation id carries the outbox event id, so one event is one push even when the dispatcher redelivers it, and each
//     daily reminder is its own push.
import type { AlertEmitter } from "@chartwarden/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

export const M31_SIGNATURE_PUSH_CONSUMER = "m31.signature-request-push" as const;
export const M31_SIGNATURE_PUSH_EVENTS = [
  "m31.signature_request.requested",
  "m31.signature_request.reminded",
] as const;

/** The alert-rule key (seeded in PLATFORM_DEFAULT_ALERT_RULES); an alert type, not an outbox event. */
export const M31_SIGNATURE_PUSH_ALERT = "m36.portal_signature.pending" as const;

export interface SignaturePushDeps {
  readonly alerts: AlertEmitter;
  readonly stillPending: (organizationId: string, requestId: string) => Promise<boolean>;
  readonly recipients: (
    organizationId: string,
    patientId: string,
    docKind: schema.PortalSignatureDocKind,
  ) => Promise<readonly string[]>;
}

function text(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M31_SIGNATURE_PUSH_CONSUMER}: missing ${key}`);
  }
  return value;
}

export function buildM31SignatureRequestPushConsumer(
  deps: SignaturePushDeps,
): OutboxConsumerBinding {
  return {
    consumerName: M31_SIGNATURE_PUSH_CONSUMER,
    consumerModule: "m31",
    eventTypes: M31_SIGNATURE_PUSH_EVENTS,
    async handle(event: DispatchableOutboxEvent): Promise<void> {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const requestId = text(payload, "requestId");
      const patientId = text(payload, "patientId");
      const docKind = text(payload, "docKind") as schema.PortalSignatureDocKind;
      if (!(await deps.stillPending(event.organizationId, requestId))) return;
      const recipientUserIds = await deps.recipients(event.organizationId, patientId, docKind);
      if (recipientUserIds.length === 0) return;
      await deps.alerts.emit(event.organizationId, {
        eventType: M31_SIGNATURE_PUSH_ALERT,
        severity: "info",
        correlationId: `signature_request:${requestId}:${event.id}`,
        // Ids only. The rule reads `recipientUserIds`; the text a phone shows is the sanitizer's generic line.
        payload: { recipientUserIds, requestId },
      });
    },
  };
}
