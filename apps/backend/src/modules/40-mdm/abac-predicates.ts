// apps/backend/src/modules/40-mdm/abac-predicates.ts — M40 §4.4 (GAP-172).
//
// The ONE named ABAC predicate M40 owns: the platform-only conjunct on the `/api/v1/admin/mdm/*`
// surface (merge approval, provisional promotion, NPPES lookup/sync-log). RBAC alone cannot express
// "platform only": a permission key travels with whatever role template carries it, so a tenant role
// that was granted `mdm.merge.approve` / `mdm.canonical.write` would be re-pointing or writing the
// SHARED canonical directory for EVERY tenant. The platform-only half is therefore an ABAC conjunct at
// the route, exactly as M38 does for `terminology_admin_platform_ops`.
//
// Own name (not M38's / M34's): the predicate registry is single-owner per name (M3 §4.2).
// Registration is idempotent so a test that reboots the module does not trip the collision guard.
import { type AbacContext, registerPredicateIdempotent } from "@chartwarden/auth";

/** The §4.4 predicate names M40 owns. Single-owner across the platform registry. */
export const M40_ABAC_PREDICATES = ["mdm_admin_platform_ops"] as const;

/** `platform_ops` is an M3 RBAC ROLE on a staff session; an actor without the role fails closed. */
const isPlatformOps = (context: AbacContext): boolean => context.roles.includes("platform_ops");

/** Pure factory (unit-tested against a fresh registry). */
export function buildMdmAbacPredicates(): Record<
  string,
  (context: AbacContext) => Promise<boolean>
> {
  return {
    mdm_admin_platform_ops: async (context) => isPlatformOps(context),
  };
}

/** Register M40's §4.4 predicates into M3's named-predicate registry (idempotent). */
export function registerMdmAbacPredicates(): void {
  for (const [name, predicate] of Object.entries(buildMdmAbacPredicates())) {
    registerPredicateIdempotent(name, predicate);
  }
}
