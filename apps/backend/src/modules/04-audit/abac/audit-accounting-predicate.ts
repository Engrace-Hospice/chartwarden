// apps/backend/src/modules/04-audit/abac/audit-accounting-predicate.ts — M4-T09 the
// `audit_accounting_scope_allowed` ABAC predicate (M4 spec §7.2; route §7.1).
//
// The accounting route (§7.1) carries two guards: `requirePermission('audit.disclosure_report')`
// (the base right) and this ABAC predicate. The predicate's only job is the `?scope=all`
// escalation: the broad union scope additionally requires the dedicated
// `audit.disclosure_report_all_scopes` key (§4.5). `hipaa_528` / `part_2_13` are covered by the
// base permission alone, so the predicate allows them outright.
//
// M4 owns the predicate's SEMANTICS but registers it into Module 3's shared named-predicate
// registry through the `registerPredicate` seam (`@wardenx/auth`, M3-T07) — never a direct M3
// schema import, so no cross-module dependency edge is introduced. The scope rides on the ABAC
// TARGET the route assembles from `request.query.scope` (server-side, never trusted client
// context); the actor's effective permissions are read through `resolveActorPermissions` — the
// same resolver `requirePermission` gates on — so the predicate and the base guard agree.
import {
  type AbacPredicate,
  type PredicateRegistry,
  registerPredicate,
  resolveActorPermissions,
} from "@wardenx/auth";

/** The registry name M3 resolves and the route names in `requireAbac(...)` (§7.2). */
export const AUDIT_ACCOUNTING_SCOPE_PREDICATE = "audit_accounting_scope_allowed";

/** The dedicated permission the `all` scope requires beyond `audit.disclosure_report` (§4.5). */
export const ACCOUNTING_ALL_SCOPE_PERMISSION = "audit.disclosure_report_all_scopes";

/** The default accounting scope when none is supplied (§7.1) — the narrow HIPAA §164.528 view. */
const DEFAULT_SCOPE = "hipaa_528";

/**
 * Resolves an actor's effective permission set from their (org, user) — defaults to the
 * Authorization Contract's registered resolver, so the predicate sees exactly what
 * `requirePermission` sees. Tests may inject a fixed probe.
 */
export type AccountingPermissionProbe = (actor: {
  organizationId: string;
  userId: string;
}) => ReadonlySet<string> | Promise<ReadonlySet<string>>;

/**
 * Build the `audit_accounting_scope_allowed` predicate (§7.2). Allows every scope except `all`
 * outright (the base `audit.disclosure_report` permission already gates the route); `all`
 * additionally requires `audit.disclosure_report_all_scopes`. Fail closed: an unknown scope is
 * treated as non-`all` (allowed by the base permission); a missing all-scope key denies (→ 403).
 */
export function createAccountingScopePredicate(
  probe: AccountingPermissionProbe = resolveActorPermissions,
): AbacPredicate {
  return async (context, target) => {
    const scope = typeof target.scope === "string" ? target.scope : DEFAULT_SCOPE;
    if (scope !== "all") return true;
    const permissions = await probe({
      organizationId: context.organizationId,
      userId: context.userId,
    });
    return permissions.has(ACCOUNTING_ALL_SCOPE_PERMISSION);
  };
}

/**
 * Register the predicate into Module 3's registry (default: the shared `abacRegistry` via
 * `registerPredicate`). The composition root calls this once at boot; tests pass a fresh
 * `registry` for isolation (the shared registry is a single-owner singleton — re-registering a
 * name throws). Returns nothing; the predicate is resolved by name through `requireAbac`.
 */
export function registerAccountingScopePredicate(
  options: {
    readonly probe?: AccountingPermissionProbe;
    readonly registry?: Pick<PredicateRegistry, "register">;
  } = {},
): void {
  const predicate = createAccountingScopePredicate(options.probe);
  if (options.registry) {
    options.registry.register(AUDIT_ACCOUNTING_SCOPE_PREDICATE, predicate);
  } else {
    registerPredicate(AUDIT_ACCOUNTING_SCOPE_PREDICATE, predicate);
  }
}
