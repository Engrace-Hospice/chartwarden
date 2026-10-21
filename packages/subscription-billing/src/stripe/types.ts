// @chartwarden/subscription-billing — §4.13/§8.7 Stripe adapter WIRE TYPES + injected-port shapes (M35-T04).
//
// M35's outbound Stripe access is confined to this `./stripe` adapter (the VENDOR_ADAPTERS gate pins the
// `stripe` npm SDK to `packages/subscription-billing`). Following the `@chartwarden/xero-client` idiom, the
// adapter imports NO vendor SDK and performs NO direct network I/O: every byte flows through the injected
// {@link StripeHttpPort}. The default factory injects a fail-closed port so an un-wired env throws
// {@link STRIPE_NOT_CONFIGURED} instead of silently no-op'ing a real billing call. The T06 composition
// root supplies the live port (the one place the `stripe` SDK — or a hand-rolled HTTPS transport — is
// permitted), the Drizzle-backed audit store, and the mirror applier.
//
// PHI/secrets boundary: no shape here carries a raw card PAN or a Stripe secret in the clear past the
// {@link redactForAudit} boundary (see redactor.ts) — request/response envelopes are redacted BEFORE they
// reach `stripe_api_call_audit`, and the webhook payload is envelope-encrypted BEFORE it reaches
// `stripe_webhook_event` (D15).

import type { OrgId, StripeApiCallAuditId } from "@chartwarden/types";

/** Error string thrown by the fail-closed default port when no live Stripe transport is wired (T06). */
export const STRIPE_NOT_CONFIGURED = "STRIPE_NOT_CONFIGURED";

// ── Outbound API surface (the restricted-key operation set of §8.9) ─────────────────────────────────────

/** The curated set of Stripe operations M35 invokes. Mirrors the restricted-key scope of §8.9
 *  (`customer.* / subscription.* / invoice.* / payment_method.* / refund.* / usage_record.* / coupon.* /
 *  promotion_code.* / meter.* / product.* / price.* / setup_intent.*`). A closed union, not `string`, so a
 *  typo is a compile error and the audit `operation` column carries a known vocabulary. */
export type StripeOperation =
  | "customer.create"
  | "customer.update"
  | "subscription.create"
  | "subscription.update"
  | "subscription.cancel"
  | "subscription.pause"
  | "subscription.resume"
  | "invoice.create"
  | "invoice.finalize"
  | "invoice.pay"
  | "invoice.void"
  | "payment_method.attach"
  | "payment_method.detach"
  | "payment_method.set_default"
  | "payment_method.retrieve"
  | "invoice.retrieve"
  | "setup_intent.create"
  | "refund.create"
  | "usage_record.create"
  | "coupon.create"
  | "promotion_code.create"
  | "product.create"
  | "product.update"
  | "price.create"
  | "meter.create";

/** A single outbound Stripe request: the typed operation + its opaque JSON payload. */
export interface StripeApiRequest {
  readonly operation: StripeOperation;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Per-call options — the deterministic idempotency key of §4.13 is always set by the dispatcher. */
export interface StripeCallOptions {
  readonly idempotencyKey: string;
}

/** A raw Stripe response (2xx path). `body` is the parsed JSON object Stripe returned. */
export interface StripeApiResponse {
  readonly statusCode: number;
  readonly body: Readonly<Record<string, unknown>>;
}

/** The error a failed Stripe call raises. `retryable` drives the §4.13 BullMQ-retry-vs-DLQ decision;
 *  `statusCode` is 0 when the failure never reached Stripe (network/timeout). */
export interface StripeApiError {
  readonly message: string;
  readonly statusCode: number;
  readonly retryable: boolean;
}

/** True iff `value` is a {@link StripeApiError}-shaped rejection (the dispatcher's catch narrows on this). */
export function isStripeApiError(value: unknown): value is StripeApiError {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.message === "string" &&
    typeof e.statusCode === "number" &&
    typeof e.retryable === "boolean"
  );
}

// ── The injected raw transport (the ONLY seam the live `stripe` SDK is wired behind, in T06) ─────────────

/** The fail-closed-by-default raw transport. The live impl (T06) is the sole place the `stripe` SDK — or a
 *  hand-rolled HTTPS client — may be imported; it applies `STRIPE_SECRET_KEY` + the `idempotencyKey`. */
export interface StripeHttpPort {
  execute(request: StripeApiRequest, options: StripeCallOptions): Promise<StripeApiResponse>;
}

// ── The dispatcher's inbound event + its injected ports (§4.13) ──────────────────────────────────────────

/** The outbox event the `stripe-dispatcher` worker drains — one deferred outbound Stripe call. The
 *  `businessKey` + `attemptIndex` feed the deterministic idempotency key (§4.13/§4.16). */
export interface StripeDispatchEvent {
  readonly operation: StripeOperation;
  /** The stable business identity of this call (e.g. `subscriptionId`, `invoiceId`) — NOT the attempt. */
  readonly businessKey: string;
  /** The Stripe-side resource id this call targets, when known (audit `target_resource_id`). */
  readonly targetResourceId: string | null;
  /** The tenant this call belongs to, or `null` for platform-wide ops (audit `organization_id`). */
  readonly organizationId: OrgId | null;
  /** The request body handed to Stripe (redacted before it reaches the audit row). */
  readonly payload: Readonly<Record<string, unknown>>;
  /** The BullMQ attempt index (0-based); folded into the idempotency key so each attempt is auditable. */
  readonly attemptIndex: number;
  /**
   * Overrides the attempt segment of the Stripe idempotency key. Set it (to 0) for an operation that is NOT safe
   * to repeat under a fresh key - a refund: if attempt N timed out after Stripe created the refund, no 2xx is on
   * record, and a retry under a NEW key would create a second one. With a key stable per business key, Stripe
   * replays the first result instead. `attemptIndex` still drives the retry ceiling and the audit row.
   */
  readonly idempotencyAttemptIndex?: number;
}

/** The append-only `stripe_api_call_audit` writes the dispatcher performs (§4.13). The impl (T06) owns the
 *  Drizzle inserts/updates; the redaction of the request/response envelopes happens in the dispatcher
 *  BEFORE the values cross this port, so no secret ever reaches the store un-redacted. */
export interface StripeApiCallAuditStore {
  /** §4.13 pre-check: has a call with this idempotency key already succeeded (`response_status_code < 300`)? */
  hasSucceededForIdempotencyKey(idempotencyKey: string): Promise<boolean>;
  /** Insert the pre-call audit row (request already redacted); returns the new row id. */
  insertCall(input: {
    stripeIdempotencyKey: string;
    operation: StripeOperation;
    targetResourceId: string | null;
    organizationId: OrgId | null;
    requestEnvelopeRedacted: unknown;
    attemptIndex: number;
  }): Promise<{ auditId: StripeApiCallAuditId }>;
  /** Fold the 2xx response (already redacted) + latency into the audit row. */
  recordSuccess(input: {
    auditId: StripeApiCallAuditId;
    responseStatusCode: number;
    responseEnvelopeRedacted: unknown;
    latencyMs: number;
  }): Promise<void>;
  /** Fold a failure (status + error text + latency) into the audit row. */
  recordFailure(input: {
    auditId: StripeApiCallAuditId;
    responseStatusCode: number;
    errorText: string;
    latencyMs: number;
  }): Promise<void>;
}

/** Applies a successful Stripe response back onto the M35 mirror tables (§4.13 `applyStripeResponseToMirror`).
 *  Abstract here (pure core); the T06 impl writes the `invoice` / `subscription` / `payment_method` mirror
 *  under the §2.5 row lock + `withOrgContext` RLS. */
export interface StripeMirrorApplier {
  apply(event: StripeDispatchEvent, response: StripeApiResponse): Promise<void>;
}

// ── The webhook side (§4.14) ────────────────────────────────────────────────────────────────────────────

/** A verified, parsed Stripe webhook envelope (the fields M35 reads off `Stripe.Event`). */
export interface StripeEventEnvelope {
  readonly id: string;
  readonly type: string;
  readonly apiVersion: string | null;
  /** Unix seconds Stripe stamped the event (drives the §4.14 30-day replay window). */
  readonly created: number;
  /** The full raw JSON, verbatim — envelope-encrypted at rest (D15), never logged. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Envelope-encrypts the raw webhook payload before it lands in `stripe_webhook_event` (D15). Injected so
 *  the pure ingestion core never touches KMS. */
export interface WebhookPayloadEncryptor {
  encrypt(plaintext: string): { ciphertext: string; dekRef: string };
}

/** The dedup insert of §4.14 (`ON CONFLICT (id) DO NOTHING`). `inserted:false` ⇒ a replay we already have. */
export interface StripeWebhookEventStore {
  insertIfNew(row: {
    id: string;
    eventType: string;
    apiVersion: string | null;
    payloadCiphertext: string;
    payloadDekRef: string;
    receivedAt: Date;
    signatureVerifiedAt: Date;
    derivedOrganizationId: string | null;
  }): Promise<{ inserted: boolean }>;
}
