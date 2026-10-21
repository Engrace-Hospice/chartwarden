// @chartwarden/fhir — §2.3 domain validation (M28-T01).
//
// The pure §2.3 rules that are neither the scope set (`auth/scopes.ts`) nor a lifecycle edge
// (`lifecycle/*`). No IO: an admin route calls these on the way in; the DB CHECK constraints M28-T02
// writes are the second line of the same rule.

import { FHIR_TIER_RATE_LIMIT_FLOOR_RPS, type FhirClientTier } from "@chartwarden/types";

/**
 * §2.3 — the platform-floor / tenant-tighten-only rule for `fhir_client.rate_limit_rps`.
 *
 * The tenant may set a rate at or BELOW the tier floor (tighten) but never ABOVE it (loosen). A rate of
 * exactly the floor is the platform default and is legal; anything higher is refused. A non-positive rate
 * is nonsense (a client that may make zero requests should be `suspended`, not rate-limited to 0), so it
 * is rejected too.
 */
export function fhirRateLimitWithinFloor(tier: FhirClientTier, rateLimitRps: number): boolean {
  const floor = FHIR_TIER_RATE_LIMIT_FLOOR_RPS[tier];
  return Number.isInteger(rateLimitRps) && rateLimitRps > 0 && rateLimitRps <= floor;
}

/** The platform-default rate for a tier — the value a registration seeds when the operator does not
 *  tighten (§2.3 "the `rate_limit_rps` must match the platform-floor for the tier"). */
export function fhirDefaultRateLimitFor(tier: FhirClientTier): number {
  return FHIR_TIER_RATE_LIMIT_FLOOR_RPS[tier];
}

/**
 * A single IPv4/IPv6 CIDR shape check for `fhir_client.ip_allowlist[]` (§2.3 "entries must be valid
 * CIDR"). Deliberately a SHAPE check, not a full range parse: the route rejects a malformed entry early
 * with a clear message, and the enforcing middleware (M28-T03) does the actual containment test with a
 * real CIDR library. An empty allowlist is legal (no IP restriction, the tier-1 default); this validates
 * a single entry, so the caller maps it over a non-empty array.
 */
export function isCidrShaped(entry: string): boolean {
  const slash = entry.indexOf("/");
  if (slash < 0) return false;
  const addr = entry.slice(0, slash);
  const prefix = entry.slice(slash + 1);
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  if (addr.includes(":")) {
    // IPv6 — prefix 0..128, at least one hextet group present.
    return bits >= 0 && bits <= 128 && /^[0-9a-fA-F:]+$/.test(addr) && addr.length > 1;
  }
  // IPv4 — prefix 0..32, four dotted octets 0..255.
  if (bits < 0 || bits > 32) return false;
  const octets = addr.split(".");
  if (octets.length !== 4) return false;
  return octets.every((o) => /^\d+$/.test(o) && Number(o) >= 0 && Number(o) <= 255);
}
