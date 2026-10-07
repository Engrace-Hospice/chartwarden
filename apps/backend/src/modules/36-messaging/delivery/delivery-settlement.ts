// apps/backend/src/modules/36-messaging/delivery/delivery-settlement.ts — GAP-101.
//
// The ONE place a `notification_delivery` row moves forward after the in-app floor (§2.4.4), shared by the
// out-of-band dispatcher (`sent` / `delivered` / terminal `failed`) and the vendor webhook reconcile
// (`delivered` / `failed`). Every call runs inside the caller's `withOrgContext` transaction, so the status
// write, the parent alert's §2.4.3 roll-up and — on a terminal failure — the `m36.notification.delivery_failed`
// outbox row commit or roll back together (an alert is never recorded failed without its escalation event).
//
// FORWARD-ONLY + IDEMPOTENT: the row is locked (`FOR UPDATE`) and `canTransition` refuses any move that is not
// strictly forward, so a duplicate, replayed or out-of-order callback is a no-op that writes (and audits)
// nothing. The roll-up skips an unchanged outcome for the same reason (the M4 trigger fires on every UPDATE).
import { type DbClient, schema } from "@wardenx/db";
import {
  type NotificationChannel,
  type NotificationStatus,
  type VendorTransition,
  canTransition,
  rollUpAlertOutcome,
} from "@wardenx/messaging";
import { and, eq, isNull, or, sql } from "drizzle-orm";

export type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const ND = schema.notificationDeliveries;
const AL = schema.alerts;
const AR = schema.alertRules;

/** The outbox publisher shape the M36 delivery code needs (the `bindCallerModule(txOutboxPublisher, "m36")` shape). */
export interface DeliveryOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export const DELIVERY_FAILED_EVENT = "m36.notification.delivery_failed";

type RecipientKind = "on_call" | "role_set" | "care_team" | "individual" | "other";

const RECIPIENT_KIND_BY_RESOLVER: Readonly<Record<string, RecipientKind | undefined>> = {
  on_call: "on_call",
  role_set: "role_set",
  care_team: "care_team",
  user_list: "individual",
};

export type SettleResult = "applied" | "ignored";

/** What a transition may also stamp on the row. */
export interface DeliveryPatch {
  readonly vendorMessageId?: string;
  readonly endpointId?: string | null;
}

/** Re-settle the parent alert's `outcome` from its live delivery set (§2.4.3). No-change writes are skipped. */
export async function rollUpAlert(tx: Tx, organizationId: string, alertId: string): Promise<void> {
  const siblings = await tx
    .select({
      recipientUserId: ND.recipientUserId,
      channel: ND.channel,
      status: ND.status,
    })
    .from(ND)
    .where(eq(ND.alertId, alertId));
  const outcome = rollUpAlertOutcome(
    siblings.map((s) => ({
      recipientUserId: s.recipientUserId,
      channel: s.channel as NotificationChannel,
      status: s.status as NotificationStatus,
    })),
  );
  await tx
    .update(AL)
    .set({ outcome })
    .where(
      and(
        eq(AL.organizationId, organizationId),
        eq(AL.id, alertId),
        sql`${AL.outcome} <> ${outcome}`,
      ),
    );
}

async function recipientKindOf(
  tx: Tx,
  organizationId: string,
  eventType: string,
): Promise<RecipientKind> {
  const [rule] = await tx
    .select({ resolver: AR.recipientResolver })
    .from(AR)
    .where(
      and(
        eq(AR.eventType, eventType),
        eq(AR.enabled, true),
        or(isNull(AR.organizationId), eq(AR.organizationId, organizationId)),
      ),
    )
    .orderBy(sql`${AR.organizationId} IS NULL`) // the tenant's own row shadows the platform default
    .limit(1);
  return (rule && RECIPIENT_KIND_BY_RESOLVER[rule.resolver]) || "other";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function publishDeliveryFailed(
  tx: Tx,
  outbox: DeliveryOutboxPort,
  input: {
    readonly organizationId: string;
    readonly deliveryId: string;
    readonly alertId: string;
    readonly channel: string;
    readonly failReason: string;
    readonly failedAt: Date;
  },
): Promise<void> {
  const [alert] = await tx
    .select({ eventType: AL.eventType, payload: AL.payload })
    .from(AL)
    .where(and(eq(AL.organizationId, input.organizationId), eq(AL.id, input.alertId)))
    .limit(1);
  const alertPayload = (alert?.payload ?? {}) as Record<string, unknown>;
  await outbox.publish(tx, {
    eventName: DELIVERY_FAILED_EVENT,
    organizationId: input.organizationId,
    aggregateKind: "notification_delivery",
    aggregateId: input.deliveryId,
    payload: {
      notificationId: input.deliveryId,
      organizationId: input.organizationId,
      channel: input.channel,
      failureReason: input.failReason,
      failedAt: input.failedAt.toISOString(),
      recipientKind: alert
        ? await recipientKindOf(tx, input.organizationId, alert.eventType)
        : "other",
      // The recipient's MEMBERSHIP id is not on the delivery row (it carries the user id only); consumers that
      // need it resolve it from the org's own roster. Null is the catalog's declared "unknown".
      recipientMembershipId: null,
      providerEntityId: stringOrNull(alertPayload.providerEntityId),
      alertEventType: alert?.eventType ?? null,
      // The emitting module names the domain entity the alert was ABOUT under `sourceAggregateId`; an alert
      // that does not carry it yields null (consumers gate on `alertEventType`'s `mN.` prefix anyway).
      sourceAggregateId: stringOrNull(alertPayload.sourceAggregateId),
    },
  });
}

/**
 * Move one delivery forward to `next` (`sent` | `delivered` | `failed`) when — and only when — that is a
 * strictly forward move for its current state. Locks the row, writes the transition, re-rolls the parent
 * alert and, on `failed`, publishes `m36.notification.delivery_failed` in the same transaction.
 */
export async function applyDeliveryTransition(
  tx: Tx,
  outbox: DeliveryOutboxPort,
  input: {
    readonly organizationId: string;
    readonly deliveryId: string;
    readonly transition: VendorTransition;
    readonly patch?: DeliveryPatch;
    readonly now: Date;
  },
): Promise<SettleResult> {
  const { organizationId, deliveryId, transition, now } = input;
  const locked = await tx.execute<{
    status: NotificationStatus;
    alert_id: string;
    channel: string;
  }>(sql`
    SELECT nd.status, nd.alert_id, nd.channel
      FROM notification_delivery nd
      JOIN alert a ON a.id = nd.alert_id
     WHERE nd.id = ${deliveryId} AND a.organization_id = ${organizationId}
       FOR UPDATE OF nd
  `);
  const row = locked.rows[0];
  if (!row || !canTransition(row.status, transition.status)) return "ignored";

  const terminal = transition.status !== "sent";
  await tx
    .update(ND)
    .set({
      status: transition.status,
      failReason: transition.failReason,
      sentAt: sql`COALESCE(${ND.sentAt}, ${now.toISOString()}::timestamptz)`,
      settledAt: terminal ? now : null,
      claimedUntil: null,
      nextAttemptAt: null,
      ...(input.patch?.vendorMessageId ? { vendorMessageId: input.patch.vendorMessageId } : {}),
      ...(input.patch?.endpointId ? { endpointId: input.patch.endpointId } : {}),
    })
    .where(eq(ND.id, deliveryId));
  await rollUpAlert(tx, organizationId, row.alert_id);
  if (transition.status === "failed") {
    await publishDeliveryFailed(tx, outbox, {
      organizationId,
      deliveryId,
      alertId: row.alert_id,
      channel: row.channel,
      failReason: transition.failReason ?? "unknown",
      failedAt: now,
    });
  }
  return "applied";
}
