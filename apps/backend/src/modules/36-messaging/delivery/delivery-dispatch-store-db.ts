// apps/backend/src/modules/36-messaging/delivery/delivery-dispatch-store-db.ts — GAP-101.
//
// The Drizzle side of the out-of-band dispatcher: claim a bounded batch of `pending` push/sms/voice/email
// deliveries under a lease, resolve each recipient's verified endpoint, and persist the outcome.
//
// TENANCY: every statement runs in `withOrgContext(db, { organizationId, userId: "" }, …)` — a sweep is a
// worker, not a request, and the org is the enumerated one. `notification_delivery` inherits RLS from its
// parent alert, so the claim only ever sees this org's rows. The recipient's endpoint is USER-owned (RLS on
// app.user_id) and is reached ONLY through migration 0355's `delivery_endpoint_for_delivery`, which is scoped
// by (organization, delivery) — it cannot be pointed at another tenant's recipient.
//
// CLAIM = LEASE: `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING` stamps `claimed_until`
// and bumps `attempt_count` in one statement, so two instances never claim the same row, and a crash between
// the vendor call and the write-back simply lets the lease lapse and the row be retried (at-least-once; a row
// that already holds a vendor id is NOT re-sent — see `dispatchClaimedDelivery`).
import { type DbClient, schema } from "@chartwarden/db";
import type {
  AlertCategory,
  AlertSeverity,
  ClaimedDelivery,
  OutOfBandTransportChannel,
  ResolvedDestination,
} from "@chartwarden/messaging";
import { encodeNativeDestination } from "@chartwarden/messaging";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq, sql } from "drizzle-orm";
import { type DeliveryOutboxPort, type Tx, applyDeliveryTransition } from "./delivery-settlement";

const ND = schema.notificationDeliveries;

type ClaimRow = {
  id: string;
  alert_id: string;
  recipient_user_id: string;
  channel: OutOfBandTransportChannel;
  alert_category: AlertCategory;
  alert_severity: AlertSeverity;
  attempt_count: number;
  vendor_message_id: string | null;
};

export interface DeliveryDispatchStore {
  claimBatch(
    organizationId: string,
    channel: OutOfBandTransportChannel,
    limit: number,
    now: Date,
    leaseMs: number,
  ): Promise<readonly ClaimedDelivery[]>;
  resolveDestination(claim: ClaimedDelivery): Promise<ResolvedDestination | null>;
  markSent(
    claim: ClaimedDelivery,
    vendorMessageId: string,
    endpointId: string | null,
    settlesOnAcceptance: boolean,
    now: Date,
  ): Promise<void>;
  scheduleRetry(
    claim: ClaimedDelivery,
    reason: string,
    delayMs: number,
    endpointId: string | null,
    now: Date,
  ): Promise<void>;
  markFailed(
    claim: ClaimedDelivery,
    reason: string,
    endpointId: string | null,
    now: Date,
  ): Promise<void>;
}

export function createDrizzleDeliveryDispatchStore(
  db: DbClient,
  outbox: DeliveryOutboxPort,
): DeliveryDispatchStore {
  const inOrg = <T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: "" }, fn);

  // Endpoint health is bookkeeping for the NEXT send; a failure to record it must not undo a settled delivery.
  const recordEndpointResult = (claim: ClaimedDelivery, success: boolean) =>
    inOrg(claim.organizationId, async (tx) => {
      await tx.execute(
        sql`SELECT delivery_endpoint_record_result(${claim.organizationId}, ${claim.deliveryId}, ${success})`,
      );
    });

  return {
    claimBatch(organizationId, channel, limit, now, leaseMs) {
      const leaseUntil = new Date(now.getTime() + leaseMs);
      return inOrg(organizationId, async (tx) => {
        const res = await tx.execute<ClaimRow>(sql`
          UPDATE notification_delivery nd
             SET claimed_until = ${leaseUntil.toISOString()}::timestamptz,
                 attempt_count = nd.attempt_count + 1
           WHERE nd.id IN (
                 SELECT d.id
                   FROM notification_delivery d
                   JOIN alert a ON a.id = d.alert_id
                  WHERE a.organization_id = ${organizationId}
                    AND d.channel = ${channel}
                    AND d.status = 'pending'
                    AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ${now.toISOString()}::timestamptz)
                    AND (d.claimed_until IS NULL OR d.claimed_until < ${now.toISOString()}::timestamptz)
                  ORDER BY d.queued_at
                  LIMIT ${limit}
                    FOR UPDATE OF d SKIP LOCKED)
          RETURNING nd.id, nd.alert_id, nd.recipient_user_id, nd.channel, nd.alert_category,
                    nd.alert_severity, nd.attempt_count, nd.vendor_message_id
        `);
        return res.rows.map((r) => ({
          deliveryId: r.id,
          organizationId,
          alertId: r.alert_id,
          recipientUserId: r.recipient_user_id,
          channel: r.channel,
          alertCategory: r.alert_category,
          alertSeverity: r.alert_severity,
          attemptCount: Number(r.attempt_count),
          vendorMessageId: r.vendor_message_id,
        }));
      });
    },

    resolveDestination(claim) {
      return inOrg(claim.organizationId, async (tx) => {
        const res = await tx.execute<{
          endpoint_id: string;
          endpoint_value: string;
          provider: "web" | "fcm" | "apns";
          alert_id: string;
        }>(sql`
          SELECT endpoint_id, endpoint_value, provider, alert_id
            FROM delivery_endpoint_for_delivery(${claim.organizationId}, ${claim.deliveryId})
        `);
        const row = res.rows[0];
        if (!row) return null;
        // Remember which endpoint this attempt targets, so the health bookkeeping (and the webhook's audit
        // trail) can name it.
        await tx.update(ND).set({ endpointId: row.endpoint_id }).where(eq(ND.id, claim.deliveryId));
        // A native endpoint stores a bare device token; the transport wants the token AND the alert hint, so encode both.
        const value =
          row.provider === "web"
            ? row.endpoint_value
            : encodeNativeDestination({
                provider: row.provider,
                token: row.endpoint_value,
                alertId: row.alert_id,
              });
        return { endpointId: row.endpoint_id, value };
      });
    },

    async markSent(claim, vendorMessageId, endpointId, settlesOnAcceptance, now) {
      await inOrg(claim.organizationId, (tx) =>
        applyDeliveryTransition(tx, outbox, {
          organizationId: claim.organizationId,
          deliveryId: claim.deliveryId,
          transition: { status: settlesOnAcceptance ? "delivered" : "sent", failReason: null },
          patch: { vendorMessageId, endpointId },
          now,
        }),
      );
      if (endpointId) await recordEndpointResult(claim, true);
    },

    async scheduleRetry(claim, reason, delayMs, endpointId, now) {
      await inOrg(claim.organizationId, async (tx) => {
        await tx
          .update(ND)
          .set({
            failReason: reason,
            claimedUntil: null,
            nextAttemptAt: new Date(now.getTime() + delayMs),
          })
          .where(eq(ND.id, claim.deliveryId));
      });
      if (endpointId) await recordEndpointResult(claim, false);
    },

    async markFailed(claim, reason, endpointId, now) {
      await inOrg(claim.organizationId, (tx) =>
        applyDeliveryTransition(tx, outbox, {
          organizationId: claim.organizationId,
          deliveryId: claim.deliveryId,
          transition: { status: "failed", failReason: reason },
          now,
        }),
      );
      if (endpointId) await recordEndpointResult(claim, false);
    },
  };
}
