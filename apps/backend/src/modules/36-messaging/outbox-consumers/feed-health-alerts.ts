// apps/backend/src/modules/36-messaging/outbox-consumers/feed-health-alerts.ts - M36's consumer of M29's listener-health
// events (GAP-043). The worker-role watcher publishes `m29.external_feed.listener_down` / `listener_recovered` in the same
// transaction that moves the feed's breaker state; this turns them into the M36 alerts.
//
//   m29.external_feed.listener_down       -> external_feed.listener_down       critical  (seeded role_set rule)
//   m29.external_feed.listener_recovered  -> external_feed.listener_recovered  info      (seeded role_set rule)
//
// ONE PAGE PER OUTAGE. The correlation id is `outbox:<alertType>:<feedId>:<outageOpenedAt>` - the instant the outage
// opened, not an hour bucket - so a redelivered event is absorbed by the `(organization_id, correlation_id)` dedupe, a
// second outage of the same feed pages again, and the recovered notice shares its outage's key. The spec says the alert
// "auto-resolves in M36", but `alert` has no open/resolved state (only an `outcome`), so the honest equivalent is this paired
// recovered notice on the same feed.
// TENANT from the envelope `event.organizationId`, never the payload copy. NO host, port or certificate in the alert: ids,
// enums and instants only. A malformed event THROWS (relay retry -> DLQ), never a silently dropped page.
import type { AlertEmitter, AlertSeverity } from "@chartwarden/messaging";

import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

export const M36_FEED_HEALTH_ALERT_CONSUMER = "m36.feed-health-alerts" as const;

export const M36_FEED_HEALTH_ALERT_EVENT_TYPES = [
  "m29.external_feed.listener_down",
  "m29.external_feed.listener_recovered",
] as const;

export interface FeedHealthAlertPlan {
  readonly alertType: "external_feed.listener_down" | "external_feed.listener_recovered";
  readonly severity: AlertSeverity;
  readonly correlationId: string;
  readonly payload: Record<string, unknown>;
}

function requireString(p: Record<string, unknown>, key: string, eventName: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${M36_FEED_HEALTH_ALERT_CONSUMER}: ${eventName} payload has no ${key}`);
  }
  return v;
}

/** The alert one listener-health event raises. Throws on a malformed payload. */
export function planFeedHealthAlert(event: DispatchableOutboxEvent): FeedHealthAlertPlan {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const name = event.eventType;
  if (
    name !== "m29.external_feed.listener_down" &&
    name !== "m29.external_feed.listener_recovered"
  ) {
    throw new Error(`${M36_FEED_HEALTH_ALERT_CONSUMER}: unexpected event ${name}`);
  }
  const feedId = requireString(p, "feedId", name);
  const outageOpenedAt = requireString(p, "outageOpenedAt", name);
  const at = requireString(p, "at", name);
  const down = name === "m29.external_feed.listener_down";
  const alertType = down ? "external_feed.listener_down" : "external_feed.listener_recovered";
  return {
    alertType,
    severity: down ? "critical" : "info",
    correlationId: `outbox:${alertType}:${feedId}:${outageOpenedAt}`,
    payload: {
      eventType: alertType,
      feedId,
      outageOpenedAt,
      at,
      silentSeconds: p.silentSeconds ?? null,
      lastFrameAt: p.lastFrameAt ?? null,
      heartbeatStale: p.heartbeatStale === true,
      detail: down
        ? "Inbound HL7 feed has received no frame past its down-threshold and its listener is not serving. No inbound HL7 is being accepted on this feed."
        : "Inbound HL7 feed is serving again.",
    },
  };
}

export function buildM36FeedHealthAlertConsumer(alerts: AlertEmitter): OutboxConsumerBinding {
  return {
    consumerName: M36_FEED_HEALTH_ALERT_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_FEED_HEALTH_ALERT_EVENT_TYPES,
    async handle(event) {
      const plan = planFeedHealthAlert(event);
      await alerts.emit(event.organizationId, {
        eventType: plan.alertType,
        severity: plan.severity,
        correlationId: plan.correlationId,
        payload: plan.payload,
      });
    },
  };
}
