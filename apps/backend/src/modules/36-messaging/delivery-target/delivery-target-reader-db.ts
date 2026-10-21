// apps/backend/src/modules/36-messaging/delivery-target/delivery-target-reader-db.ts - WP 4.8 (ADR-0075): resolve the opaque
// `notification_delivery` id carried by an out-of-band link (`{origin}/n/{id}`) to the in-app target it is about.
//
// The id is not an access grant. This read runs as the signed-in user inside their organisation (RLS on app.org_id through the
// alert) and ALSO requires, explicitly, that the delivery's recipient is that user. The target is read from the PERSISTED alert
// row (never from the link) and must still exist: the message must be in that channel, in this organisation and not deleted.
// Returns ids only. Every miss (absent, malformed, someone else's, another tenant's, an alert with no messaging target, a deleted
// message) is the same `null`.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, isNull } from "drizzle-orm";

const ND = schema.notificationDeliveries;
const AL = schema.alerts;
const MSG = schema.messages;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DeliveryTargetIds {
  readonly channelId: string;
  readonly messageId: string;
}

/** The ids the page navigates with; `ackRequestId` is the open request on the message, if any (so the page can land on its card). */
export interface DeliveryTarget extends DeliveryTargetIds {
  readonly ackRequestId: string | null;
}

export type DeliveryTargetReader = (
  orgId: string,
  userId: string,
  deliveryId: string,
) => Promise<DeliveryTargetIds | null>;

const idOf = (value: unknown): string | null =>
  typeof value === "string" && UUID.test(value) ? value : null;

export function createDbDeliveryTargetReader(db: DbClient): DeliveryTargetReader {
  return async (orgId, userId, deliveryId) => {
    if (!UUID.test(deliveryId) || !UUID.test(orgId) || !UUID.test(userId)) return null;
    return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
      const [delivery] = await tx
        .select({ payload: AL.payload })
        .from(ND)
        .innerJoin(AL, eq(AL.id, ND.alertId))
        .where(
          and(eq(ND.id, deliveryId), eq(ND.recipientUserId, userId), eq(AL.organizationId, orgId)),
        )
        .limit(1);
      const payload = (delivery?.payload ?? {}) as Record<string, unknown>;
      const channelId = idOf(payload.channelId);
      const messageId = idOf(payload.messageId) ?? idOf(payload.sourceAggregateId);
      if (!delivery || !channelId || !messageId) return null;
      const [message] = await tx
        .select({ id: MSG.id })
        .from(MSG)
        .where(
          and(
            eq(MSG.id, messageId),
            eq(MSG.channelId, channelId),
            eq(MSG.organizationId, orgId),
            isNull(MSG.deletedAt),
          ),
        )
        .limit(1);
      if (!message) return null;
      return { channelId, messageId };
    });
  };
}
