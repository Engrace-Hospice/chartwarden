// @wardenx/subscription-billing — §D6 HMAC pseudonym computation (pure core, M35-T03).
//
// The D6 discipline in ONE function: a per-patient / per-user meter signal is stored in M35 ONLY as an
// `HMAC-SHA256(active_key_material, subjectId)` digest, hex-encoded and truncated to the 32-lowercase-hex
// keyspace the §2.3 CHECK (`^[a-f0-9]{32}$`) enforces. The raw `patient_id` / `membership_id` is 36 chars
// with dashes, so it can NEVER satisfy the CHECK — a raw id cannot accidentally land in the pseudonym
// column even if the caller passes it straight through (defence-in-depth on top of this boundary).
//
// PURE: the HMAC key MATERIAL is INJECTED (the routes/worker in T06 read the active `patient_pseudonym_key`
// row, decrypt the KMS-wrapped secret, and pass the plaintext material here). This file never touches the
// DB, never touches KMS, and never sees the key epoch's lifecycle — it is the deterministic kernel the
// W-SB-08 property test pins: same (keyMaterial, subjectId) → same digest; different subjectId → different
// digest with overwhelming probability.

import { createHmac } from "node:crypto";
import type { BillingPseudonym } from "@wardenx/types";
import { isValidBillingPseudonym } from "../domain/validation";

/** The number of lowercase-hex characters a §2.3 pseudonym occupies (16 bytes of the SHA-256 digest). */
export const BILLING_PSEUDONYM_HEX_LENGTH = 32;

/**
 * §D6 — compute the pseudonym for a raw subject id (`patient_id` or `membership_id`) under a key epoch's
 * decrypted HMAC secret. The digest is the first {@link BILLING_PSEUDONYM_HEX_LENGTH} hex chars of
 * `HMAC-SHA256(keyMaterial, subjectId)` — deterministic within a key epoch, so `active_patient` dedup on
 * `(organization_id, patient_pseudonym, period_year_month)` works, and irreversible without the key.
 *
 * The result is guaranteed to satisfy the §2.3 CHECK; {@link isValidBillingPseudonym} would accept it.
 */
export function computeBillingPseudonym(keyMaterial: string, subjectId: string): BillingPseudonym {
  if (keyMaterial.length === 0) {
    throw new Error("computeBillingPseudonym: empty key material (no active patient_pseudonym_key epoch)");
  }
  if (subjectId.length === 0) {
    throw new Error("computeBillingPseudonym: empty subject id");
  }
  return createHmac("sha256", keyMaterial)
    .update(subjectId)
    .digest("hex")
    .slice(0, BILLING_PSEUDONYM_HEX_LENGTH);
}

/** True iff `value` is exactly the §2.3 pseudonym shape (re-exported convenience over the domain check). */
export function isBillingPseudonym(value: string): boolean {
  return isValidBillingPseudonym(value);
}
