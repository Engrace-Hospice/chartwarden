// apps/admin/src/modules/34-saas-platform/onboarding — what an Idempotency-Key fingerprint is made of. A write that carries a write-only
// secret (a client secret, a vendor credential) must be fingerprinted by a DIGEST of its body: the kit's keeper holds the fingerprint in
// memory for the life of the form, and a secret is held in memory only as long as its input needs it. The digest still changes with any
// byte of the body (a corrected secret is a new attempt and gets a new key), so the key and the body never disagree.

/** SHA-256 (hex) of `text`. */
export async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A fingerprint for the kit's keeper: a digest of the JSON body, never the body itself. */
export const bodyFingerprint = (body: unknown): Promise<string> => sha256Hex(JSON.stringify(body));
