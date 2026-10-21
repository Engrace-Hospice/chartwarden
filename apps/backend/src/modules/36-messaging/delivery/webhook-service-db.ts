// apps/backend/src/modules/36-messaging/delivery/webhook-service-db.ts — GAP-101: the production
// `MessagingWebhookService` (the §4.4 `delivery_reconcile` path every §4.9 webhook handler ends in).
//
// A vendor callback carries NO tenant: its only key is the vendor message id the dispatcher stored. The id is
// resolved to (delivery, organization) by migration 0355's `notification_delivery_locate_by_vendor` — a
// SECURITY DEFINER lookup that returns ids and nothing else — and EVERYTHING after that runs inside
// `withOrgContext` for the located tenant, under ordinary RLS. A callback can therefore only ever touch the one
// delivery whose stored vendor id it names; an unknown id (a send this deployment never made) or an ambiguous
// one (more than one match — vendor ids are unique, so this is a data fault) is dropped, never guessed.
//
// IDEMPOTENT: the transition is forward-only (`canTransition`), so a duplicate / replayed / out-of-order
// callback is a no-op that writes and audits nothing; status strings that imply no transition (an SMS
// `queued`, a Postmark `Open`) are ignored. The vendor payload is NOT persisted (it can echo recipient data).
import type { DbClient } from "@chartwarden/db";
import { type VendorCallbackKind, mapVendorStatus } from "@chartwarden/messaging";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import type { MessagingWebhookService, VendorDeliveryUpdate } from "../routes/webhook-routes";
import { type DeliveryOutboxPort, applyDeliveryTransition } from "./delivery-settlement";

const CHANNEL_BY_KIND = {
  twilio_sms: "sms",
  twilio_voice: "voice",
  postmark_event: "email",
} as const satisfies Record<VendorCallbackKind, string>;

export interface WebhookServiceDeps {
  readonly db: DbClient;
  readonly outbox: DeliveryOutboxPort;
  readonly now?: () => Date;
  readonly onUnmatched?: (
    kind: VendorCallbackKind,
    vendorMessageId: string,
    matches: number,
  ) => void;
}

export function createDbMessagingWebhookService(deps: WebhookServiceDeps): MessagingWebhookService {
  const { db, outbox } = deps;

  async function reconcile(kind: VendorCallbackKind, update: VendorDeliveryUpdate): Promise<void> {
    const transition = mapVendorStatus(
      kind,
      update.status,
      update.raw.ErrorCode ?? update.raw.Type,
    );
    if (!transition || update.vendorMessageId === "") return;

    const channel = CHANNEL_BY_KIND[kind];
    const located = await db.execute<{ delivery_id: string; organization_id: string }>(sql`
      SELECT delivery_id, organization_id
        FROM notification_delivery_locate_by_vendor(${channel}::notification_channel, ${update.vendorMessageId})
    `);
    const match = located.rows[0];
    if (located.rows.length !== 1 || !match) {
      deps.onUnmatched?.(kind, update.vendorMessageId, located.rows.length);
      return;
    }

    await withOrgContext(db, { organizationId: match.organization_id, userId: "" }, (tx) =>
      applyDeliveryTransition(tx, outbox, {
        organizationId: match.organization_id,
        deliveryId: match.delivery_id,
        transition,
        now: (deps.now ?? (() => new Date()))(),
      }),
    );
  }

  return {
    recordTwilioSmsStatus: (update) => reconcile("twilio_sms", update),
    recordTwilioVoiceStatus: (update) => reconcile("twilio_voice", update),
    recordPostmarkEvent: (update) => reconcile("postmark_event", update),
  };
}
