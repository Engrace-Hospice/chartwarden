// apps/web/src/modules/34-saas/wizard — what an Idempotency-Key fingerprint is made of when the body holds a write-once secret (the EIN):
// a DIGEST of the body, so the kit's keeper never holds the secret in its own memory beyond the input that needs it. The digest still
// changes with any byte of the body (a corrected EIN is a new attempt and gets a new key), so the key and the body never disagree.
// SubtleCrypto exists only on a secure origin: on plain-HTTP staging or a LAN address the body itself keys the attempt (as every other
// form's does), which is the same key behaviour with the body held in the keeper for the life of the form.

/** SHA-256 (hex) of `text`; throws where SubtleCrypto is missing. */
export async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A fingerprint for the kit's keeper: a digest of the JSON body when this origin can compute one, else the JSON body. Never throws. */
export async function bodyDigest(body: unknown): Promise<string> {
  const text = JSON.stringify(body);
  if (typeof crypto === "undefined" || crypto.subtle === undefined) return text;
  try {
    return await sha256Hex(text);
  } catch {
    return text;
  }
}
