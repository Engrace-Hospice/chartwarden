// apps/backend/src/modules/02-identity/abac-predicates.ts — the ONE named ABAC predicate M2 registers
// into M3's registry (§11 D19, #205 hard half): `organization_lifecycle_platform_ops`, gating
// `POST /api/v1/platform/organizations/:organizationId/status` (organization-lifecycle-routes.ts).
//
// Pure — no injected read surface. RE-DERIVED from the platform-owned role catalog
// (`@wardenx/auth` `PLATFORM_OPS_ROLE_KEYS`), the M29 `nppes_platform_job_caller` / M35
// `platform_billing_scope` precedent (apps/backend/src/modules/29-external-interfaces/
// abac-predicates.ts): re-deriving from the single source keeps the platform's several
// platform-only gates from drifting apart on who counts as an operator, rather than each
// carrying its own copy of the answer.
import {
  type AbacContext,
  PLATFORM_OPS_ROLE_KEYS,
  registerPredicateIdempotent,
} from "@wardenx/auth";

export const M2_ABAC_PREDICATES = ["organization_lifecycle_platform_ops"] as const;

function isPlatformOperator(context: AbacContext): boolean {
  return context.roles.some((r) => (PLATFORM_OPS_ROLE_KEYS as readonly string[]).includes(r));
}

/** Register M2's one §11 D19 predicate into M3's shared registry. Idempotent (single-owner / no-clear). */
export function registerM2AbacPredicates(): void {
  registerPredicateIdempotent("organization_lifecycle_platform_ops", async (context) =>
    isPlatformOperator(context),
  ); // (context, target) => boolean|Promise<boolean> — target unused, this predicate reads no per-row fact
}
