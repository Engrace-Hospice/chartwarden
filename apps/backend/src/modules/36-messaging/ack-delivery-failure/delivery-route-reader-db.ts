// apps/backend/src/modules/36-messaging/ack-delivery-failure/delivery-route-reader-db.ts - WP 4.5: the read the delivery-failure
// consumer needs. Given the delivery that just failed, what are ALL the routes of that alert to that recipient? Read-only, inside the
// tenant's system scope (notification_delivery is isolated through its parent alert's organization, so a delivery id from another
// tenant reads as absent). Ids, enums and instants only.
import { type DbClient, schema } from "@wardenx/db";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";

export interface DeliveryRouteState {
  readonly alertEventType: string;
  readonly alertCreatedAt: Date;
  readonly recipientUserId: string;
  /** Every route of that alert to that recipient, the in-app floor included. */
  readonly routes: readonly { readonly channel: string; readonly status: string }[];
}

export type DeliveryRouteReader = (
  orgId: string,
  deliveryId: string,
) => Promise<DeliveryRouteState | null>;

const ND = schema.notificationDeliveries;
const AL = schema.alerts;

export function createDeliveryRouteReader(db: DbClient): DeliveryRouteReader {
  return (orgId, deliveryId) =>
    withOrgContext(db, systemOrgContext(orgId), async (tx) => {
      const [failed] = await tx
        .select({
          alertId: ND.alertId,
          recipientUserId: ND.recipientUserId,
          alertEventType: AL.eventType,
          alertCreatedAt: AL.createdAt,
        })
        .from(ND)
        .innerJoin(AL, eq(AL.id, ND.alertId))
        .where(and(eq(ND.id, deliveryId), eq(AL.organizationId, orgId)))
        .limit(1);
      if (!failed) return null;
      const routes = await tx
        .select({ channel: ND.channel, status: ND.status })
        .from(ND)
        .where(and(eq(ND.alertId, failed.alertId), eq(ND.recipientUserId, failed.recipientUserId)));
      return {
        alertEventType: failed.alertEventType,
        alertCreatedAt: failed.alertCreatedAt,
        recipientUserId: failed.recipientUserId,
        routes,
      };
    });
}
