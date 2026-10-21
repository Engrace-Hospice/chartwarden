// @chartwarden/fhir — SMART/OAuth scope set + subset matcher (§2.3, M28-T01).
//
// The AUTHORITATIVE closed set of scopes a `fhir_client.allowed_scopes[]` may draw from, and the two
// pure checks the admin onboarding route (M28-T03) and the `/oauth2/token` mint (M28-T03) run against it:
//   - registration:  `allowed_scopes ⊆ SUPPORTED_SCOPES`, else `INVALID_SCOPE` (§2.3).
//   - token mint:     `scopes_requested ⊆ allowed_scopes`, else `400 invalid_scope` (§2.3).
//
// A new scope is a CODE-LEVEL addition here (and its leaf mirror in `@chartwarden/types`), never a runtime
// configuration — §2.3's single-source-of-truth rule. Phase 1 is READ-ONLY US Core R4, so every scope is
// a `.read`; the write scopes arrive with `fhir.write` in Phase 3.

import { FHIR_SUPPORTED_SCOPES, type FhirSupportedScope } from "@chartwarden/types";

/** The closed set, re-exported from the leaf mirror so this module is the single import site consumers
 *  reach for. The leaf copy exists so a TypeBox validator can reference it without importing the module;
 *  they are kept identical by an M28-T01 test. */
export const SUPPORTED_SCOPES: readonly FhirSupportedScope[] = FHIR_SUPPORTED_SCOPES;

const SUPPORTED_SCOPE_SET: ReadonlySet<string> = new Set(FHIR_SUPPORTED_SCOPES);

/** True when `scope` is a member of the supported set. */
export function isSupportedScope(scope: string): scope is FhirSupportedScope {
  return SUPPORTED_SCOPE_SET.has(scope);
}

/**
 * The subset of `requested` that is NOT in `allowed`.
 *
 * Empty ⇒ the request is within grant. Non-empty ⇒ the caller asked for more than it holds; the token
 * route answers `400 invalid_scope` and names the deviating scopes. Returned as a list (not a boolean) so
 * the `OperationOutcome`/OAuth error can enumerate exactly what was refused, which is what a partner
 * integrating against the gateway needs to fix their client config.
 */
export function scopesExceedingGrant(
  requested: readonly string[],
  allowed: readonly string[],
): readonly string[] {
  const grant = new Set(allowed);
  return requested.filter((s) => !grant.has(s));
}

/** The subset of `scopes` that is not in `SUPPORTED_SCOPES` — the registration-time `INVALID_SCOPE`
 *  check. Empty ⇒ every requested scope is registrable. */
export function unsupportedScopes(scopes: readonly string[]): readonly string[] {
  return scopes.filter((s) => !SUPPORTED_SCOPE_SET.has(s));
}
