// @wardenx/terminology — tenant value-set extension rules (M38-T07, spec §7.6, §2.4.3, §2.5, §7.10).
//
// A tenant extension may ADD a (system, code) to a platform value set; it may NEVER weaken one
// (§2.4.3 — "a tenant extension never overrides a platform value-set member, only adds"). That
// invariant is partly structural — `value_set_tenant_extension` has no `is_removal` shape (§2.5)
// — and partly a write-time gate, which is this module:
//   • `classifyTenantExtension` — the add-time decision. The §7.10 edge cases, in order:
//       - (system, code) does not resolve to an active concept today → INVALID_CODE (422).
//         "A tenant can't add a code we know is being retired" (§7.10) — covers deprecated/retired
//         and never-loaded codes (§2.5 "extension references valid concept").
//       - (system, code) is already a platform member → REDUNDANT_EXTENSION (409); a no-op, but
//         the audit still captures the attempt (the provider records it).
//       - otherwise → OK.
//   • `unionTenantExtensions` — the read-time union `expand()` returns (§2.4.3): platform members
//     ∪ the org's active adds, with platform annotations ALWAYS winning a (system, code) collision
//     ("platform members always carry the platform's annotations"). Tenant rows that duplicate a
//     platform member are dropped from the union — they cannot shadow, only the platform shape shows.
//
// Pure and DB-agnostic. The provider feeds it the as-of-resolved concept (today) + platform
// membership it already read; the provider maps a non-OK outcome to the §7.10 HTTP error.

import type { CodeSystemId, ExpansionMember, ResolvedConcept } from "../interfaces/kinds";
import { isUsableStatus } from "../resolution";

/** Why an add was refused (maps to the §7.10 HTTP status). */
export type TenantExtensionRefusal =
  | { readonly outcome: "invalid_code"; readonly reason: "unresolved" | "deprecated" | "retired" }
  | { readonly outcome: "redundant" };

/** The add-time decision (§7.6, §7.10). `ok` is the only outcome that proceeds to a write. */
export type TenantExtensionOutcome = { readonly outcome: "ok" } | TenantExtensionRefusal;

/** Inputs to {@link classifyTenantExtension}: the concept resolved at today + platform membership. */
export interface TenantExtensionContext {
  /** The (system, code) resolved at TODAY (§2.5 "lookup(code, system, today)"), or null if unknown. */
  readonly resolved: ResolvedConcept<CodeSystemId> | null;
  /** Whether (system, code) is already a platform member of the target value set at today. */
  readonly isPlatformMember: boolean;
}

/**
 * Decide whether a tenant may add (system, code) to a platform value set (§7.6, §7.10).
 *
 * Validity is the first gate: an unresolved or non-active (deprecated/retired) code is refused
 * with INVALID_CODE regardless of membership — we never let a tenant pin a code we are retiring
 * (§7.10). Only then do we treat an already-platform-member add as the REDUNDANT no-op. An add of
 * an active, non-member code is OK.
 */
export function classifyTenantExtension(ctx: TenantExtensionContext): TenantExtensionOutcome {
  const { resolved, isPlatformMember } = ctx;

  if (resolved === null) return { outcome: "invalid_code", reason: "unresolved" };
  if (resolved.status === "retired") return { outcome: "invalid_code", reason: "retired" };
  if (!isUsableStatus(resolved.status) || resolved.status === "deprecated") {
    return { outcome: "invalid_code", reason: "deprecated" };
  }
  if (isPlatformMember) return { outcome: "redundant" };
  return { outcome: "ok" };
}

/**
 * The §2.4.3 `expand()` union: platform members ∪ the org's active extensions, add-only. A tenant
 * row whose (system, code) already exists in the platform set is dropped — the platform member (and
 * its annotations) stands; the tenant can never weaken or relabel it. Order is preserved: platform
 * members first (in their given order), then the surviving tenant adds.
 */
export function unionTenantExtensions(
  platform: readonly ExpansionMember[],
  tenant: readonly ExpansionMember[],
): ExpansionMember[] {
  const platformKeys = new Set(platform.map((m) => `${m.systemId} ${m.code}`));
  const seenTenant = new Set<string>();
  const adds: ExpansionMember[] = [];
  for (const m of tenant) {
    const key = `${m.systemId} ${m.code}`;
    if (platformKeys.has(key) || seenTenant.has(key)) continue; // never shadows a platform member
    seenTenant.add(key);
    adds.push(m);
  }
  return [...platform, ...adds];
}
