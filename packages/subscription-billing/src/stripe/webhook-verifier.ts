// @wardenx/subscription-billing — §4.14 Stripe webhook HMAC verifier (pure core, M35-T04).
//
// Reimplements Stripe's `Stripe-Signature` verification WITHOUT the vendor SDK (the `@wardenx/xero-client`
// no-SDK idiom), so the adapter has no runtime dependency and the logic is unit-testable with an injected
// clock. The scheme (Stripe docs "Verifying signatures manually"):
//   header  = "t=<unix-seconds>,v1=<hex-hmac>[,v1=<hex-hmac>...][,v0=...]"
//   signed  = `${t}.${rawBody}`
//   expect  = HMAC-SHA256(webhookSecret, signed)  (hex)
//   accept iff SOME v1 scheme signature timing-safe-equals `expect`, AND |now - t| ≤ tolerance.
// Timing-safe comparison (`crypto.timingSafeEqual`) closes the signature-forgery timing side channel; the
// tolerance window (default 300 s) closes short-window replay (the 30-day event-age check in the handler is
// the long-window guard). Pure — the §9.1 ≥95% strict-coverage target.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { StripeEventEnvelope } from "./types";

/** Stripe's default signature tolerance (seconds) — a request whose `t` is further from now is rejected. */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

/** Thrown when signature verification fails. The T06 route maps this to HTTP 401 and — critically — logs
 *  NEITHER the payload nor the reason detail to the client (a verbose reason leaks Stripe internals). */
export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeSignatureError";
  }
}

interface ParsedSignatureHeader {
  timestamp: number;
  v1Signatures: string[];
}

/** Parse `t=...,v1=...,v1=...` into the timestamp + the set of v1 (current scheme) signatures. */
function parseSignatureHeader(header: string): ParsedSignatureHeader {
  let timestamp = Number.NaN;
  const v1Signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const scheme = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (scheme === "t") {
      timestamp = Number.parseInt(value, 10);
    } else if (scheme === "v1" && value.length > 0) {
      v1Signatures.push(value);
    }
  }
  return { timestamp, v1Signatures };
}

/** Hex-string timing-safe equality (length-guarded — `timingSafeEqual` throws on unequal buffer lengths). */
function hexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, "hex");
    bufB = Buffer.from(b, "hex");
  } catch {
    return false;
  }
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface VerifyWebhookInput {
  /** The EXACT bytes of the request body — HMAC is over the raw body, so any re-serialization breaks it. */
  readonly rawBody: string;
  /** The `Stripe-Signature` header value (may be `undefined`/array if the client omitted/duplicated it). */
  readonly signatureHeader: string | undefined;
  /** `STRIPE_WEBHOOK_SECRET` (§8.9). */
  readonly webhookSecret: string;
  /** Injected clock (Unix ms) — deterministic in tests; the T06 route passes `Date.now()`. */
  readonly nowMs: number;
  /** Override the {@link DEFAULT_SIGNATURE_TOLERANCE_SECONDS} window (seconds). */
  readonly toleranceSeconds?: number;
}

/**
 * §4.14 — verify the Stripe signature and return the parsed {@link StripeEventEnvelope}. Throws
 * {@link StripeSignatureError} on ANY failure (missing/blank header, no secret, bad HMAC, out-of-tolerance
 * timestamp, or unparseable JSON body). Never logs the payload.
 */
export function verifyStripeWebhook(input: VerifyWebhookInput): StripeEventEnvelope {
  const { rawBody, signatureHeader, webhookSecret, nowMs } = input;
  const tolerance = input.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;

  if (!webhookSecret || webhookSecret.length === 0) {
    throw new StripeSignatureError("no webhook secret configured");
  }
  if (typeof signatureHeader !== "string" || signatureHeader.length === 0) {
    throw new StripeSignatureError("missing signature header");
  }

  const { timestamp, v1Signatures } = parseSignatureHeader(signatureHeader);
  if (!Number.isInteger(timestamp) || v1Signatures.length === 0) {
    throw new StripeSignatureError("malformed signature header");
  }

  const expected = createHmac("sha256", webhookSecret).update(`${timestamp}.${rawBody}`).digest("hex");
  const matches = v1Signatures.some((candidate) => hexEquals(candidate, expected));
  if (!matches) {
    throw new StripeSignatureError("no matching v1 signature");
  }

  const skewSeconds = Math.abs(Math.floor(nowMs / 1000) - timestamp);
  if (skewSeconds > tolerance) {
    throw new StripeSignatureError("timestamp outside tolerance");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new StripeSignatureError("unparseable event body");
  }
  if (typeof parsed.id !== "string" || typeof parsed.type !== "string" || typeof parsed.created !== "number") {
    throw new StripeSignatureError("event body missing required fields");
  }

  return {
    id: parsed.id,
    type: parsed.type,
    apiVersion: typeof parsed.api_version === "string" ? parsed.api_version : null,
    created: parsed.created,
    raw: parsed,
  };
}
