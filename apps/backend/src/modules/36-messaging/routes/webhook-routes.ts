// apps/backend/src/modules/36-messaging/routes/webhook-routes.ts — M36-T08 the three inbound vendor
// webhook routes (M36 spec §4.9 / §4.4 delivery_reconcile; SD-056 / INT-016 / M36-F13).
//
// `/webhooks/twilio/sms-status`, `/webhooks/twilio/voice-status`, `/webhooks/postmark/event`. These
// are NOT session-authenticated — there is no `requirePermission` here. They authenticate by the
// §4.9 TWO-LAYER defense instead, run on EVERY request before any application logic and in this
// fixed order (neither layer may be short-circuited):
//
//   1. assertReplayWindow(timestamp)   — §4.9.1, a stale request is rejected before it is verified
//                                        (no timing oracle); 400 on missing/invalid/expired.
//   2. signature / sender verification — §4.9.2: Twilio HMAC-SHA1 over (public URL + sorted params);
//                                        Postmark IP allowlist + constant-time bearer token.
//
// Only once BOTH pass does the handler hand the vendor callback to the injected webhook service,
// which reconciles `notification_delivery` (the delivery_reconcile path). Twilio signs over the
// EXACT public URL, so the handler rebuilds it from the injected `publicBaseUrl` (not the proxied
// request host). Production registers `@fastify/formbody` so Twilio's urlencoded body parses into the
// `Record<string,string>` the HMAC is computed over; the body is read defensively as that shape.
import {
  assertReplayWindow,
  verifyPostmarkWebhook,
  verifyTwilioSignature,
} from "@wardenx/messaging";
import type { FastifyInstance, FastifyRequest } from "fastify";

/** A vendor delivery callback reconciled against `notification_delivery` (§4.4 delivery_reconcile). */
export interface VendorDeliveryUpdate {
  /** The vendor message id (Twilio SID / Postmark Message-ID) the delivery row is keyed on. */
  readonly vendorMessageId: string;
  /** The terminal/intermediate vendor status string (e.g. `delivered`, `failed`, `Bounce`). */
  readonly status: string;
  /** The raw vendor event payload (key/value), for the reconcile audit trail. */
  readonly raw: Record<string, string>;
}

/** The webhook service the routes hand verified callbacks to (in-memory in the slice; Drizzle in prod). */
export interface MessagingWebhookService {
  recordTwilioSmsStatus(update: VendorDeliveryUpdate): Promise<void>;
  recordTwilioVoiceStatus(update: VendorDeliveryUpdate): Promise<void>;
  recordPostmarkEvent(update: VendorDeliveryUpdate): Promise<void>;
}

/** The injection surface for the M36 webhook routes (§4.9). */
export interface MessagingWebhookDeps {
  /** The exact public base URL Twilio signs against (scheme+host+port+prefix), e.g. `https://api.example.com`. */
  publicBaseUrl: string;
  /** Resolve the Twilio Auth Token from the tenant secret store (M1 §8.3). */
  resolveTwilioAuthToken(): Promise<string> | string;
  /** Resolve the per-webhook Postmark bearer token from the tenant secret store (M1 §8.3). */
  resolvePostmarkToken(): Promise<string> | string;
  /** Whether a source IP is in the Postmark allowlist — gateway/router pre-check (§4.9.2). */
  isPostmarkSourceAllowed(ip: string): boolean;
  /** The delivery-reconcile service. */
  service: MessagingWebhookService;
}

/** Headers as a flat lower-cased string map (Fastify lower-cases keys; arrays collapse to first). */
function headerMap(request: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers)) {
    out[k] = Array.isArray(v) ? (v[0] ?? "") : String(v ?? "");
  }
  return out;
}

/** The vendor body as a flat string record (urlencoded via @fastify/formbody / JSON in tests). */
function bodyMap(request: FastifyRequest): Record<string, string> {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) out[k] = String(v);
  return out;
}

export function registerMessagingWebhookRoutes(
  app: FastifyInstance,
  deps: MessagingWebhookDeps,
): void {
  const { publicBaseUrl, service } = deps;

  // --- Twilio SMS delivery-status callback (§4.9) -------------------------------------------
  app.post("/webhooks/twilio/sms-status", async (request, reply) => {
    const headers = headerMap(request);
    assertReplayWindow(headers["x-twilio-timestamp"]); // §4.9.1 first — before verification
    const body = bodyMap(request);
    verifyTwilioSignature({
      url: `${publicBaseUrl}/webhooks/twilio/sms-status`,
      headers,
      body,
      authToken: await deps.resolveTwilioAuthToken(),
    });
    await service.recordTwilioSmsStatus({
      vendorMessageId: body.MessageSid ?? body.SmsSid ?? "",
      status: body.MessageStatus ?? body.SmsStatus ?? "",
      raw: body,
    });
    return reply.code(204).send();
  });

  // --- Twilio Voice (SOS) delivery-status callback (§4.9) -----------------------------------
  app.post("/webhooks/twilio/voice-status", async (request, reply) => {
    const headers = headerMap(request);
    assertReplayWindow(headers["x-twilio-timestamp"]);
    const body = bodyMap(request);
    verifyTwilioSignature({
      url: `${publicBaseUrl}/webhooks/twilio/voice-status`,
      headers,
      body,
      authToken: await deps.resolveTwilioAuthToken(),
    });
    await service.recordTwilioVoiceStatus({
      vendorMessageId: body.CallSid ?? "",
      status: body.CallStatus ?? "",
      raw: body,
    });
    return reply.code(204).send();
  });

  // --- Postmark event (bounce/delivery) callback (§4.9 / INT-016) ---------------------------
  app.post("/webhooks/postmark/event", async (request, reply) => {
    const headers = headerMap(request);
    assertReplayWindow(headers.date); // Postmark sends the ISO-8601 `Date` header
    verifyPostmarkWebhook({
      headers,
      expectedToken: await deps.resolvePostmarkToken(),
      sourceIpAllowed: deps.isPostmarkSourceAllowed(request.ip),
    });
    const body = bodyMap(request);
    await service.recordPostmarkEvent({
      vendorMessageId: body.MessageID ?? "",
      status: body.RecordType ?? "",
      raw: body,
    });
    return reply.code(204).send();
  });
}
