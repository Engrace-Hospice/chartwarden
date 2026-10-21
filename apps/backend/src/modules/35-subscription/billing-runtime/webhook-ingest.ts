import { schema } from "@chartwarden/db";
// apps/backend/src/modules/35-subscription/billing-runtime/webhook-ingest.ts - GAP-058.
//
// Binds the M35 inbound webhook route to the §4.14 ingestion core (`ingestStripeWebhook`): HMAC verify with
// `STRIPE_WEBHOOK_SECRET`, the 30-day replay window, a dedup insert into `stripe_webhook_event` (platform-only
// table => the platform runner), and D15 AES-GCM encryption of the payload before it lands.
//
// RECEIPT vs PROCESSING. The core returns an `m35.stripe.webhook_received` outbox intent; that event is
// internal, org-less (`derivedOrganizationId` is usually null) and has no declared consumer, so it is NOT
// published here. The durable "to process" signal is the row itself (`processed_at IS NULL`, indexed), drained
// by the `m35.webhook_handler` sweep (./webhook-handler.ts) - which survives a lost job and needs no
// platform-wide outbox write.
import {
  type StripeEventEnvelope,
  type StripeWebhookEventStore,
  type WebhookPayloadEncryptor,
  ingestStripeWebhook,
} from "@chartwarden/subscription-billing";
import type { PlatformRunner } from "../routes/service-drizzle";
import type { M35WebhookIngest } from "../routes/webhooks.routes";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface M35WebhookIngestDeps {
  readonly platformRunner: PlatformRunner;
  readonly webhookSecret: string;
  readonly encryptor: WebhookPayloadEncryptor;
  readonly nowMs?: () => number;
  /** Test seam: replaces the Drizzle store. Production leaves it unset. */
  readonly store?: StripeWebhookEventStore;
}

/** Tenant attribution is best-effort and ONLY from a value M35 itself stamped on the Stripe object. */
export function orgFromStripeMetadata(event: StripeEventEnvelope): string | null {
  const data = event.raw.data as { object?: { metadata?: Record<string, unknown> } } | undefined;
  const candidate = data?.object?.metadata?.organization_id;
  return typeof candidate === "string" && UUID_RE.test(candidate) ? candidate : null;
}

export function createDrizzleWebhookEventStore(
  platformRunner: PlatformRunner,
): StripeWebhookEventStore {
  return {
    async insertIfNew(row) {
      return platformRunner(async (tx) => {
        const inserted = await tx
          .insert(schema.stripeWebhookEvent)
          .values({
            id: row.id,
            eventType: row.eventType,
            apiVersion: row.apiVersion,
            payloadCiphertext: row.payloadCiphertext,
            payloadDekRef: row.payloadDekRef,
            receivedAt: row.receivedAt,
            signatureVerifiedAt: row.signatureVerifiedAt,
            derivedOrganizationId: row.derivedOrganizationId,
          })
          .onConflictDoNothing({ target: schema.stripeWebhookEvent.id })
          .returning({ id: schema.stripeWebhookEvent.id });
        return { inserted: inserted.length > 0 };
      });
    },
  };
}

/** Build the {@link M35WebhookIngest} the `/api/v1/webhooks/stripe` route calls. */
export function buildM35WebhookIngest(deps: M35WebhookIngestDeps): M35WebhookIngest {
  const store = deps.store ?? createDrizzleWebhookEventStore(deps.platformRunner);
  const nowMs = deps.nowMs ?? Date.now;
  return async ({ rawBody, signatureHeader }) => {
    const result = await ingestStripeWebhook(
      {
        store,
        encryptor: deps.encryptor,
        webhookSecret: deps.webhookSecret,
        nowMs,
        resolveOrgFromEvent: (event) =>
          orgFromStripeMetadata(event) as ReturnType<
            NonNullable<Parameters<typeof ingestStripeWebhook>[0]["resolveOrgFromEvent"]>
          >,
      },
      { rawBody, signatureHeader },
    );
    return { kind: result.kind };
  };
}
