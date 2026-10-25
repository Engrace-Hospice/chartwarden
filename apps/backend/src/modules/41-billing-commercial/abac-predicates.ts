// apps/backend/src/modules/41-billing-commercial/abac-predicates.ts — M41 ABAC predicates (ADR-0100, issue #722).
//
// Three named predicates M41 OWNS and registers into M3's registry. Each is a `(context, target) => Promise<boolean>` run
// server-side AFTER RBAC passes; nothing is authorized from the request body - a claim's owning provider entity and patient are
// loaded under RLS from M41's own table. Default-deny throughout: a missing or cross-tenant row, an actor with no provider scope,
// or an un-suppliable target id all resolve to deny.
//
//   commercial_billing_provider_scope      the actor's membership is scoped to the target provider entity (named directly on
//                                          assemble / authorization create, or reached through a claim id), the same reach rule M23
//                                          applies (`billingScopeReach`: org-wide billing roles and the system principal reach all).
//   commercial_claim_in_billing_caseload   the claim's provider entity is in scope AND the claim's patient is in the actor's
//                                          caseload (org-wide billing roles and the system principal satisfy both axes).
//   commercial_override_eligible           the actor holds a billing override role AND the claim's provider entity is in scope. The
//                                          fact that a rule is a hard block is NOT decided here: the service refuses it with an
//                                          actionable message instead of a bare 404.
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@chartwarden/auth";
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";
import { billingScopeReach } from "../23-billing-medicare/abac-predicates";
import type { CommercialDb } from "./services/types";

export const M41_REGISTERED_ABAC_PREDICATES = [
  "commercial_billing_provider_scope",
  "commercial_claim_in_billing_caseload",
  "commercial_override_eligible",
] as const;

/** Roles that may override a soft-block validation result (the M23 `OverrideRole` billing set). */
export const M41_OVERRIDE_ROLES: readonly string[] = [
  "billing_manager",
  "compliance_officer",
  "org_admin",
];

export interface CommercialClaimScopeFacts {
  readonly providerEntityId: string;
  readonly patientId: string;
}

export interface CommercialAbacResolver {
  loadClaim(
    ctx: { organizationId: string; userId: string },
    claimId: string,
  ): Promise<CommercialClaimScopeFacts | null>;
  loadAuthorization(
    ctx: { organizationId: string; userId: string },
    authorizationId: string,
  ): Promise<CommercialClaimScopeFacts | null>;
}

export const denyStubCommercialAbacResolver: CommercialAbacResolver = {
  async loadClaim() {
    return null;
  },
  async loadAuthorization() {
    return null;
  },
};

export function buildDrizzleCommercialAbacResolver(db: CommercialDb): CommercialAbacResolver {
  return {
    async loadClaim(ctx, claimId) {
      return withOrgContext(db, ctx, async (tx) => {
        const [row] = await tx
          .select({
            providerEntityId: schema.commercialClaims.providerEntityId,
            patientId: schema.commercialClaims.patientId,
          })
          .from(schema.commercialClaims)
          .where(
            and(
              eq(schema.commercialClaims.id, claimId),
              eq(schema.commercialClaims.organizationId, ctx.organizationId),
            ),
          );
        return row ?? null;
      });
    },
    async loadAuthorization(ctx, authorizationId) {
      return withOrgContext(db, ctx, async (tx) => {
        const [row] = await tx
          .select({
            providerEntityId: schema.commercialAuthorizations.providerEntityId,
            patientId: schema.commercialAuthorizations.patientId,
          })
          .from(schema.commercialAuthorizations)
          .where(
            and(
              eq(schema.commercialAuthorizations.id, authorizationId),
              eq(schema.commercialAuthorizations.organizationId, ctx.organizationId),
            ),
          );
        return row ?? null;
      });
    },
  };
}

export interface CommercialAbacDeps {
  readonly db?: CommercialDb;
  readonly resolver?: CommercialAbacResolver;
  /** The M5 `CaseloadProvider` check, bound by the composition root; absent = the caseload axis denies. */
  readonly isInCaseload?: (q: {
    organizationId: string;
    userId: string;
    patientId: string;
  }) => Promise<boolean>;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const targetId = (target: AbacTarget, field: string): string | null => {
  const v = target[field];
  return typeof v === "string" && UUID_SHAPE.test(v) ? v : null;
};
const readCtx = (c: AbacContext) => ({ organizationId: c.organizationId, userId: c.userId });
const reaches = (c: AbacContext, providerEntityId: string): boolean => {
  const reach = billingScopeReach(c);
  return reach.all || reach.providerEntityIds.includes(providerEntityId);
};
const isBroad = (c: AbacContext): boolean => billingScopeReach(c).all;

export function buildCommercialAbacPredicates(
  deps: CommercialAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const resolver =
    deps.resolver ??
    (deps.db ? buildDrizzleCommercialAbacResolver(deps.db) : denyStubCommercialAbacResolver);
  const isInCaseload = deps.isInCaseload ?? (async () => false);

  /** The provider entity a target names: directly, or through a claim / authorization the resolver loads under RLS. */
  async function facts(
    context: AbacContext,
    target: AbacTarget,
  ): Promise<CommercialClaimScopeFacts | null> {
    const claimId = targetId(target, "claimId");
    if (claimId) return resolver.loadClaim(readCtx(context), claimId);
    const authorizationId = targetId(target, "authorizationId");
    if (authorizationId) return resolver.loadAuthorization(readCtx(context), authorizationId);
    const providerEntityId = targetId(target, "providerEntityId");
    return providerEntityId ? { providerEntityId, patientId: "" } : null;
  }

  return {
    commercial_billing_provider_scope: async (context, target) => {
      const f = await facts(context, target);
      return f !== null && reaches(context, f.providerEntityId);
    },

    commercial_claim_in_billing_caseload: async (context, target) => {
      const claimId = targetId(target, "claimId");
      const f = claimId
        ? await resolver.loadClaim(readCtx(context), claimId)
        : await facts(context, target);
      if (!f || !reaches(context, f.providerEntityId)) return false;
      if (isBroad(context)) return true;
      if (!context.userId || f.patientId === "") return false;
      return isInCaseload({
        organizationId: context.organizationId,
        userId: context.userId,
        patientId: f.patientId,
      });
    },

    commercial_override_eligible: async (context, target) => {
      const claimId = targetId(target, "claimId");
      if (!claimId) return false;
      if (!M41_OVERRIDE_ROLES.some((r) => context.roles.includes(r))) return false;
      const f = await resolver.loadClaim(readCtx(context), claimId);
      return f !== null && reaches(context, f.providerEntityId);
    },
  };
}

/** Register M41's predicates into M3's shared registry (idempotent; with no db they exist and deny). */
export function registerM41AbacPredicates(deps: CommercialAbacDeps = {}): void {
  for (const [name, predicate] of Object.entries(buildCommercialAbacPredicates(deps))) {
    registerPredicateIdempotent(name, predicate);
  }
}
