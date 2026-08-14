// apps/backend/src/modules/38-terminology/abac-predicates.ts — M38 §4.4 (GAP-063).
//
// The ONE named ABAC predicate M38 owns. §4.4 marks `terminology.admin.read` and
// `terminology.admin.load` **platform-only**, and RBAC alone cannot express that: a permission key
// travels with whatever role template carries it, so an org that got `terminology.admin.load` onto a
// tenant role would be loading ICD-10-CM for EVERY tenant — the §7.4 canonical lockdown's whole point.
// The platform-only half is therefore an ABAC conjunct at the route, exactly as M34 does for its
// platform-ops surface.
//
// WHY NOT REUSE M34's `tenant_lifecycle_platform_ops`. It would evaluate identically today (both test
// the same `platform_ops` RBAC role) — and that is the problem: the predicate registry is SINGLE-OWNER
// per name (M3 §4.2), so borrowing M34's name would make an M34 change to tenant-lifecycle authority
// silently retarget M38's canonical write door. One name, one owner, one reason to change.
//
// Registration is idempotent (`registerPredicateIdempotent`) because the registry is shared and
// no-clear: a test that reboots the module must not trip the cross-module collision guard.
import { type AbacContext, registerPredicateIdempotent } from "@wardenx/auth";

/** The §4.4 predicate names M38 owns. Single-owner across the platform registry. */
export const M38_ABAC_PREDICATES = ["terminology_admin_platform_ops"] as const;

/**
 * `platform_ops` is an M3 RBAC ROLE on a staff session (the M34-F03 finding), NOT a session class —
 * tested via `context.roles`, never `sessionClass`. An actor with no roles array entry fails closed.
 */
const isPlatformOps = (context: AbacContext): boolean => context.roles.includes("platform_ops");

/**
 * Build M38's predicate resolvers (pure factory — unit-tested against a fresh registry; the boot path
 * registers them via {@link registerTerminologyAbacPredicates}).
 */
export function buildTerminologyAbacPredicates(): Record<
  string,
  (context: AbacContext) => Promise<boolean>
> {
  return {
    // platform-ops terminology surface: load history, version load, embeddings refresh, and the
    // cross-tenant extension governance view. §4.4 / §7.4.
    terminology_admin_platform_ops: async (context) => isPlatformOps(context),
  };
}

/** Register M38's §4.4 predicates into M3's named-predicate registry (idempotent). */
export function registerTerminologyAbacPredicates(): void {
  for (const [name, predicate] of Object.entries(buildTerminologyAbacPredicates())) {
    registerPredicateIdempotent(name, predicate);
  }
}
