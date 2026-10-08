// apps/backend/src/modules/26-cap/abac-predicates.ts — M26 (§4.7).
//
// The five named ABAC predicate resolvers M26 OWNS and registers into M3's named-predicate registry. Each
// is a typed `(context, target) => Promise<boolean>` evaluated server-side AFTER RBAC passes; M26 never
// authorizes by reading the request body — a cap period's status/methodology + the settlement status are
// loaded through the injected resolver (org-scoped, RLS-backstopped). The reused base predicates (`inOrg`
// M3, `caseload_or_scope` M5) are owned by their modules and are NOT re-registered here.
//
//   cap_period_open                  — status IN ('open','active','reopened') — accrual-eligible (recompute).
//   cap_period_in_settlement         — status='in_settlement' AND a proposed settlement exists (propose/finalize).
//   cap_period_settled               — status='settled' AND settlement.status='final' (reopen).
//   cap_period_methodology_unlocked  — methodology IS NULL AND status<>'settled' (methodology-lock; GAP-039).
//   cap_platform_admin               — the actor holds the platform_admin role (all /v1/platform/cap/* routes).
//
// Default-deny throughout: a missing/cross-tenant row or an un-suppliable target id resolves to deny. No PHI
// is read (status + methodology enums + a settlement status only).
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { eq } from "drizzle-orm";

/** The §4.7 predicate names M26 OWNS and registers into M3 (five). Single-owner registry. */
export const M26_REGISTERED_ABAC_PREDICATES = [
  "cap_period_open",
  "cap_period_in_settlement",
  "cap_period_settled",
  "cap_period_methodology_unlocked",
  "cap_platform_admin",
] as const;

export type M26RegisteredAbacPredicate = (typeof M26_REGISTERED_ABAC_PREDICATES)[number];

/** Roles that satisfy the platform-admin axis (the /v1/platform/cap/* surface). Every key must be a
 *  reserved platform key (GAP-003, `@wardenx/auth` platform-reserved): a non-reserved key is
 *  tenant-mintable through POST /api/v1/roles. `super_admin` was listed here, but no platform role
 *  carries it, so it was tenant-mintable authority over the platform cap constants. */
export const M26_PLATFORM_ADMIN_ROLE_KEYS: readonly string[] = ["platform_admin"];

interface M26AbacReadContext {
  readonly organizationId: string;
  readonly userId: string;
}

/** Facts loaded per predicate evaluation; all reads RLS-scoped to the acting org. */
export interface ReadingM26AbacResolver {
  loadPeriod(
    ctx: M26AbacReadContext,
    capPeriodId: string,
  ): Promise<{ status: string; methodology: string | null } | null>;
  loadSettlementStatus(ctx: M26AbacReadContext, capPeriodId: string): Promise<string | null>;
}

/** Deny-stub resolver — every lookup fails closed (boot registers the predicates before a db binds). */
export const denyStubM26AbacResolver: ReadingM26AbacResolver = {
  async loadPeriod() {
    return null;
  },
  async loadSettlementStatus() {
    return null;
  },
};

/** The real Drizzle fact-loader (each read under withOrgContext → RLS-scoped to the acting org). */
export function buildDrizzleM26AbacResolver(db: DbClient): ReadingM26AbacResolver {
  const P = schema.capPeriod;
  const S = schema.capSettlement;
  return {
    async loadPeriod(ctx, capPeriodId) {
      return withOrgContext(db, ctx, async (tx) => {
        const rows = await tx
          .select({ status: P.status, methodology: P.methodology })
          .from(P)
          .where(eq(P.id, capPeriodId))
          .limit(1);
        const row = rows[0];
        return row ? { status: row.status, methodology: row.methodology ?? null } : null;
      });
    },
    async loadSettlementStatus(ctx, capPeriodId) {
      return withOrgContext(db, ctx, async (tx) => {
        const rows = await tx
          .select({ status: S.status })
          .from(S)
          .where(eq(S.capPeriodId, capPeriodId))
          .limit(1);
        return rows[0]?.status ?? null;
      });
    },
  };
}

export interface ReadingM26AbacDeps {
  readonly db?: DbClient;
  readonly resolver?: ReadingM26AbacResolver;
}

function resolverFor(deps: ReadingM26AbacDeps): ReadingM26AbacResolver {
  if (deps.resolver) return deps.resolver;
  if (deps.db) return buildDrizzleM26AbacResolver(deps.db);
  return denyStubM26AbacResolver;
}

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const readContextOf = (context: AbacContext): M26AbacReadContext => ({
  organizationId: context.organizationId,
  userId: context.userId,
});

/** Build M26's five §4.7 predicate resolvers over a Drizzle `db` (or an injected resolver for tests). */
export function buildM26AbacPredicates(
  deps: ReadingM26AbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const resolver = resolverFor(deps);
  const periodOf = async (context: AbacContext, target: AbacTarget) => {
    const capPeriodId = targetStr(target, "capPeriodId");
    if (!capPeriodId) return null;
    return resolver.loadPeriod(readContextOf(context), capPeriodId);
  };
  return {
    cap_period_open: async (context, target) => {
      const period = await periodOf(context, target);
      return !!period && ["open", "active", "reopened"].includes(period.status);
    },
    // The period-state gate for propose + finalize. propose CREATES the first proposed settlement, so this
    // predicate is the period-level check only (status='in_settlement'); the settlement-status business
    // rules (propose: no final settlement yet; finalize: a proposed/reviewed settlement exists) are enforced
    // in the write service, not here (spec §4.7's "AND a proposed settlement exists" cannot gate propose).
    cap_period_in_settlement: async (context, target) => {
      const period = await periodOf(context, target);
      return !!period && period.status === "in_settlement";
    },
    cap_period_settled: async (context, target) => {
      const period = await periodOf(context, target);
      if (!period || period.status !== "settled") return false;
      const settlement = await resolver.loadSettlementStatus(
        readContextOf(context),
        targetStr(target, "capPeriodId") ?? "",
      );
      return settlement === "final";
    },
    cap_period_methodology_unlocked: async (context, target) => {
      const period = await periodOf(context, target);
      // GAP-039 — the lock is a one-time FIRST set (methodology IS NULL), not a change, so it stays reachable
      // until the period is settled: `recompute()` promotes open → active on the first accrual even when no
      // methodology was chosen at open, and `proposeSettlement` refuses a null methodology — gating on
      // status='open' alone deadlocked such a period forever.
      return !!period && period.methodology === null && period.status !== "settled";
    },
    cap_platform_admin: async (context) =>
      M26_PLATFORM_ADMIN_ROLE_KEYS.some((r) => context.roles.includes(r)),
  };
}

/**
 * Register M26's five §4.7 ABAC predicate resolvers into M3's shared registry (idempotent). Call at boot;
 * the composition root passes `{ db }` so the predicates resolve facts under RLS. With NO db handle it
 * defaults to the deny-stub so the predicates still EXIST (fail-closed) at boot.
 */
export function registerM26AbacPredicates(deps: ReadingM26AbacDeps = {}): void {
  const predicates = buildM26AbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
