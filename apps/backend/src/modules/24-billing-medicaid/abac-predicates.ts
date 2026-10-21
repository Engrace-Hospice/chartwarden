// apps/backend/src/modules/24-billing-medicaid/abac-predicates.ts — M24 (§4.8).
//
// The six named ABAC predicate resolvers M24 OWNS and registers into M3's named-predicate registry. Each is
// a typed `(context, target) => Promise<boolean>` evaluated server-side AFTER RBAC passes; M24 never
// authorizes by reading the request body — a claim's provider-entity / patient, a validation result's
// rule-key, and an R&B arrangement's provider-entity are loaded through the injected resolver (org-scoped,
// RLS-backstopped). Default-deny throughout: a missing / cross-tenant row, or an un-suppliable target id,
// resolves to deny. No Recipient ID is ever read (D12 / §3.6).
//
//   provider_entity_medicaid_billing_scope      — the target PE is in the actor's provider-entity set.
//   medicaid_claim_in_billing_manager_caseload  — the claim's provider entity is in the actor's scope (GAP-145).
//   medicaid_override_role_eligible             — the actor holds the override role the failed rule requires.
//   regulatory_required_rule_protected_medicaid — the rule is NOT regulatory-required (tenant may edit it).
//   rb_arrangement_visible_in_scope             — the arrangement's (or R&B day's) PE is in the actor's set.
//   state_trading_partner_credential_admin      — the PE is in scope AND the actor is a billing_manager/org_admin.
//
// DEFERRAL: the per-PATIENT caseload narrowing of `medicaid_claim_in_billing_manager_caseload` binds when the
// M5 CaseloadProvider seam binds; the provider-entity scope (GAP-145) is enforced now.
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import { DEFAULT_MEDICAID_RULES } from "@chartwarden/medicaid-adapters";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";

/** The §4.8 predicate names M24 OWNS and registers into M3 (six). Single-owner registry. */
export const M24_REGISTERED_ABAC_PREDICATES = [
  "provider_entity_medicaid_billing_scope",
  "medicaid_claim_in_billing_manager_caseload",
  "medicaid_override_role_eligible",
  "regulatory_required_rule_protected_medicaid",
  "rb_arrangement_visible_in_scope",
  "state_trading_partner_credential_admin",
] as const;

export type M24RegisteredAbacPredicate = (typeof M24_REGISTERED_ABAC_PREDICATES)[number];

/** Roles that satisfy the trading-partner credential admin axis. */
const TP_ADMIN_ROLES: readonly string[] = ["billing_manager", "org_admin"];

/** The §4.6 default rules keyed by ruleKey (the platform-floor; tenant custom rules are not regulatory). */
const RULES_BY_KEY = new Map(DEFAULT_MEDICAID_RULES.map((r) => [r.key, r]));

interface M24AbacReadContext {
  readonly organizationId: string;
  readonly userId: string;
}

/** Facts loaded per predicate evaluation; all reads RLS-scoped to the acting org. */
export interface ReadingM24AbacResolver {
  loadClaim(
    ctx: M24AbacReadContext,
    claimId: string,
  ): Promise<{ providerEntityId: string; patientId: string } | null>;
  loadArrangementPe(ctx: M24AbacReadContext, arrangementId: string): Promise<string | null>;
  /** GAP-145 — the provider entity an R&B day belongs to (null when absent / cross-tenant). */
  loadRbDayPe(ctx: M24AbacReadContext, rbDayId: string): Promise<string | null>;
  loadResultRuleKey(ctx: M24AbacReadContext, resultId: string): Promise<string | null>;
}

/** Deny-stub resolver — every lookup fails closed (boot registers the predicates before a db binds). */
export const denyStubM24AbacResolver: ReadingM24AbacResolver = {
  async loadClaim() {
    return null;
  },
  async loadArrangementPe() {
    return null;
  },
  async loadRbDayPe() {
    return null;
  },
  async loadResultRuleKey() {
    return null;
  },
};

/** The real Drizzle fact-loader (each read under withOrgContext → RLS-scoped to the acting org). */
export function buildDrizzleM24AbacResolver(db: DbClient): ReadingM24AbacResolver {
  const C = schema.medicaidClaim;
  const A = schema.rbArrangement;
  const R = schema.medicaidValidationResult;
  return {
    async loadClaim(ctx, claimId) {
      return withOrgContext(db, ctx, async (tx) => {
        const rows = await tx
          .select({ providerEntityId: C.providerEntityId, patientId: C.patientId })
          .from(C)
          .where(eq(C.id, claimId))
          .limit(1);
        return rows[0] ?? null;
      });
    },
    async loadArrangementPe(ctx, arrangementId) {
      return withOrgContext(db, ctx, async (tx) => {
        const rows = await tx
          .select({ providerEntityId: A.providerEntityId })
          .from(A)
          .where(eq(A.id, arrangementId))
          .limit(1);
        return rows[0]?.providerEntityId ?? null;
      });
    },
    async loadRbDayPe(ctx, rbDayId) {
      return withOrgContext(db, ctx, async (tx) => {
        const rows = await tx
          .select({ providerEntityId: schema.rbDay.providerEntityId })
          .from(schema.rbDay)
          .where(eq(schema.rbDay.id, rbDayId))
          .limit(1);
        return rows[0]?.providerEntityId ?? null;
      });
    },
    async loadResultRuleKey(ctx, resultId) {
      return withOrgContext(db, ctx, async (tx) => {
        const rows = await tx
          .select({ ruleKey: R.ruleKey })
          .from(R)
          .where(eq(R.id, resultId))
          .limit(1);
        return rows[0]?.ruleKey ?? null;
      });
    },
  };
}

export interface ReadingM24AbacDeps {
  readonly db?: DbClient;
  readonly resolver?: ReadingM24AbacResolver;
}

function resolverFor(deps: ReadingM24AbacDeps): ReadingM24AbacResolver {
  if (deps.resolver) return deps.resolver;
  if (deps.db) return buildDrizzleM24AbacResolver(deps.db);
  return denyStubM24AbacResolver;
}

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const readContextOf = (context: AbacContext): M24AbacReadContext => ({
  organizationId: context.organizationId,
  userId: context.userId,
});

const peInScope = (context: AbacContext, pe: string | null): boolean =>
  pe !== null && context.providerEntityIds.includes(pe);

/** Build M24's six §4.8 predicate resolvers over a Drizzle `db` (or an injected resolver for tests). */
export function buildM24AbacPredicates(
  deps: ReadingM24AbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const resolver = resolverFor(deps);
  const peForTarget = async (context: AbacContext, target: AbacTarget): Promise<string | null> => {
    const direct = targetStr(target, "providerEntityId");
    if (direct) return direct;
    const claimId = targetStr(target, "medicaidClaimId");
    if (claimId)
      return (await resolver.loadClaim(readContextOf(context), claimId))?.providerEntityId ?? null;
    return null;
  };
  return {
    provider_entity_medicaid_billing_scope: async (context, target) =>
      peInScope(context, await peForTarget(context, target)),

    medicaid_claim_in_billing_manager_caseload: async (context, target) => {
      const claimId = targetStr(target, "medicaidClaimId");
      if (!claimId) return false;
      const claim = await resolver.loadClaim(readContextOf(context), claimId);
      // GAP-145 — a claim of another provider entity is invisible even inside the same org: the claim's
      // provider entity (loaded server-side, never from the request) must be in the actor's scope. The
      // finer per-caseload (patient) narrowing still binds with the M5 CaseloadProvider (deferred).
      return !!claim && peInScope(context, claim.providerEntityId);
    },

    medicaid_override_role_eligible: async (context, target) => {
      const resultId = targetStr(target, "medicaidValidationResultId");
      if (!resultId) return false;
      const ruleKey = await resolver.loadResultRuleKey(readContextOf(context), resultId);
      if (!ruleKey) return false;
      const rule = RULES_BY_KEY.get(ruleKey);
      const required = rule?.overrideRoleRequired;
      if (!required) return false; // rule cannot be overridden
      return context.roles.includes(required);
    },

    regulatory_required_rule_protected_medicaid: async (_context, target) => {
      const ruleKey = targetStr(target, "ruleKey");
      if (!ruleKey) return true; // bulk view; the per-rule check happens at item level
      const rule = RULES_BY_KEY.get(ruleKey);
      return rule ? !rule.regulatoryRequired : true; // tenant custom rules are not regulatory
    },

    rb_arrangement_visible_in_scope: async (context, target) => {
      const direct = targetStr(target, "providerEntityId");
      if (direct) return peInScope(context, direct);
      const rbDayId = targetStr(target, "rbDayId");
      if (rbDayId) {
        return peInScope(context, await resolver.loadRbDayPe(readContextOf(context), rbDayId));
      }
      const arrangementId = targetStr(target, "rbArrangementId");
      if (!arrangementId) return false;
      return peInScope(
        context,
        await resolver.loadArrangementPe(readContextOf(context), arrangementId),
      );
    },

    state_trading_partner_credential_admin: async (context, target) => {
      const pe = targetStr(target, "providerEntityId");
      if (!peInScope(context, pe)) return false;
      return TP_ADMIN_ROLES.some((r) => context.roles.includes(r));
    },
  };
}

/**
 * Register M24's six §4.8 ABAC predicate resolvers into M3's shared registry (idempotent). Call at boot; the
 * composition root passes `{ db }` so the predicates resolve facts under RLS. With NO db handle it defaults
 * to the deny-stub so the predicates still EXIST (fail-closed) at boot.
 */
export function registerM24AbacPredicates(deps: ReadingM24AbacDeps = {}): void {
  const predicates = buildM24AbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
