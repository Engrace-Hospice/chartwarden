// @wardenx/subscription-billing — §4.13 the outbox-only Stripe dispatcher (pure core, M35-T04).
//
// This is the D3 posture in one function: route handlers NEVER call Stripe — they emit a
// {@link StripeDispatchEvent} into the M35 outbox in the same transaction as the state mutation, and the
// `stripe-dispatcher` BullMQ worker drains it through here. The core is PURE over injected ports (the T03
// service idiom): the {@link StripeApiCallAuditStore} owns the Drizzle writes, the {@link StripeClient}
// owns the transport, the {@link StripeMirrorApplier} owns the mirror update. The dispatcher owns only the
// ORDER + the redaction + the retry/DLQ decision.
//
// Flow (§4.13):
//   1. derive the deterministic idempotency key (idempotency.ts)
//   2. pre-check: if a prior call with this key already succeeded → no-op (BullMQ re-drain safety)
//   3. insert the pre-call audit row (request redacted)
//   4. call Stripe with the idempotency key
//   5a. 2xx  → record response (redacted) + latency, apply to mirror
//   5b. err  → record failure; if retryable & attempt<5 → RETHROW (BullMQ backoff);
//              else → return the `m35.stripe.api_call_failed` outbox intent (DLQ + alert path)

import type { M35StripeApiCallFailedPayload } from "@wardenx/types";
import { type OutboxIntent, outboxIntent } from "../service/ports";
import { deriveIdempotencyKey } from "./idempotency";
import { redactForAudit } from "./redactor";
import type { StripeClient } from "./client";
import {
  isStripeApiError,
  type StripeApiCallAuditStore,
  type StripeDispatchEvent,
  type StripeMirrorApplier,
} from "./types";

/** The §4.13 max-attempt ceiling: a retryable error at attempt ≥ this stops retrying and goes to the DLQ. */
export const STRIPE_MAX_ATTEMPTS = 5;

/** Everything the dispatcher needs, injected (pure core — no Drizzle/clock/SDK import here). */
export interface StripeDispatcherDeps {
  readonly client: StripeClient;
  readonly auditStore: StripeApiCallAuditStore;
  readonly mirror: StripeMirrorApplier;
  /** Injected clock (Unix ms) for latency measurement — deterministic in tests. */
  readonly nowMs: () => number;
}

/** The terminal outcome of a single dispatch (a retryable transient failure THROWS instead — see below). */
export type StripeDispatchOutcome =
  | { readonly kind: "noop" } // pre-check found a prior success for this idempotency key
  | { readonly kind: "succeeded" } // 2xx, response applied to the mirror
  | { readonly kind: "failed_permanent"; readonly outbox: readonly OutboxIntent[] }; // DLQ + alert emit

/**
 * §4.13 — dispatch one outbound Stripe call. Resolves to a {@link StripeDispatchOutcome} on a terminal
 * result; **throws the original error** for a retryable transient failure below {@link STRIPE_MAX_ATTEMPTS}
 * so the BullMQ worker's backoff/retry drives the re-attempt (a new event with `attemptIndex+1`).
 */
export async function dispatchStripeCall(
  deps: StripeDispatcherDeps,
  event: StripeDispatchEvent,
): Promise<StripeDispatchOutcome> {
  const idempotencyKey = deriveIdempotencyKey(event);

  // (2) pre-check — a re-drained job for an already-succeeded attempt is a no-op before any Stripe call.
  if (await deps.auditStore.hasSucceededForIdempotencyKey(idempotencyKey)) {
    return { kind: "noop" };
  }

  // (3) pre-call audit row — request envelope redacted BEFORE it crosses the store port.
  const { auditId } = await deps.auditStore.insertCall({
    stripeIdempotencyKey: idempotencyKey,
    operation: event.operation,
    targetResourceId: event.targetResourceId,
    organizationId: event.organizationId,
    requestEnvelopeRedacted: redactForAudit(event.payload),
    attemptIndex: event.attemptIndex,
  });

  const startedAt = deps.nowMs();
  try {
    // (4) the one outbound call — carries the deterministic idempotency key.
    const response = await deps.client.execute(
      { operation: event.operation, payload: event.payload },
      { idempotencyKey },
    );
    const latencyMs = deps.nowMs() - startedAt;

    // (5a) success — record (redacted) + apply to mirror.
    await deps.auditStore.recordSuccess({
      auditId,
      responseStatusCode: response.statusCode,
      responseEnvelopeRedacted: redactForAudit(response.body),
      latencyMs,
    });
    await deps.mirror.apply(event, response);
    return { kind: "succeeded" };
  } catch (err) {
    const latencyMs = deps.nowMs() - startedAt;
    const statusCode = isStripeApiError(err) ? err.statusCode : 0;
    const errorText = err instanceof Error ? err.message : String(err);
    const retryable = isStripeApiError(err) ? err.retryable : false;

    // (5b) failure — always record before deciding retry-vs-DLQ.
    await deps.auditStore.recordFailure({ auditId, responseStatusCode: statusCode, errorText, latencyMs });

    if (retryable && event.attemptIndex < STRIPE_MAX_ATTEMPTS) {
      throw err; // BullMQ retries with exponential backoff (a fresh event, attemptIndex+1)
    }

    // permanent failure → alert + DLQ path via the outbox.
    const payload: M35StripeApiCallFailedPayload = {
      apiCallAuditId: auditId,
      operation: event.operation,
      organizationId: event.organizationId,
      attemptIndex: event.attemptIndex,
      errorText,
    };
    return { kind: "failed_permanent", outbox: [outboxIntent("m35.stripe.api_call_failed", payload)] };
  }
}
