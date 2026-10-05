// apps/backend/src/modules/36-messaging/outbox-consumers/breakglass-alert.ts — GAP-010: M36's consumer for
// M3's `m3.breakglass.invoked` (M3 spec §4.5 / M03-F04; SD-017).
//
// M3 publishes the event in the break-glass invoke's OWN transaction (the row commits or rolls back with the
// grant), and this consumer hands it to M36's AlertEmitter, whose platform-default `alert_rule` for
// `m3.breakglass.invoked` routes it to the Compliance Officer (org_admin backstop). M3 never writes M36's
// `alert.new` directly and M36 is not an M3 dependency — the outbox is the only edge.
//
// DURABILITY: a failed emit makes `handle` throw, so the relay redelivers it. The alert is unique on
// `(organization_id, correlation_id)`, and the correlation id is derived from the grant id, so a redelivery
// after a partial success can never page twice.
//
// NO PHI: the event payload is ids and flags (no free-text reason, no patient record); it is forwarded verbatim.
import { Value } from "@sinclair/typebox/value";
import { M3_OUTBOX_EVENTS } from "../../03-authorization/events-by-m3";

export const M36_BREAKGLASS_ALERT_CONSUMER = {
  eventNames: ["m3.breakglass.invoked"] as const,
  consumerName: "m36.breakglass-alert",
} as const;

export interface BreakGlassAlertPort {
  emit(
    orgId: string,
    input: {
      eventType: string;
      payload: Record<string, unknown>;
      severity: "info" | "warn" | "critical";
      correlationId: string;
    },
  ): Promise<unknown>;
}

export interface BreakGlassAlertDeps {
  readonly alerts: BreakGlassAlertPort;
}

const INVOKED_SCHEMA = M3_OUTBOX_EVENTS.find(
  (entry) => entry.eventName === "m3.breakglass.invoked",
)!.payloadSchema;

export function buildM36BreakGlassAlertConsumer(deps: BreakGlassAlertDeps) {
  return {
    consumerName: M36_BREAKGLASS_ALERT_CONSUMER.consumerName,
    consumerModule: "m36" as const,
    eventTypes: [...M36_BREAKGLASS_ALERT_CONSUMER.eventNames],
    async handle(event: {
      readonly eventType: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const payload = event.payload;
      if (!Value.Check(INVOKED_SCHEMA, payload)) {
        // A permanent (poison) failure: name it and let the relay dead-letter it rather than retry forever.
        throw new Error(
          `${M36_BREAKGLASS_ALERT_CONSUMER.consumerName}: malformed m3.breakglass.invoked payload`,
        );
      }
      const facts = payload as Record<string, unknown> & { breakGlassId: string };
      await deps.alerts.emit(event.organizationId, {
        eventType: "m3.breakglass.invoked",
        payload: facts,
        severity: "critical",
        correlationId: `m3.breakglass.invoked:${facts.breakGlassId}`,
      });
    },
  };
}
