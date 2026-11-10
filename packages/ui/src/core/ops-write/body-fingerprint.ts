// @chartwarden/ui core — what an Idempotency-Key fingerprint is made of when the body holds a write-once secret (a vendor credential, a
// client secret, an EIN): a DIGEST of the body, so the kit's keeper never holds the secret in its own memory beyond the input that needs
// it. The digest still changes with any byte of the body (a corrected secret is a new attempt and gets a new key), so the key and the
// body never disagree.

/** SHA-256 (hex) of `text`. Needs `crypto.subtle`, which a browser only has on a secure origin: it rejects where there is none. */
export async function sha256HexOfText(text: string): Promise<string> {
  const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
  if (subtle === undefined) throw new Error("crypto.subtle is unavailable on this origin");
  const hash = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CYRB_SEED_A = 0xdeadbeef;
const CYRB_SEED_B = 0x41c6ce57;
const CYRB_MIX_A = 2654435761;
const CYRB_MIX_B = 1597334677;
const CYRB_FOLD_A = 2246822507;
const CYRB_FOLD_B = 3266489909;
const CYRB_SHIFT = 16;
const CYRB_SHIFT_FOLD = 13;
const CYRB_LOW_BITS = 2097151;
const CYRB_HIGH_SCALE = 4294967296;

/**
 * A 53-bit non-cryptographic digest (cyrb53), for an origin with no `crypto.subtle` (plain http on a LAN). It holds nothing of the body,
 * changes with any character of it, and is only ever a key to the keeper: two bodies that collided would meet the server's own check
 * (the same Idempotency-Key with a different body is refused), never a wrong write.
 */
function weakDigest(text: string): string {
  let h1 = CYRB_SEED_A;
  let h2 = CYRB_SEED_B;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, CYRB_MIX_A);
    h2 = Math.imul(h2 ^ ch, CYRB_MIX_B);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> CYRB_SHIFT), CYRB_FOLD_A) ^
    Math.imul(h2 ^ (h2 >>> CYRB_SHIFT_FOLD), CYRB_FOLD_B);
  h2 =
    Math.imul(h2 ^ (h2 >>> CYRB_SHIFT), CYRB_FOLD_A) ^
    Math.imul(h1 ^ (h1 >>> CYRB_SHIFT_FOLD), CYRB_FOLD_B);
  const digest = CYRB_HIGH_SCALE * (CYRB_LOW_BITS & h2) + (h1 >>> 0);
  return `weak:${digest.toString(16)}:${text.length}`;
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
