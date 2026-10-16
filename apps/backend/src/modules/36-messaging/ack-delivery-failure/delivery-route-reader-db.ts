// apps/backend/src/modules/36-messaging/ack-delivery-failure/delivery-route-reader-db.ts - WP 4.5: the read the delivery-failure
// consumer needs. Given the delivery that just failed, what are ALL the out-of-band routes the request's assignee has, across EVERY
// assignee-facing alert of the same message in the request's current window? (A failed urgent alert beside a delivered or still-pending
// request alert is not "unreachable".) The alert type and the message the alert is about come from the PERSISTED alert row, never from
// the event payload. Read-only, inside the tenant's system scope (notification_delivery is isolated through its parent alert's
// organization, so another tenant's delivery id reads as absent). Ids, enums and instants only.
import { type DbClient, schema } from "@wardenx/db";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { ACK_ASSIGNEE_ALERT_EVENT_TYPES, WINDOW_ALERT_TOLERANCE_MS } from "./route-rules";

export interface DeliveryRouteState {
  /** From the alert row of the failed delivery. */
  readonly alertEventType: string;
  /** The message that alert is about (`alert.payload.sourceAggregateId`), or null. */
  readonly sourceMessageId: string | null;
  readonly alertCreatedAt: Date;
  readonly recipientUserId: string;
  /** Every route of the recipient across the message's assignee-facing alerts in the current window, the in-app floor included. */
  readonly routes: readonly { readonly channel: string; readonly status: string }[];
}

export type DeliveryRouteReader = (
  orgId: string,
  deliveryId: string,
) => Promise<DeliveryRouteState | null>;

const ND = schema.notificationDeliveries;
const AL = schema.alerts;

/** When the request for a message started its current window (the request's store; this file never names the aggregate's tables). */
export type WindowStartOf = (orgId: string, messageId: string) => Promise<Date | null>;

export function createDeliveryRouteReader(
  db: DbClient,
  windowStartOf: WindowStartOf,
): DeliveryRouteReader {
  return async (orgId, deliveryId) => {
    const failed = await withOrgContext(db, systemOrgContext(orgId), async (tx) => {
      const [row] = await tx
        .select({
          recipientUserId: ND.recipientUserId,
          alertEventType: AL.eventType,
          alertCreatedAt: AL.createdAt,
          sourceMessageId: sql<string | null>`${AL.payload}->>'sourceAggregateId'`,
        })
        .from(ND)
        .innerJoin(AL, eq(AL.id, ND.alertId))
        .where(and(eq(ND.id, deliveryId), eq(AL.organizationId, orgId)))
        .limit(1);
      return row ?? null;
    });
    if (!failed) return null;
    const base = { ...failed };
    const messageId = failed.sourceMessageId;
    if (!messageId || !ACK_ASSIGNEE_ALERT_EVENT_TYPES.has(failed.alertEventType)) {
      return { ...base, routes: [] };
    }
    const windowStart = await windowStartOf(orgId, messageId);
    if (!windowStart) return { ...base, routes: [] };
    const since = new Date(windowStart.getTime() - WINDOW_ALERT_TOLERANCE_MS);
    const routes = await withOrgContext(db, systemOrgContext(orgId), (tx) =>
      tx
        .select({ channel: ND.channel, status: ND.status })
        .from(ND)
        .innerJoin(AL, eq(AL.id, ND.alertId))
        .where(
          and(
            eq(AL.organizationId, orgId),
            inArray(AL.eventType, [...ACK_ASSIGNEE_ALERT_EVENT_TYPES]),
            sql`${AL.payload}->>'sourceAggregateId' = ${messageId}`,
            eq(ND.recipientUserId, failed.recipientUserId),
            gte(AL.createdAt, since),
          ),
        ),
    );
    return { ...base, routes };
  };
}
