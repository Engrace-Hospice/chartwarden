// apps/backend/src/modules/35-subscription/billing-runtime/webhook-payload-crypto.ts - GAP-058.
//
// The D15 at-rest protection for the raw Stripe webhook payload (`stripe_webhook_event.payload_ciphertext`).
// AES-256-GCM with a random 96-bit IV per payload; the stored string is `v1.<iv>.<tag>.<ciphertext>` (base64url).
// `dekRef` names the key id so a rotated key can still decrypt old rows. The key comes from
// `M35_WEBHOOK_PAYLOAD_KEY` (base64, 32 bytes) - a SEPARATE secret from the Stripe credentials and the
// pseudonym KEK. This is a direct key, not a KMS-wrapped envelope: stronger (per-row DEK under a KMS KEK) is a
// deployment hardening the key id leaves room for.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { WebhookPayloadEncryptor } from "@chartwarden/subscription-billing";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const FORMAT = "v1";

export class WebhookPayloadKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookPayloadKeyError";
  }
}

/** Parse a base64 32-byte key, or throw (a wrong-length key must never silently weaken the cipher). */
export function parseWebhookPayloadKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== KEY_BYTES) {
    throw new WebhookPayloadKeyError(
      `M35_WEBHOOK_PAYLOAD_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}

export interface WebhookPayloadCipher extends WebhookPayloadEncryptor {
  decrypt(ciphertext: string): string;
}

export function createWebhookPayloadCipher(
  key: Buffer,
  keyId = "m35-webhook-v1",
): WebhookPayloadCipher {
  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      const ciphertext = [FORMAT, iv, tag, body].map((p) =>
        typeof p === "string" ? p : p.toString("base64url"),
      );
      return { ciphertext: ciphertext.join("."), dekRef: keyId };
    },
    decrypt(stored) {
      const [format, iv, tag, body] = stored.split(".");
      if (format !== FORMAT || !iv || !tag || body === undefined) {
        throw new WebhookPayloadKeyError("unrecognised webhook payload ciphertext format");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(body, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
