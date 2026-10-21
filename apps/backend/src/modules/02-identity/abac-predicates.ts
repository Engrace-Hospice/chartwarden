// apps/backend/src/modules/02-identity/abac-predicates.ts — the named ABAC predicates M2 registers into
// M3's registry. Both gate PLATFORM routes (`/api/v1/platform/*`), i.e. acts that reach past the
// caller's own org, so neither may be satisfied by a tenant-scoped role:
//
//   * `organization_lifecycle_platform_ops` (§11 D19, #205 hard half) —
//     `POST /api/v1/platform/organizations/:organizationId/status` (organization-lifecycle-routes.ts).
//   * `user_lifecycle_platform_ops` (§4.7 `user.deactivate` — "platform_ops (any)") —
//     `POST /api/v1/platform/users/:id/deactivate` (platform-user-routes.ts).
//
// Pure — no injected read surface. RE-DERIVED from the platform-owned role catalog
// (`@chartwarden/auth` `PLATFORM_OPS_ROLE_KEYS`), the M29 `nppes_platform_job_caller` / M35
// `platform_billing_scope` precedent (apps/backend/src/modules/29-external-interfaces/
// abac-predicates.ts): re-deriving from the single source keeps the platform's several
// platform-only gates from drifting apart on who counts as an operator, rather than each
// carrying its own copy of the answer.
//
// WHY `context.roles` IS TRUSTWORTHY HERE (GAP-003). A tenant can create a role named `platform_ops`, but
// the enrichment reader that fills `context.roles` (packages/auth/src/rbac/drizzle-store.ts) drops any
// TENANT-owned row carrying a reserved `platform_*` key (`roleConfersKey`), so the key only reaches this
// predicate through a platform-owned (`organization_id IS NULL`) role row — granted out of band by
// `scripts/db/platform-role.ts`, never by a tenant surface.
import {
  type AbacContext,
  PLATFORM_OPS_ROLE_KEYS,
  type PlatformOpsRoleKey,
  registerPredicateIdempotent,
} from "@chartwarden/auth";

export const M2_ABAC_PREDICATES = [
  "organization_lifecycle_platform_ops",
  "user_lifecycle_platform_ops",
  "funeral_session_pinned_patient",
  "auditor_enrolment_session",
] as const;

/**
 * The platform roles that may deactivate a user platform-wide. The M2 spec names `platform_ops` (§4.7);
 * `platform_admin` / `platform_owner` sit above it in the platform hierarchy (templates.ts: owner ⊇ admin).
 * The billing, support and sales roles are platform-owned too, but offboarding a person is not their job —
 * a `platform_sales` operator must not be able to lock a clinician out of every tenant.
 */
export const USER_LIFECYCLE_PLATFORM_ROLE_KEYS: readonly PlatformOpsRoleKey[] =
  PLATFORM_OPS_ROLE_KEYS.filter(
    (key) => key === "platform_ops" || key === "platform_admin" || key === "platform_owner",
  );

function hasAnyRole(context: AbacContext, keys: readonly string[]): boolean {
  return context.roles.some((r) => keys.includes(r));
}

/** `user_lifecycle_platform_ops` — the caller holds a platform-owned user-lifecycle role. */
export async function userLifecyclePlatformOpsPredicate(context: AbacContext): Promise<boolean> {
  return hasAnyRole(context, USER_LIFECYCLE_PLATFORM_ROLE_KEYS);
}

/**
 * `funeral_session_pinned_patient` (GAP-115 follow-up) - the redeemed funeral-home session may read exactly the ONE
 * patient it was pinned to at mint. Pure, and it decides over SESSION-assembled facts only: the class and the pinned
 * patient come from `context.attributes` (stamped by the authenticate hook from the `session` row), and the target
 * patient is that same pinned value - so a request can neither name another patient nor smuggle a class.
 */
export async function funeralSessionPinnedPatientPredicate(
  context: AbacContext,
  target: Record<string, unknown>,
): Promise<boolean> {
  const sessionClass = context.attributes.sessionClass;
  const pinned = context.attributes.sessionPatientId;
  if (!context.organizationId) return false;
  if (sessionClass !== "funeral_home") return false;
  if (typeof pinned !== "string" || pinned.length === 0) return false;
  return target.patientId === pinned;
}

/**
 * `auditor_enrolment_session` (M2 §7.7) - the caller is an `auditor`-class session acting on its OWN engagement's
 * enrolment. Pure, over SESSION-assembled facts only: the class and the engagement come from
 * `context.attributes` (stamped by the authenticate hook off the `session` row), and the target engagement is that
 * same value, so a request can neither name another engagement nor smuggle a class. It grants NO read: an
 * enrolment-stage session holds no permission and carries no `engagementId` scope attribute.
 */
export async function auditorEnrolmentSessionPredicate(
  context: AbacContext,
  target: Record<string, unknown>,
): Promise<boolean> {
  if (!context.organizationId || !context.userId) return false;
  if (context.attributes.sessionClass !== "auditor") return false;
  const engagementId = context.attributes.auditorEnrolmentEngagementId;
  if (typeof engagementId !== "string" || engagementId.length === 0) return false;
  return target.engagementId === engagementId;
}

/** Register M2's predicates into M3's shared registry. Idempotent (single-owner / no-clear). */
export function registerM2AbacPredicates(): void {
  registerPredicateIdempotent("organization_lifecycle_platform_ops", async (context) =>
    hasAnyRole(context, PLATFORM_OPS_ROLE_KEYS),
  ); // (context, target) => boolean|Promise<boolean> — target unused, this predicate reads no per-row fact
  registerPredicateIdempotent("user_lifecycle_platform_ops", userLifecyclePlatformOpsPredicate);
  registerPredicateIdempotent(
    "funeral_session_pinned_patient",
    funeralSessionPinnedPatientPredicate,
  );
  registerPredicateIdempotent("auditor_enrolment_session", auditorEnrolmentSessionPredicate);
}
