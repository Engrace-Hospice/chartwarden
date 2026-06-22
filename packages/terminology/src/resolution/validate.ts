// @wardenx/terminology — version-aware `validate` over a resolved concept (M38-T04, §7.1).
//
// Turns the as-of-resolved row (from as-of.ts) into the `ValidateResult` the seam returns.
// Pure: the row was already selected for the caller's `asOf`, so "valid" here means "may this
// code carry NEW data as of that date". The status→validity mapping is the §7.1 contract.

import type { CodeSystemId, ConceptStatus, ResolvedConcept } from "../interfaces/kinds";
import type { DeprecationMappingResponse, ValidateResult } from "../interfaces/provider";

/**
 * Per-status usability (§2.4.1, §7.1):
 *   • `active`     — usable.
 *   • `deprecated` — still usable but flagged; the seam returns the successor so callers can
 *     remediate (a 2023 claim's deprecated-by-2024 code is still `valid: true`).
 *   • `retired`    — NOT usable for new data; it only resolves at all for historical as-of
 *     reads inside its end-dated range.
 */
export function isUsableStatus(status: ConceptStatus): boolean {
  return status === "active" || status === "deprecated";
}

/**
 * Build the §4.5 `validate` answer from an as-of-resolved row (`null` when no version covered
 * the `asOf`) and the code's deprecation mapping, if any.
 *
 * - `null` row              → `{ valid: false }` (nothing resolved at this `asOf`, §7.10).
 * - `active`                → `{ valid: true, status: 'active' }`.
 * - `deprecated`            → `{ valid: true, status: 'deprecated', successor? }` (§7.1).
 * - `retired`               → `{ valid: false, status: 'retired', successor? }`.
 *
 * The successor is attached whenever a mapping is supplied for a deprecated/retired code so the
 * caller can route to the replacement (§2.2, §4.5 `DeprecationMappingResponse`).
 */
export function toValidateResult<S extends CodeSystemId>(
  resolved: ResolvedConcept<S> | null,
  deprecation?: DeprecationMappingResponse | null,
): ValidateResult {
  if (resolved === null) return { valid: false };

  const valid = isUsableStatus(resolved.status);
  const successor =
    !valid || resolved.status === "deprecated" ? (deprecation ?? undefined) : undefined;

  return successor === undefined
    ? { valid, status: resolved.status }
    : { valid, status: resolved.status, successor };
}
