// apps/backend/src/modules/34-saas-tenant-platform/abac-predicates.ts — M34 (§4.6).
//
// The EIGHT named ABAC predicate resolvers M34 OWNS and registers into M3's named-predicate registry
// (M3 §3.4). Each is a typed `(context, target) => boolean | Promise<boolean>` evaluated server-side
// AFTER RBAC passes; M34 never authorizes by reading the request body — a tenant/grant/session/flag's
// owner facts are loaded through the injected {@link TenantPlatformAbacResolver} (org/platform-scoped,
// RLS-backstopped). `dsar_export_patient_caseload_or_org_admin` COMPOSES M5's `CaseloadProvider`
// (M3 D5) rather than duplicating caseload-lookup code; M34 reaches the M5 seam OPAQUELY via
// `getSeam("CaseloadProvider")` so no `@wardenx/patient` import / dependency edge is created
// (M34 `dependsOn` stays `[2, 3, 4, 36]`; the M22-T07 precedent).
//
// PLATFORM-OPS (M34-F03): `platform_ops` is an M3 RBAC ROLE on a STAFF session, NOT a session class —
// every predicate below tests the role via `context.roles`, never `ctx.sessionClass`. The spec's
// `ctx.actor.hasRole(...)` / `ctx.actor.membership.role` shorthand maps onto the real `AbacContext`
// (`context.roles` for RBAC roles + the server-assembled `context.attributes`); the spec's
// `ctx.input.*` body fields map onto the route `AbacTarget` (the resolved `:id`/payload facts).
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests)
// guards on `abacRegistry.has` (the M22 `registerDocumentAbacPredicates` precedent).
import { type AbacContext, type AbacTarget, abacRegistry, registerPredicate } from "@wardenx/auth";
import { getSeam } from "../../bootstrap/index";

/** The §4.6 predicate names M34 owns (registered into M3). Single-owner across the platform registry. */
export const M34_ABAC_PREDICATES = [
  "tenant_lifecycle_platform_ops",
  "tenant_consented_support_active",
  "support_session_actor_distinct_from_grantor",
  "dsar_export_patient_caseload_or_org_admin",
  "tenant_export_org_admin_or_platform_ops",
  "feature_flag_write_authority",
  "onboarding_task_assignee_or_owner",
  "tenant_platform_baa_compliance_officer",
] as const;

/** Owner facts for an in-flight support-consent grant (resolved off `support_consent_grant`, §4.6). */
export interface SupportConsentGrantFacts {
  readonly grantId: string;
  readonly tenantAccountId: string;
  /** The membership id of the tenant principal who issued the grant (D16 actor-distinctness). */
  readonly grantorMembershipId: string;
  /** Grant is currently usable: `expires_at > NOW() AND revoked_at IS NULL`. */
  readonly active: boolean;
}

/** Owner facts for a feature flag (resolved off the M1 flag store, §4.6). */
export interface FeatureFlagFacts {
  readonly flagKey: string;
  /** `null` for a PLATFORM-scoped (global) flag — only `platform_ops` may write. */
  readonly organizationId: string | null;
}

/** Owner facts for an onboarding task (resolved off `onboarding_task`, §4.6). */
export interface OnboardingTaskFacts {
  readonly taskId: string;
  /** The membership id the task is assigned to, if any. */
  readonly assignedToMembershipId: string | null;
}

/**
 * Loads the org/platform-scoped owner facts the M34 predicates resolve (in-memory in the slice;
 * Drizzle under RLS in prod). Each returns `null` for an absent / cross-tenant row → fail-closed.
 */
export interface TenantPlatformAbacResolver {
  /** Is there an active support session for `tenantAccountId` whose grant + actor match the context? §4.6. */
  hasActiveConsentedSupportSession(input: {
    organizationId: string;
    tenantAccountId: string;
    actorMembershipId: string;
  }): Promise<boolean>;
  loadConsentGrant(
    organizationId: string,
    grantId: string,
  ): Promise<SupportConsentGrantFacts | null>;
  loadFeatureFlag(organizationId: string, flagKey: string): Promise<FeatureFlagFacts | null>;
  loadOnboardingTask(organizationId: string, taskId: string): Promise<OnboardingTaskFacts | null>;
}

const hasRole = (context: AbacContext, role: string): boolean => context.roles.includes(role);
const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** `platform_ops` is the M3 RBAC role on a staff session (M34-F03) — tested via `context.roles`. */
const isPlatformOps = (context: AbacContext): boolean => hasRole(context, "platform_ops");

/**
 * Read the actor's server-assembled membership id (M2 session attribute). The route layer binds
 * the active membership into `context.attributes.membershipId`; absent → null (fail-closed where used).
 */
function membershipIdOf(context: AbacContext): string | null {
  const value = context.attributes.membershipId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Deps for M34's ABAC predicate resolvers (the slice injects an in-memory resolver + caseload stub). */
export interface TenantPlatformAbacDeps {
  /** Loads org/platform-scoped owner facts (in-memory in the slice; Drizzle in prod under RLS). */
  readonly resolver: TenantPlatformAbacResolver;
  /** Caseload membership check (defaults to the boot-registered M5 `CaseloadProvider` seam). */
  readonly isInCaseload?: (q: {
    organizationId: string;
    userId: string;
    patientId: string;
  }) => Promise<boolean>;
}

/**
 * Build M34's eight §4.6 predicate resolvers over injected deps (pure factory — unit-tested with a
 * fresh registry; the boot path registers these via {@link registerTenantPlatformAbacPredicates}).
 * Target ids come from the route `:id`/payload; a missing/cross-tenant row fails closed (deny).
 */
export function buildTenantPlatformAbacPredicates(
  deps: TenantPlatformAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  const isInCaseload = deps.isInCaseload ?? ((q) => getSeam("CaseloadProvider").isInCaseload(q));

  return {
    // platform-ops tenant surface: actor holds the `platform_ops` M3 RBAC role (M34-F03). §4.6.
    tenant_lifecycle_platform_ops: async (context) => isPlatformOps(context),

    // PHI-read elevation: an active, consented, actor-bound support session exists for the tenant. §4.6.
    tenant_consented_support_active: async (context, target) => {
      const tenantAccountId = targetStr(target, "tenantAccountId");
      const actorMembershipId = membershipIdOf(context);
      if (!tenantAccountId || !actorMembershipId) return false; // fail-closed
      return resolver.hasActiveConsentedSupportSession({
        organizationId: context.organizationId,
        tenantAccountId,
        actorMembershipId,
      });
    },

    // start a support session: the actor must NOT be the grantor of the consent grant (D16). §4.6.
    support_session_actor_distinct_from_grantor: async (context, target) => {
      const grantId = targetStr(target, "supportConsentGrantId");
      const actorMembershipId = membershipIdOf(context);
      if (!grantId || !actorMembershipId) return false; // fail-closed
      const grant = await resolver.loadConsentGrant(context.organizationId, grantId);
      if (!grant || !grant.active) return false; // absent / cross-tenant / unusable
      return grant.grantorMembershipId !== actorMembershipId;
    },

    // DSAR request/download: org_admin OR caseload_or_scope on the target patient. §4.6.
    dsar_export_patient_caseload_or_org_admin: async (context, target) => {
      if (hasRole(context, "org_admin")) return true;
      const patientId = targetStr(target, "patientId");
      if (!patientId || !context.userId) return false; // fail-closed (org-level DSAR needs org_admin)
      return isInCaseload({
        organizationId: context.organizationId,
        userId: context.userId,
        patientId,
      });
    },

    // tenant export: org_admin (own tenant) OR platform_ops. §4.6.
    tenant_export_org_admin_or_platform_ops: async (context) =>
      hasRole(context, "org_admin") || isPlatformOps(context),

    // feature-flag write: platform_ops for a PLATFORM (global) flag, else org_admin for the own-org flag. §4.6.
    feature_flag_write_authority: async (context, target) => {
      const flagKey = targetStr(target, "flagKey");
      if (!flagKey) return false; // fail-closed
      const flag = await resolver.loadFeatureFlag(context.organizationId, flagKey);
      if (!flag) return false; // absent / cross-tenant
      if (flag.organizationId === null) return isPlatformOps(context); // global flag — platform-ops only
      return hasRole(context, "org_admin") && flag.organizationId === context.organizationId;
    },

    // onboarding task update/skip: the task's assignee OR org_admin. §4.6.
    onboarding_task_assignee_or_owner: async (context, target) => {
      if (hasRole(context, "org_admin")) return true;
      const taskId = targetStr(target, "taskId");
      const actorMembershipId = membershipIdOf(context);
      if (!taskId || !actorMembershipId) return false; // fail-closed
      const task = await resolver.loadOnboardingTask(context.organizationId, taskId);
      if (!task) return false; // absent / cross-tenant
      return task.assignedToMembershipId === actorMembershipId;
    },

    // platform-tenant BAA attest: actor holds the tenant's compliance_officer role. §4.6.
    tenant_platform_baa_compliance_officer: async (context) =>
      hasRole(context, "compliance_officer"),
  };
}

/**
 * Register M34's eight §4.6 ABAC predicate resolvers into M3's shared registry (idempotent).
 * Call at boot after the M5 `CaseloadProvider` seam is registered
 * (`dsar_export_patient_caseload_or_org_admin` resolves caseload through it). Re-boot (tests)
 * skips already-registered names (single-owner / no-clear; the M22 precedent).
 */
export function registerTenantPlatformAbacPredicates(deps: TenantPlatformAbacDeps): void {
  const predicates = buildTenantPlatformAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    if (abacRegistry.has(name)) continue;
    registerPredicate(name, predicate);
  }
}
