// @wardenx/fhir — the API-key authentication alternative (§2.2 `fhir_client_credential` / D2, M28-T03).
//
// The SECOND Phase-1 auth path (D2). For "trusted infrastructure integrations" that cannot run the SMART
// Backend Services asymmetric flow (`backend-services.ts`), a `fhir_client_credential` of `kind='api_key'`
// holds a per-tenant DEK-encrypted `secret_cipher` and a `fingerprint` (first 8 chars of the secret's
// sha256) for ops display only (§2.2). The plaintext is returned ONCE at creation and never again.
//
// PURE crypto core, IO-free. The route (M28-T08) decrypts `secret_cipher` with the tenant DEK (M1), then
// hands this module the presented key + the stored plaintext for a constant-time compare. Rotation is a
// route concern (new `active` row, prior `retired` with a 30-day overlap where both verify, §2.2); this
// module verifies a SINGLE presented key against a SINGLE stored value, so the route maps it over both
// live secrets during an overlap window.
import { createHash, timingSafeEqual } from "node:crypto";

/** §2.2 — the `fhir_client_credential.fingerprint`: the first 8 hex chars of the secret's sha256. Ops-only
 *  display (never a comparison basis — an 8-char prefix is not a credential); a full compare is
 *  {@link verifyApiKey}. Deterministic so the onboarding flow can echo it back for the Org Admin to note. */
export const FHIR_API_KEY_FINGERPRINT_CHARS = 8;

/** §2.2 — compute the ops-display fingerprint of an API-key secret (sha256 hex, first 8 chars). */
export function apiKeyFingerprint(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, FHIR_API_KEY_FINGERPRINT_CHARS);
}

/**
 * Constant-time verification of a presented API key against the stored plaintext (both already resolved
 * by the route — this never sees a cipher). Uses the sha256 digests, not the raw strings, so
 * `timingSafeEqual` always compares equal-length buffers (it throws on a length mismatch) and the compare
 * time never leaks the secret's length. A mismatch (or an empty presented key) returns false — the route
 * answers `401`; it never reveals WHICH of length/content differed.
 */
export function verifyApiKey(presented: string, storedSecret: string): boolean {
  if (presented.length === 0 || storedSecret.length === 0) return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(storedSecret, "utf8").digest();
  return timingSafeEqual(a, b);
}
