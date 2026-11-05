// @chartwarden/shared — at-rest cipher for a stored inbound webhook payload (lifted unchanged from M35's GAP-058
// `webhook-payload-crypto.ts` so M23's Claim.MD receipts use the same format).
//
// AES-256-GCM with a random 96-bit IV per payload; the stored string is `v1.<iv>.<tag>.<ciphertext>` (base64url).
// `dekRef` names the key id so a rotated key can still decrypt old rows. Each caller owns a SEPARATE 32-byte key
// (base64 in its own env var). A direct key, not a KMS-wrapped envelope: the key id leaves room for that hardening.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

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
export function parseWebhookPayloadKey(base64Key: string, envName: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== KEY_BYTES) {
    throw new WebhookPayloadKeyError(
      `${envName} must decode to ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}

export interface WebhookPayloadCipher {
  encrypt(plaintext: string): { ciphertext: string; dekRef: string };
  decrypt(ciphertext: string): string;
}

export function createWebhookPayloadCipher(key: Buffer, keyId: string): WebhookPayloadCipher {
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
