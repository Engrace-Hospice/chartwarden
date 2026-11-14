// @chartwarden/ui core — what an Idempotency-Key fingerprint is made of when the body holds a write-once secret (a vendor credential, a
// client secret, an EIN): a DIGEST of the body, so the kit's keeper never holds the secret in its own memory beyond the input that needs
// it. The digest still changes with any byte of the body (a corrected secret is a new attempt and gets a new key), so the key and the
// body never disagree.
import { opaqueIdempotencyIntent } from "./idempotency-key";

/** SHA-256 (hex) of `text`. Needs `crypto.subtle`, which a browser only has on a secure origin: it rejects where there is none. */
export async function sha256HexOfText(text: string): Promise<string> {
  const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
  if (subtle === undefined) throw new Error("crypto.subtle is unavailable on this origin");
  const hash = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let weakDigestSalt: string | undefined;

function newWeakDigestSalt(): string {
  const cryptoApi = typeof crypto === "undefined" ? undefined : crypto;
  if (cryptoApi?.getRandomValues === undefined) {
    throw new Error(
      "crypto.getRandomValues is unavailable; cannot fingerprint a secret-bearing body safely",
    );
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A salted, 53-bit non-cryptographic digest for an origin with no `crypto.subtle` (plain http on a LAN). A per-page 128-bit secure random
 * salt keeps the digest from being a stable offline dictionary key if it is exposed. This fails closed if secure randomness is absent.
 * Two bodies that collide would meet the server's own check (the same Idempotency-Key with a different body is refused), never a wrong write.
 */
function weakDigest(text: string): string {
  weakDigestSalt ??= newWeakDigestSalt();
  return `weak:${opaqueIdempotencyIntent(text, weakDigestSalt)}`;
}

/**
 * A fingerprint for the kit's keeper: a digest of the JSON body, never the body itself. SHA-256 where the browser has it; on an origin
 * without `crypto.subtle` a weaker digest (prefixed `weak:`), so a write is never lost to a missing API.
 */
export async function bodyFingerprint(body: unknown): Promise<string> {
  const text = JSON.stringify(body);
  try {
    return await sha256HexOfText(text);
  } catch {
    return weakDigest(text);
  }
}
