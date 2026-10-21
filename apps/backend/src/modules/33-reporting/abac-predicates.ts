// apps/backend/src/modules/33-reporting/abac-predicates.ts — M33 (§4.7).
//
// The TWO named ABAC predicate resolvers M33 OWNS and registers into M3's named-predicate registry
// (M3 §3.4). Each is a typed `(context, target) => Promise<boolean>` evaluated server-side AFTER RBAC
// passes; M33 never authorizes by reading the request body — a view's / actor's owner facts are loaded
// through the injected {@link ReportingAbacResolver} (org-scoped, RLS-backstopped).
//
//   1. `reportable_scope` — the cross-cutting D8 scope rule by which EVERY M33 read is scope-filtered.
//      It resolves the actor's effective scope (self/team/location/org) into a SEALED envelope the
//      route layer injects into the SQL translator's WHERE clause (`scope-injector.ts`). The team /
//      location resolution COMPOSES M2's `SupervisorReader` and M5's `CaseloadProvider` (D5) — reached
//      OPAQUELY through the injected resolver ports, so no `@chartwarden/patient` / M2 import edge is created
//      (M33 `dependsOn` stays `[1, 2, 3, 4, 36]`; the M34/M22 precedent). Until P2C binds the real M2/M5
//      seams, the deny-stub resolver returns empty sets → the actor collapses to `self` scope.
//   2. `dashboard_visibility` — composes the view's `share_scope` with the actor to decide read/edit on
//      a saved view (§4.7.2, verbatim ownership/org/role ladder).
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) guards
// on `abacRegistry.has` (the M34 `registerTenantPlatformAbacPredicates` precedent).
import {
  type AbacContext,
  type AbacTarget,
  PLATFORM_OPS_ROLE_KEYS,
  registerPredicateIdempotent,
} from "@chartwarden/auth";
import { canMutateSchedule, canReadSchedule, isScheduleAdmin } from "./routes/schedule-authz";

/** The §4.7 predicate names M33 owns (registered into M3). Single-owner across the platform registry. */
export const M33_ABAC_PREDICATES = [
  "reportable_scope",
  "dashboard_visibility",
  "report_schedule_access",
  "platform_admin_scope",
  "compliance_officer_scope",
] as const;

/** Roles that may read the compliance drilldown-audit trail (the §4.2 `compliance_officer_scope`). */
export const COMPLIANCE_AUDIT_ROLE_KEYS = [
  "compliance_officer",
  "hipaa_privacy_officer",
  "hipaa_security_officer",
] as const;

/** `platform_admin_scope` - the actor holds a role from the platform-ops catalog (the M29 / M35 single source). */
export function isPlatformAdminActor(context: AbacContext): boolean {
  return context.roles.some((r) => (PLATFORM_OPS_ROLE_KEYS as readonly string[]).includes(r));
}

/** `compliance_officer_scope` - a tenant actor holding a compliance / privacy / security officer role. */
export function isComplianceOfficerActor(context: AbacContext): boolean {
  return (
    Boolean(context.organizationId) &&
    context.roles.some((r) => (COMPLIANCE_AUDIT_ROLE_KEYS as readonly string[]).includes(r))
  );
}

/** The four effective read scopes a §4.7 `reportable_scope` resolution can collapse to (D8). */
export type ReportableScopeKind = "self" | "team" | "location" | "org";

/**
 * The SEALED scope envelope `reportable_scope` resolves — injected by the route layer into the SQL
 * translator's WHERE clause (D8 `scope-injector.ts`). `org` carries no id list (the whole org_id is in
 * scope under RLS); `location` carries the resolved location ids; `self`/`team` carry membership ids.
 */
export interface ReportableScopeEnvelope {
  readonly kind: ReportableScopeKind;
  readonly organizationId: string;
  /** Membership ids in scope (`self` = the actor's own id; `team` = supervised member ids). */
  readonly membershipIds: readonly string[];
  /** Location ids in scope (`location` scope only; empty otherwise). */
  readonly locationIds: readonly string[];
  /** Marks the envelope as server-sealed — the translator refuses an un-sealed envelope. */
  readonly sealed: true;
}

/** Owner facts for a saved report view (resolved off `report_view`, §4.7.2). */
export interface ReportViewFacts {
  readonly viewId: string;
  readonly organizationId: string;
  /** The membership id that owns the view (the `private` author). */
  readonly ownerMembershipId: string;
  readonly shareScope: "private" | "role" | "org";
  /** Role keys the view is shared with when `shareScope === 'role'` (empty otherwise). */
  readonly shareRoleKeys: readonly string[];
}

/** Owner facts for a report schedule (resolved off `report_schedule`, GAP-097). */
export interface ReportScheduleFacts {
  readonly scheduleId: string;
  readonly organizationId: string;
  readonly ownerMembershipId: string;
  readonly recipientMembershipIds: readonly string[];
}

/**
 * Loads the org-scoped owner facts the M33 predicates resolve (in-memory in unit tests; Drizzle under
 * RLS in prod, P2C). The team/location resolvers are the OPAQUE M2 `SupervisorReader` / M5
 * `CaseloadProvider` reach — the deny-stub returns empty/false (fail-closed → actor collapses to `self`).
 */
export interface ReportingAbacResolver {
  /** Load a saved view's owner facts; `null` for an absent / cross-tenant row → fail-closed. */
  loadReportView(organizationId: string, viewId: string): Promise<ReportViewFacts | null>;
  /** Load a schedule's owner/recipient facts; `null` for an absent / cross-tenant row → fail-closed. */
  loadReportSchedule(
    organizationId: string,
    scheduleId: string,
  ): Promise<ReportScheduleFacts | null>;
  /** M2 `SupervisorReader` (opaque): the membership ids the actor supervises (empty when none/unbound). */
  resolveSupervisedMembershipIds(input: {
    organizationId: string;
    userId: string;
  }): Promise<readonly string[]>;
  /** Is the actor a supervisor for `locationId`? (drives the §4.7 step-2 `location` scope.) */
  isSupervisorForLocation(input: {
    organizationId: string;
    userId: string;
    locationId: string;
  }): Promise<boolean>;
}

/** Deps for M33's ABAC predicate resolvers (the slice/boot injects an in-memory or deny-stub resolver). */
export interface ReportingAbacDeps {
  /** Loads org-scoped owner facts + the opaque M2/M5 reach (deny-stub-safe until P2C binds them). */
  readonly resolver: ReportingAbacResolver;
}

const hasRole = (context: AbacContext, role: string): boolean => context.roles.includes(role);
const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * Read the actor's server-assembled membership id (M2 session attribute). The route layer binds the
 * active membership into `context.attributes.membershipId`; absent → null (fail-closed where used).
 */
function membershipIdOf(context: AbacContext): string | null {
  const value = context.attributes.membershipId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Deny-stub `ReportingAbacResolver` — every lookup fails closed (no view, no supervised members, not a
 * location supervisor). Lets the composition root register the predicates at boot BEFORE the real M2/M5
 * seam binding lands (P2C): with this resolver `reportable_scope` collapses every actor to `self` scope
 * and `dashboard_visibility` denies all but the view owner (resolved as `null` → deny). Never fails open.
 */
export const denyStubReportingAbacResolver: ReportingAbacResolver = {
  async loadReportView() {
    return null;
  },
  async loadReportSchedule() {
    return null;
  },
  async resolveSupervisedMembershipIds() {
    return [];
  },
  async isSupervisorForLocation() {
    return false;
  },
};

/**
 * Resolve the actor's effective §4.7 `reportable_scope` envelope (the D8 skeleton). Resolution order
 * (spec §4.7.1):
 *   1. `org_admin` / `compliance_officer` role            → `org`
 *   2. `supervisor` role for the resource's location      → `location` (the resolved location id)
 *   3. supervised memberships via M2 `SupervisorReader`   → `team` (the supervised membership ids)
 *   4. otherwise                                          → `self` (the actor's own membership id)
 * The team/location reach is OPAQUE through {@link ReportingAbacResolver} (deny-stub-safe); real M2/M5
 * binding lands in P2C. The returned envelope is `sealed` so the SQL `scope-injector` accepts it.
 */
export async function resolveReportableScope(
  context: AbacContext,
  target: AbacTarget,
  resolver: ReportingAbacResolver,
): Promise<ReportableScopeEnvelope> {
  const organizationId = context.organizationId;

  // 1. org-wide read authority.
  if (hasRole(context, "org_admin") || hasRole(context, "compliance_officer")) {
    return { kind: "org", organizationId, membershipIds: [], locationIds: [], sealed: true };
  }

  // 2. supervisor for the resource's own location (target carries the resolved :location id).
  const locationId = targetStr(target, "locationId");
  if (hasRole(context, "supervisor") && locationId) {
    const ok = await resolver.isSupervisorForLocation({
      organizationId,
      userId: context.userId,
      locationId,
    });
    if (ok) {
      return {
        kind: "location",
        organizationId,
        membershipIds: [],
        locationIds: [locationId],
        sealed: true,
      };
    }
  }

  // 3. team reach via the M2 SupervisorReader (opaque) — the supervised membership ids.
  const supervised = await resolver.resolveSupervisedMembershipIds({
    organizationId,
    userId: context.userId,
  });
  if (supervised.length > 0) {
    return {
      kind: "team",
      organizationId,
      membershipIds: supervised,
      locationIds: [],
      sealed: true,
    };
  }

  // 4. self — the actor's own membership id (empty if the session carries none → caller fails closed).
  const self = membershipIdOf(context);
  return {
    kind: "self",
    organizationId,
    membershipIds: self ? [self] : [],
    locationIds: [],
    sealed: true,
  };
}

/**
 * Build M33's two §4.7 predicate resolvers over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers these via {@link registerM33AbacPredicates}). Target ids come from
 * the route `:id`/payload; a missing/cross-tenant row fails closed (deny).
 */
export function buildM33AbacPredicates(
  deps: ReportingAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;

  return {
    // D8 cross-cutting read scope: authorize the read iff a scope can be SEALED for the actor. Every
    // authenticated actor has at least `self`; an actor with no resolvable membership (and no org/team/
    // location authority) cannot be scope-filtered → fail-closed. The route layer reads the resolved
    // envelope (via resolveReportableScope) to inject the WHERE clause. §4.7.1.
    reportable_scope: async (context, target) => {
      if (!context.userId) return false; // fail-closed (no actor)
      const scope = await resolveReportableScope(context, target, resolver);
      if (scope.kind === "self" && scope.membershipIds.length === 0) return false; // unfilterable
      return true;
    },

    // Saved-view read/edit visibility: owner OR org-shared (same org) OR role-shared (actor holds a
    // shared role). `private` + not-owner → deny. §4.7.2 (verbatim).
    dashboard_visibility: async (context, target) => {
      const viewId = targetStr(target, "viewId");
      if (!viewId) return false; // fail-closed
      // The registry does not catch a predicate's throw, so a rejecting resolver (an invalid uuid raising
      // 22P02, a transient DB error) must DENY here rather than surface as a 500.
      const view = await resolver.loadReportView(context.organizationId, viewId).catch(() => null);
      if (!view) return false; // absent / cross-tenant / lookup failed
      const actorMembershipId = membershipIdOf(context);
      if (actorMembershipId && view.ownerMembershipId === actorMembershipId) return true;
      if (view.shareScope === "org" && context.organizationId === view.organizationId) return true;
      if (view.shareScope === "role" && view.shareRoleKeys.some((r) => context.roles.includes(r))) {
        return true;
      }
      return false; // share_scope === 'private' and not owner
    },

    // GAP-162 - the cross-tenant MV registry / replica-lag surface (§4.1 #37-40) is platform-only: a tenant role
    // that merely holds a `report.admin.*` permission key is NOT admitted. Server-side roles only.
    platform_admin_scope: async (context) => isPlatformAdminActor(context),

    // GAP-162 - the compliance drilldown-audit trail (§4.1 #41): tenant compliance / privacy / security officers.
    compliance_officer_scope: async (context) => isComplianceOfficerActor(context),

    // Schedule access (GAP-097): target = { scheduleId, mode }. `read` = owner / recipient / org_admin;
    // `write` = owner / org_admin; `admin` = org_admin only (delete_all_runs). The owner / recipients are
    // loaded from the STORED row and compared with the session membership + roles — never the request.
    report_schedule_access: async (context, target) => {
      const scheduleId = targetStr(target, "scheduleId");
      const mode = targetStr(target, "mode");
      if (!scheduleId || !mode) return false; // fail-closed
      if (mode === "admin") return isScheduleAdmin(context.roles);
      // A rejecting resolver denies (the registry does not catch a predicate's throw).
      const schedule = await resolver
        .loadReportSchedule(context.organizationId, scheduleId)
        .catch(() => null);
      if (!schedule || schedule.organizationId !== context.organizationId) return false;
      const actor = { membershipId: membershipIdOf(context), roles: context.roles };
      if (mode === "write") return canMutateSchedule(actor, schedule);
      if (mode === "read") return canReadSchedule(actor, schedule);
      return false;
    },
  };
}

/**
 * Register M33's two §4.7 ABAC predicate resolvers into M3's shared registry (idempotent). Call at boot;
 * defaults to the {@link denyStubReportingAbacResolver} so the predicates exist (fail-closed) BEFORE the
 * real M2 `SupervisorReader` / M5 `CaseloadProvider` + Drizzle `report_view` binding lands (P2C). Re-boot
 * (tests) skips already-registered names (single-owner / no-clear; the M34 precedent).
 */
export function registerM33AbacPredicates(
  deps: ReportingAbacDeps = { resolver: denyStubReportingAbacResolver },
): void {
  const predicates = buildM33AbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
