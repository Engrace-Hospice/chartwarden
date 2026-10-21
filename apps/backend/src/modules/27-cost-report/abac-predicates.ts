// apps/backend/src/modules/27-cost-report/abac-predicates.ts — M27 (§4.7).
//
// The named ABAC predicate resolvers M27 OWNS and registers into M3's named-predicate registry
// (M3 §3.4). Each is a typed `(context, target) => Promise<boolean>` evaluated server-side AFTER RBAC
// passes; M27 never authorizes by reading the request body — a resource's / actor's owner + scope facts
// are loaded through the injected {@link ReadingM27AbacResolver} (org-scoped, RLS-backstopped). `inOrg`
// is the RE-USED M3 base predicate every M27 route also composes (M3 owns its registration); the M40
// `provider_entity_scope` is likewise REUSED (M40 owns it). Neither is re-registered here. The three
// names below are the ones M27 owns:
//
//   editor plane   — cost_report_editor_for_provider (the actor's membership is scoped to the report's
//                    ProviderEntity, or the encompassing org with `cost_report.edit_any_provider`).
//   approver plane — cost_report_approver_for_provider (in-scope AND the per-tenant elevated-approval flag).
//   period plane   — cost_report_period_active (a state-machine ABAC: the report is in an editable state).
//
// The REAL Drizzle fact-loader `buildDrizzleM27AbacResolver(db)` loads each fact under `withOrgContext`
// (RLS scopes every read to `app.org_id`), mirroring the M30 §4.7 resolver shape (the composition root
// binds the db handle). All THREE reaches are real reads now: the cost-report fact (`provider_entity_id` +
// `state`), the actor's membership provider scope (`membership.default_provider_entity_id`), and — since
// GAP-043 — the per-tenant elevated-approval designation, through M2's `ElevatedApprovalReader` seam over
// `membership_elevated_approval` (migration 0204).
//
// `hasElevatedApproval` USED TO BE HARDCODED `false` HERE, in the resolver that boots in every deployment
// with a database, because the fact it needed had no table, no column and no seam anywhere in the system
// ("a real read here would fabricate a fact M27 cannot resolve" — correct at the time). The approver
// predicate calls it unconditionally on its last line, so override_validation / approve_for_submit /
// submit / submit_past_deadline / reopen_submitted were ALL unreachable for every caller in every tenant:
// the CMS-1984-14 filing workflow had no end state. Default-deny throughout is unchanged — a missing /
// cross-tenant fact row, an actor with no active membership, an out-of-scope provider, and an
// un-designated membership all resolve to deny. Never fails open.
//
// IDENTITY NOTE: the actor's provider scope is keyed on the SERVER-assembled `context.providerEntityIds`
// (the M40 `provider_entity_scope` source the routes already trust) AND, as an RLS-backed supplement, the
// actor's ACTIVE membership id (`context.attributes.membershipId`) → `membership.default_provider_entity_id`.
// An actor whose session carries no membership id (and whose context scope does not cover the provider)
// cannot edit an M27 row → deny. M27 carries NO PHI (D18) — every fact is ids + financial lifecycle state.
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) guards
// on `abacRegistry.has` (the M30 `registerM30AbacPredicates` precedent). Never fails open.
import {
  type AbacContext,
  type AbacTarget,
  registerPredicateIdempotent,
  resolveActorPermissions,
} from "@chartwarden/auth";
import type { CostReportDb, CostReportState } from "@chartwarden/cost-report";
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { ElevatedApprovalReader } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";

/**
 * The §4.7 predicate names M27 OWNS and registers into M3 (three). `inOrg` (M3) and `provider_entity_scope`
 * (M40) are excluded — re-used base predicates owned + registered by their modules. Single-owner registry.
 */
export const M27_REGISTERED_ABAC_PREDICATES = [
  "cost_report_editor_for_provider",
  "cost_report_approver_for_provider",
  "cost_report_period_active",
] as const;

/** Union of the predicate names M27 registers. */
export type M27RegisteredAbacPredicate = (typeof M27_REGISTERED_ABAC_PREDICATES)[number];

// -----------------------------------------------------------------------------
// Constants the §4.7 predicates key on.
// -----------------------------------------------------------------------------

/** The encompassing-org editor grant: a membership scoped to the Organization (not a single ProviderEntity). */
const EDIT_ANY_PROVIDER_PERMISSION = "cost_report.edit_any_provider";

/** The lifecycle states in which a cost report is editable (`cost_report_period_active`). §2.2 / §4.7. */
const EDITABLE_STATES: readonly CostReportState[] = ["draft", "populating"];

// -----------------------------------------------------------------------------
// Facts the predicates resolve (Drizzle under RLS in prod via the resolver; an in-memory resolver in unit
// tests). Each load is org-scoped; a `null` return is an absent / cross-tenant row → fail-closed.
// -----------------------------------------------------------------------------

/** The org + acting user the resolver scopes each load to (the `withOrgContext` GUCs). */
export interface M27AbacReadContext {
  readonly organizationId: string;
  readonly userId: string;
}

/** Scope/state facts for a `cost_report` row (§4.7 editor / approver / period predicates). */
export interface CostReportAbacFacts {
  readonly costReportId: string;
  readonly organizationId: string;
  /** The ProviderEntity (CCN) the report belongs to — the per-CCN scope every M27 edit is gated on. */
  readonly providerEntityId: string;
  /** The lifecycle state (drives `cost_report_period_active`). */
  readonly state: CostReportState;
}

/** The provider-entity scope an active membership carries (§4.7 editor / approver). */
export interface MembershipProviderScope {
  readonly membershipId: string;
  readonly organizationId: string;
  /** The ProviderEntity ids this membership is scoped to (from `membership.default_provider_entity_id`). */
  readonly providerEntityIds: readonly string[];
}

/**
 * Loads the org-scoped scope/state facts + the OPAQUE M2 elevated-approval reach the M27 predicates
 * resolve (Drizzle under RLS in prod via {@link buildDrizzleM27AbacResolver}; an in-memory stub in unit
 * tests). The elevated-approval flag is opaque (no landed column / seam) — the Drizzle resolver returns
 * false (fail-closed) until that per-tenant policy lands.
 */
export interface ReadingM27AbacResolver {
  /** Load a cost report's scope/state facts; `null` for an absent / cross-tenant row → deny. */
  loadCostReport(
    ctx: M27AbacReadContext,
    costReportId: string,
  ): Promise<CostReportAbacFacts | null>;
  /** Load an active membership's provider-entity scope; `null` → deny. */
  loadMembershipProviderScope(
    ctx: M27AbacReadContext,
    membershipId: string,
  ): Promise<MembershipProviderScope | null>;
  /** M2 per-tenant policy (opaque): does the membership carry the cost-report elevated-approval flag? */
  hasElevatedApproval(ctx: M27AbacReadContext, membershipId: string): Promise<boolean>;
}

/**
 * Deps for M27's ABAC predicate resolvers. The boot path passes a Drizzle `db` handle (the resolver reads
 * facts under RLS); unit tests may inject an in-memory `resolver` directly. Precedence: an explicit
 * `resolver` wins, else `db` builds the real Drizzle resolver, else the {@link denyStubM27AbacResolver}.
 */
export interface ReadingM27AbacDeps {
  /** The Drizzle handle the real resolver opens `withOrgContext` over (the composition root binds it). */
  readonly db?: CostReportDb;
  /** An explicit resolver (in-memory in unit tests); overrides `db` when present. */
  readonly resolver?: ReadingM27AbacResolver;
}

/**
 * Deny-stub `ReadingM27AbacResolver` — every lookup fails closed (no report, no membership scope, no
 * elevated approval). Lets the composition root register the predicates at boot BEFORE a db handle is
 * bound: with this resolver every editor/approver/period predicate denies. Never fails open.
 */
export const denyStubM27AbacResolver: ReadingM27AbacResolver = {
  async loadCostReport() {
    return null;
  },
  async loadMembershipProviderScope() {
    return null;
  },
  async hasElevatedApproval() {
    return false;
  },
};

/**
 * The REAL Drizzle-backed `ReadingM27AbacResolver`. Each fact load opens ONE
 * `withOrgContext(db, {organizationId, userId}, tx => …)` (the M1 @chartwarden/tenancy helper) so Postgres RLS
 * scopes every statement to `app.org_id` — the M30 resolver precedent. The `cost_report` row is point-read
 * by id (org + RLS scope the row); the membership's provider scope is read from `membership`.
 *
 * The M2 elevated-approval reach (GAP-043) resolves through the `ElevatedApprovalReader` seam rather than
 * a direct table read: `membership_elevated_approval` is M2's table, and `arch:tables` exempts only the
 * narrow identity cohort (organization/membership/user/session/role/membership_role) from cross-module
 * direct reads — a new table does not join that list by being convenient. Resolved LAZILY per call, since
 * the composition root registers M27's predicates before `wireModuleSeams()` runs.
 */
export function buildDrizzleM27AbacResolver(
  db: CostReportDb,
  /** Injected for tests; production resolves M2's registered seam. */
  elevatedApprovals: () => ElevatedApprovalReader = () => getSeam("ElevatedApprovalReader"),
): ReadingM27AbacResolver {
  const CR = schema.costReport;
  const M = schema.memberships;

  return {
    async loadCostReport(ctx, costReportId) {
      return withOrgContext(db, ctx, async (tx) => {
        const [row] = await tx
          .select({
            id: CR.id,
            organizationId: CR.organizationId,
            providerEntityId: CR.providerEntityId,
            state: CR.state,
          })
          .from(CR)
          .where(and(eq(CR.organizationId, ctx.organizationId), eq(CR.id, costReportId)))
          .limit(1);
        if (!row) return null;
        return {
          costReportId: row.id,
          organizationId: row.organizationId,
          providerEntityId: row.providerEntityId,
          state: row.state,
        };
      });
    },

    async loadMembershipProviderScope(ctx, membershipId) {
      return withOrgContext(db, ctx, async (tx) => {
        const [row] = await tx
          .select({
            id: M.id,
            organizationId: M.organizationId,
            defaultProviderEntityId: M.defaultProviderEntityId,
          })
          .from(M)
          .where(and(eq(M.organizationId, ctx.organizationId), eq(M.id, membershipId)))
          .limit(1);
        if (!row) return null;
        return {
          membershipId: row.id,
          organizationId: row.organizationId,
          providerEntityIds: row.defaultProviderEntityId ? [row.defaultProviderEntityId] : [],
        };
      });
    },

    // GAP-043 — the per-tenant designation, from M2. `COST_REPORT_APPROVAL_KIND` is a literal here rather
    // than an import: M27 must not take a compile edge on M2's module, and the value is the one the spec's
    // own §4.7 pseudo-code names (`hasElevatedApproval(ctx.membershipId, 'cost_report_approval')`).
    async hasElevatedApproval(ctx, membershipId) {
      return elevatedApprovals().hasElevatedApproval({
        organizationId: ctx.organizationId,
        membershipId,
        kind: "cost_report_approval",
      });
    },
  };
}

// ---- shared helpers ---------------------------------------------------------

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * The actor's ACTIVE membership id — the server-assembled M2 session attribute the routes' `writeActorOf`
 * already trusts (`context.attributes.membershipId`). The §4.7 scope predicates key on THIS (never on
 * `context.userId`, a different id space). Absent → null (fail-closed: no active membership cannot edit).
 */
function actorMembershipId(context: AbacContext): string | null {
  const value = context.attributes.membershipId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The org + acting user the resolver scopes its `withOrgContext` reads to. */
function readContextOf(context: AbacContext): M27AbacReadContext {
  return { organizationId: context.organizationId, userId: context.userId };
}

/**
 * Does the actor hold this permission grant?
 *
 * Resolved through `resolveActorPermissions` — the SAME registered resolver `requirePermission`
 * gates on, whose own doc comment names this exact case: "for consumers that must *check* a
 * permission rather than gate on it (e.g. an ABAC predicate that allows a broader scope only when
 * the actor holds a dedicated key)", and states that an assembled `AbacContext` is a valid
 * argument.
 *
 * It used to read a `context.attributes.permissions` list instead, described as bound by the route
 * layer. No route layer bound it and nothing ever wrote that key, so this returned `false` for
 * every caller and every key (F-030). Fail-closed, so never exposure — but the editor/approver org-scope override
 * (`cost_report.edit_any_provider`) could not fire,
 * for anyone, ever.
 *
 * There was no cost question to settle here, which is what the blocked-key entry assumed. Nothing
 * needs stamping on every request: the resolver is TTL-cached per (org, user) with the TTL capped
 * by the soonest grant expiry, and every guarded route has already resolved the same set through
 * its own `requirePermission` preHandler — so by the time a predicate asks, it is a cache hit.
 * With no resolver registered the set is empty and this denies.
 */
async function actorHoldsPermission(context: AbacContext, key: string): Promise<boolean> {
  return (await resolveActorPermissions(context)).has(key);
}

/**
 * Resolve the injected/derived resolver for a predicate factory: an explicit `resolver` wins (tests), else
 * a `db` handle builds the real Drizzle resolver, else the fail-closed deny-stub.
 */
function resolverFor(deps: ReadingM27AbacDeps): ReadingM27AbacResolver {
  if (deps.resolver) return deps.resolver;
  if (deps.db) return buildDrizzleM27AbacResolver(deps.db);
  return denyStubM27AbacResolver;
}

/**
 * Resolve the target ProviderEntity for an editor/approver evaluation: the route may name it directly
 * (`providerEntityId`, e.g. on create) OR carry only the `costReportId` (the resolver loads the report's
 * provider scope under RLS). A target that resolves to neither fails closed (null → deny).
 */
async function resolveProviderEntityId(
  resolver: ReadingM27AbacResolver,
  context: AbacContext,
  target: AbacTarget,
): Promise<string | null> {
  const direct = targetStr(target, "providerEntityId");
  if (direct) return direct;
  const costReportId = targetStr(target, "costReportId");
  if (!costReportId) return null;
  const report = await resolver.loadCostReport(readContextOf(context), costReportId);
  return report?.providerEntityId ?? null;
}

/**
 * Is the actor's membership scoped to `providerEntityId`? Checks the canonical server-assembled
 * `context.providerEntityIds` (the M40 `provider_entity_scope` source) first, then the RLS-backed
 * `membership.default_provider_entity_id` supplement. Fail-closed: no active membership / no scoping row /
 * not in scope ⇒ false.
 */
async function membershipInProviderScope(
  resolver: ReadingM27AbacResolver,
  context: AbacContext,
  providerEntityId: string,
): Promise<boolean> {
  if (context.providerEntityIds.includes(providerEntityId)) return true;
  const membershipId = actorMembershipId(context);
  if (!membershipId) return false;
  const scope = await resolver.loadMembershipProviderScope(readContextOf(context), membershipId);
  if (!scope) return false;
  return scope.providerEntityIds.includes(providerEntityId);
}

/**
 * Build M27's three §4.7 predicate resolvers over a Drizzle `db` handle (or an injected `resolver` for
 * unit tests). Target ids come from the route `:id`/payload; a missing / cross-tenant fact row, an actor
 * with no active membership, or an out-of-scope provider fails closed (deny). Every resolver load is
 * already org-scoped to `context.organizationId` under RLS.
 */
export function buildM27AbacPredicates(
  deps: ReadingM27AbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const resolver = resolverFor(deps);

  return {
    // The actor's membership is scoped to the report's ProviderEntity, OR the actor holds the
    // encompassing-org `cost_report.edit_any_provider` grant. §4.7. Guards every edit surface.
    cost_report_editor_for_provider: async (context, target) => {
      if (await actorHoldsPermission(context, EDIT_ANY_PROVIDER_PERMISSION)) return true; // org-scope override
      const providerEntityId = await resolveProviderEntityId(resolver, context, target);
      if (!providerEntityId) return false; // fail-closed (no resolvable provider)
      return membershipInProviderScope(resolver, context, providerEntityId);
    },

    // In-scope for the report's ProviderEntity (editor-scope OR org-scope) AND the per-tenant elevated-
    // approval flag is set on the membership. §4.7. Guards override / approve_for_submit / submit / reopen.
    cost_report_approver_for_provider: async (context, target) => {
      const providerEntityId = await resolveProviderEntityId(resolver, context, target);
      if (!providerEntityId) return false; // fail-closed
      const inScope =
        (await actorHoldsPermission(context, EDIT_ANY_PROVIDER_PERMISSION)) ||
        (await membershipInProviderScope(resolver, context, providerEntityId));
      if (!inScope) return false;
      const membershipId = actorMembershipId(context);
      if (!membershipId) return false;
      // GAP-043 — a REAL read now (M2's `membership_elevated_approval` via the ElevatedApprovalReader
      // seam). Note there is deliberately NO permission-based bypass on this conjunct, unlike the scope
      // check above: `cost_report.edit_any_provider` widens WHICH providers you may act on, it does not
      // make you a signatory. Both halves must hold.
      return resolver.hasElevatedApproval(readContextOf(context), membershipId);
    },

    // The report is in an editable lifecycle state (`draft` / `populating`). §2.2 / §4.7. A state-machine
    // ABAC guarding worksheet / import / bad-debt / mapping writes. Fail-closed: absent / cross-tenant
    // report, or any non-editable state ⇒ false.
    cost_report_period_active: async (context, target) => {
      const costReportId = targetStr(target, "costReportId");
      if (!costReportId) return false; // route must supply the report id → fail-closed
      const report = await resolver.loadCostReport(readContextOf(context), costReportId);
      if (!report) return false; // absent / cross-tenant
      return EDITABLE_STATES.includes(report.state);
    },
  };
}

/**
 * Register M27's three §4.7 ABAC predicate resolvers into M3's shared registry (idempotent). Call at boot;
 * the composition root passes `{ db }` so the predicates resolve facts under RLS. With NO db handle it
 * defaults to the {@link denyStubM27AbacResolver} so the predicates still EXIST (fail-closed) at boot.
 * Re-boot (tests) skips already-registered names (single-owner / no-clear; the M30 precedent).
 */
export function registerM27AbacPredicates(deps: ReadingM27AbacDeps = {}): void {
  const predicates = buildM27AbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
