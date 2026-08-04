// apps/backend/src/modules/25-remittance/abac-predicates.ts — M25 (§4.7).
//
// The two named ABAC predicate resolvers M25 OWNS and registers into M3's named-predicate registry (M3
// §3.4). Each is a typed `(context, target) => Promise<boolean>` evaluated server-side AFTER RBAC passes;
// M25 never authorizes by reading the request body — a resource's owner/scope/deadline facts are loaded
// through the injected {@link ReadingM25AbacResolver} (org-scoped, RLS-backstopped). The reused base
// predicates (`inOrg` M3, `provider_entity_scope` M40, `caseload_or_scope` M5) are owned + registered by
// their modules and are NOT re-registered here.
//
//   claim_assigned_to_actor  — the denial worklist-ownership narrowing: the denial_case is assigned to the
//                              acting membership (or the actor holds a broad billing/oversight role, or is a
//                              service principal). When the target carries NO denial case (the manual-match
//                              path, where no denial exists yet) the assignment axis does not apply and the
//                              route's RBAC + provider scope govern → pass.
//   appeal_within_deadline   — the hard T-0 block on appeal.submit (D6/D7): the appeal_case.tier_deadline_at
//                              is at or after now(). Past the deadline ⇒ deny (403). Fail-closed if unloadable.
//
// The REAL Drizzle fact-loader `buildDrizzleM25AbacResolver(db)` loads each fact under `withOrgContext`
// (RLS scopes every read to `app.org_id`), mirroring the M27 §4.7 resolver shape (the composition root binds
// the db handle). Every fact read is against an M25-OWNED table (denial_case / appeal_case) plus the core
// `memberships` row that resolves the acting membership. Default-deny throughout: a missing/cross-tenant row
// or an un-suppliable target id resolves to deny. No PHI is read (ids + a deadline instant only).
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";
import { isWithinDeadline } from "./domain";

/** The §4.7 predicate names M25 OWNS and registers into M3 (two). Single-owner registry. */
export const M25_REGISTERED_ABAC_PREDICATES = [
  "claim_assigned_to_actor",
  "appeal_within_deadline",
] as const;

/** Union of the predicate names M25 registers. */
export type M25RegisteredAbacPredicate = (typeof M25_REGISTERED_ABAC_PREDICATES)[number];

/** Roles whose billing oversight spans the worklist (they see every assignee's denial cases). */
const BROAD_DENIAL_SCOPE_ROLES: readonly string[] = [
  "org_admin",
  "compliance_officer",
  "billing_manager",
] as const;

/** The org + acting user the resolver scopes each `withOrgContext` load to. */
interface M25AbacReadContext {
  readonly organizationId: string;
  readonly userId: string;
}

/** Facts loaded per predicate evaluation. All reads are RLS-scoped to the acting org. */
export interface ReadingM25AbacResolver {
  /** The denial case's assignee membership (null = unassigned) + its provider entity. */
  loadDenialAssignment(
    ctx: M25AbacReadContext,
    denialCaseId: string,
  ): Promise<{ assigneeMembershipId: string | null; providerEntityId: string } | null>;
  /** The appeal's tier deadline (ISO instant). */
  loadAppealDeadline(
    ctx: M25AbacReadContext,
    appealCaseId: string,
  ): Promise<{ deadlineAt: string } | null>;
  /** The acting user's membership id within the org (for the assignment check). */
  loadActorMembershipId(ctx: M25AbacReadContext): Promise<string | null>;
}

/** Deny-stub resolver — every lookup fails closed. Lets boot register the predicates before a db binds. */
export const denyStubM25AbacResolver: ReadingM25AbacResolver = {
  async loadDenialAssignment() {
    return null;
  },
  async loadAppealDeadline() {
    return null;
  },
  async loadActorMembershipId() {
    return null;
  },
};

/**
 * The real Drizzle fact-loader. Each method opens `withOrgContext(db, {organizationId, userId}, tx => …)`
 * (the M1 @wardenx/tenancy helper) so Postgres RLS scopes every read to the acting org. Reads M25-owned
 * denial_case / appeal_case + the core memberships row; no PHI columns are selected.
 */
export function buildDrizzleM25AbacResolver(db: DbClient): ReadingM25AbacResolver {
  const DC = schema.denialCase;
  const AC = schema.appealCase;
  const M = schema.memberships;
  return {
    async loadDenialAssignment(ctx, denialCaseId) {
      return withOrgContext(db, ctx, async (tx) => {
        const rows = await tx
          .select({
            assigneeMembershipId: DC.assigneeMembershipId,
            providerEntityId: DC.providerEntityId,
          })
          .from(DC)
          .where(eq(DC.id, denialCaseId))
          .limit(1);
        const row = rows[0];
        return row
          ? {
              assigneeMembershipId: row.assigneeMembershipId,
              providerEntityId: row.providerEntityId,
            }
          : null;
      });
    },
    async loadAppealDeadline(ctx, appealCaseId) {
      return withOrgContext(db, ctx, async (tx) => {
        const rows = await tx
          .select({ deadlineAt: AC.tierDeadlineAt })
          .from(AC)
          .where(eq(AC.id, appealCaseId))
          .limit(1);
        const row = rows[0];
        return row?.deadlineAt ? { deadlineAt: new Date(row.deadlineAt).toISOString() } : null;
      });
    },
    async loadActorMembershipId(ctx) {
      return withOrgContext(db, ctx, async (tx) => {
        const rows = await tx
          .select({ id: M.id })
          .from(M)
          .where(and(eq(M.organizationId, ctx.organizationId), eq(M.userId, ctx.userId)))
          .limit(1);
        return rows[0]?.id ?? null;
      });
    },
  };
}

/** Deps for M25's ABAC predicates: a Drizzle `db` (real, RLS-scoped) or an explicit `resolver` (tests). */
export interface ReadingM25AbacDeps {
  readonly db?: DbClient;
  readonly resolver?: ReadingM25AbacResolver;
}

function resolverFor(deps: ReadingM25AbacDeps): ReadingM25AbacResolver {
  if (deps.resolver) return deps.resolver;
  if (deps.db) return buildDrizzleM25AbacResolver(deps.db);
  return denyStubM25AbacResolver;
}

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const hasBroadRole = (context: AbacContext): boolean =>
  BROAD_DENIAL_SCOPE_ROLES.some((r) => context.roles.includes(r));

const isSystemPrincipal = (context: AbacContext): boolean =>
  context.attributes.systemPrincipal === true;

const readContextOf = (context: AbacContext): M25AbacReadContext => ({
  organizationId: context.organizationId,
  userId: context.userId,
});

/**
 * Build M25's two §4.7 predicate resolvers over a Drizzle `db` (or an injected `resolver` for unit tests).
 * Target ids come from the route `:id`/payload; a missing fact, a past deadline, or an un-suppliable target
 * fails closed. Every resolver load is org-scoped to `context.organizationId` under RLS.
 */
export function buildM25AbacPredicates(
  deps: ReadingM25AbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const resolver = resolverFor(deps);
  return {
    // The denial worklist-ownership narrowing. Broad oversight roles + the service principal pass for any
    // case; otherwise the case's assignee must equal the acting membership. With no denial case in the
    // target (the manual-match path) the assignment axis does not apply → pass (RBAC + provider scope govern).
    claim_assigned_to_actor: async (context, target) => {
      if (isSystemPrincipal(context)) return true;
      if (hasBroadRole(context)) return true;
      const denialCaseId = targetStr(target, "denialCaseId");
      if (!denialCaseId) return true; // no assignment subject (manual-match) → not gated by this axis
      const facts = await resolver.loadDenialAssignment(readContextOf(context), denialCaseId);
      if (!facts || !facts.assigneeMembershipId) return false; // unassigned / cross-tenant → deny
      const membershipId = await resolver.loadActorMembershipId(readContextOf(context));
      if (!membershipId) return false;
      return facts.assigneeMembershipId === membershipId;
    },

    // The hard T-0 block on appeal.submit (D6/D7): the appeal's tier deadline is at or after now(). The
    // route must supply the appeal id; an un-loadable appeal or a past deadline fails closed (deny → 403).
    appeal_within_deadline: async (context, target) => {
      const appealCaseId = targetStr(target, "appealCaseId");
      if (!appealCaseId) return false;
      const facts = await resolver.loadAppealDeadline(readContextOf(context), appealCaseId);
      if (!facts) return false;
      return isWithinDeadline(new Date(facts.deadlineAt), new Date());
    },
  };
}

/**
 * Register M25's two §4.7 ABAC predicate resolvers into M3's shared registry (idempotent). Call at boot;
 * the composition root passes `{ db }` so the predicates resolve facts under RLS. With NO db handle it
 * defaults to the {@link denyStubM25AbacResolver} so the predicates still EXIST (fail-closed) at boot.
 */
export function registerM25AbacPredicates(deps: ReadingM25AbacDeps = {}): void {
  const predicates = buildM25AbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
