// @wardenx/subscription-billing — §4.14 the webhook INGESTION core (pure core, M35-T04).
//
// The receive-side counterpart to the dispatcher: verify → age-check → dedup → single outbox emit, which
// DECOUPLES receipt from processing (the `stripe-webhook-handler` worker drains `m35.stripe.webhook_received`
// later and dispatches to per-event-type handlers). Pure over injected ports — the T06 route owns the raw
// body plumbing + the Fastify reply codes, calling this and mapping the {@link WebhookIngestResult} kind to
// HTTP (401 invalid_signature / 410 too_old / 200 duplicate|accepted). Returning a typed result (not
// writing a reply here) keeps the security-critical ordering unit-testable.
//
// Ordering matters for security:
//   1. verify signature FIRST (unauthenticated bytes are never trusted, never logged)
//   2. reject events older than the 30-day replay window
//   3. dedup insert (ON CONFLICT DO NOTHING) — the payload is envelope-encrypted (D15) BEFORE it lands
//   4. emit exactly ONE outbox event on a genuinely-new receipt

import type { IsoInstant, M35StripeWebhookReceivedPayload, OrgId } from "@wardenx/types";
import { type OutboxIntent, outboxIntent } from "../service/ports";
import { verifyStripeWebhook } from "./webhook-verifier";
import type { StripeEventEnvelope, StripeWebhookEventStore, WebhookPayloadEncryptor } from "./types";

/** §4.14 replay window: an event whose `created` is older than this is rejected (HTTP 410). */
export const WEBHOOK_MAX_AGE_DAYS = 30;
const MS_PER_DAY = 86_400_000;

/** The typed outcome the T06 route maps to an HTTP status. */
export type WebhookIngestResult =
  | { readonly kind: "invalid_signature" } // → 401
  | { readonly kind: "too_old" } // → 410
  | { readonly kind: "duplicate" } // → 200 (Stripe TOS wants a fast 200 even on replays)
  | { readonly kind: "accepted"; readonly stripeEventId: string; readonly outbox: readonly OutboxIntent[] }; // → 200

export interface WebhookIngestDeps {
  readonly store: StripeWebhookEventStore;
  readonly encryptor: WebhookPayloadEncryptor;
  readonly webhookSecret: string;
  /** Injected clock (Unix ms). */
  readonly nowMs: () => number;
  /** Best-effort tenant resolution from the event body (nullable — a webhook may span tenants). */
  readonly resolveOrgFromEvent?: (event: StripeEventEnvelope) => OrgId | null;
  /** Override the verifier's signature tolerance (seconds). */
  readonly toleranceSeconds?: number;
}

export interface WebhookIngestInput {
  readonly rawBody: string;
  readonly signatureHeader: string | undefined;
}

/**
 * §4.14 — ingest one inbound Stripe webhook. Verifies the HMAC signature, enforces the 30-day replay
 * window, dedups on the Stripe event id, and (only on a genuinely-new receipt) returns the single
 * `m35.stripe.webhook_received` outbox intent for the caller to publish in-transaction.
 */
export async function ingestStripeWebhook(
  deps: WebhookIngestDeps,
  input: WebhookIngestInput,
): Promise<WebhookIngestResult> {
  // (1) verify — any failure is an opaque 401; the verifier never surfaces the payload.
  let event: StripeEventEnvelope;
  try {
    event = verifyStripeWebhook({
      rawBody: input.rawBody,
      signatureHeader: input.signatureHeader,
      webhookSecret: deps.webhookSecret,
      nowMs: deps.nowMs(),
      toleranceSeconds: deps.toleranceSeconds,
    });
  } catch {
    return { kind: "invalid_signature" };
  }

  // (2) 30-day replay window.
  const ageMs = deps.nowMs() - event.created * 1000;
  if (ageMs > WEBHOOK_MAX_AGE_DAYS * MS_PER_DAY) {
    return { kind: "too_old" };
  }

  // (3) dedup insert — payload envelope-encrypted (D15) before it reaches the store.
  const receivedAt = new Date(deps.nowMs());
  const { ciphertext, dekRef } = deps.encryptor.encrypt(JSON.stringify(event.raw));
  const derivedOrganizationId = deps.resolveOrgFromEvent?.(event) ?? null;

  const { inserted } = await deps.store.insertIfNew({
    id: event.id,
    eventType: event.type,
    apiVersion: event.apiVersion,
    payloadCiphertext: ciphertext,
    payloadDekRef: dekRef,
    receivedAt,
    signatureVerifiedAt: receivedAt,
    derivedOrganizationId,
  });

  if (!inserted) {
    return { kind: "duplicate" };
  }

  // (4) single outbox emit — decouples receipt from processing.
  const payload: M35StripeWebhookReceivedPayload = {
    stripeEventId: event.id,
    eventType: event.type,
    receivedAt: receivedAt.toISOString() as IsoInstant,
    derivedOrganizationId,
  };
  return {
    kind: "accepted",
    stripeEventId: event.id,
    outbox: [outboxIntent("m35.stripe.webhook_received", payload)],
  };
}
