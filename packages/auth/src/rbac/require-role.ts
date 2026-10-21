// @wardenx/auth · rbac — the Authorization Contract (M3 — Authorization, M3-T05).
//
// Spec §4.1 (the middleware EVERY module consumes) + §2.2 (the resolution pipeline).
// This file ships the RBAC half of the single guard surface every module's routes use:
// `requireSession`, `requireRole`, `requirePermission`. Each is a **preHandler factory**
// (`requirePermission('role.read')` → a guard) matching the canonical §4.1 declaration,
// so a route reads `preHandler: [authenticate, requirePermission(...), requireAbac(...)]`.
//
// DENY BY DEFAULT (§2.2). `requirePermission` resolves the actor's EFFECTIVE permission
// set through an INJECTED resolver seam and denies on miss. The real resolver
// (membership_role → role_permission, cached) is M3-T06's `resolve.ts`/`cache.ts`; until a
// module registers one, the default resolver grants NOTHING, so every permission check
// fails CLOSED — a missing resolver is a bug, never an allow. The ABAC half
// (`requireAbac`) lives in `../abac/require-abac` and consumes its own deny-default seam.
//
// `packages/auth` stays Fastify-agnostic: guards are typed against the structural
// `GuardRequest` (the `@wardenx/types` `HttpRequestContext` on `request.context`), which
// is assignable from `FastifyRequest`, so the same guard is a valid Fastify preHandler
// without this leaf package importing `fastify`.
import { ForbiddenError, type HttpRequestContext, UnauthorizedError } from "@wardenx/types";
import type { PermissionKey } from "../permissions/catalog";

/**
 * The minimal request shape a guard reads. `FastifyRequest` is structurally assignable to
 * this (it carries `.context` after M1's request-context middleware, plus `.params`), so a
 * `GuardHandler` is a valid Fastify preHandler without coupling this package to Fastify.
 */
export interface GuardRequest {
  readonly context: HttpRequestContext;
  readonly params?: unknown;
  readonly body?: unknown;
  readonly query?: unknown;
}

/**
 * A route preHandler in the §2.2 pipeline. Resolves (no-op) when access is permitted and
 * THROWS a `ChartWardenError` (401/403/404) when denied — the M1 error handler renders the
 * envelope. Async so a guard may consult the DB-backed resolver/evaluator seams.
 */
export type GuardHandler = (request: GuardRequest) => Promise<void>;

/**
 * Run guards in the fixed §2.2 order, short-circuiting on the first denial — the same
 * sequential semantics Fastify applies to a `preHandler` array. A later guard never runs
 * once an earlier one throws (authenticate → RBAC → ABAC). Handy for composing a route's
 * guard chain in one value and for asserting pipeline ordering in tests.
 */
export function composeGuards(...guards: GuardHandler[]): GuardHandler {
  return async (request) => {
    for (const guard of guards) {
      await guard(request);
    }
  };
}

/** Fail closed unless the request carries an org-scoped authenticated session. */
export function requireSession(): GuardHandler {
  return async (request) => {
    if (!request.context?.organizationId) throw new UnauthorizedError();
  };
}

/**
 * Fail closed unless the session holds at least one of `roleKeys`. Coarse role-list check
 * (the role keys the request context already carries); fine-grained permission gating is
 * `requirePermission`. 403 on miss, 401 when there is no session at all.
 */
export function requireRole(...roleKeys: string[]): GuardHandler {
  return async (request) => {
    const ctx = request.context;
    if (!ctx?.organizationId) throw new UnauthorizedError();
    if (!roleKeys.some((role) => ctx.roles.includes(role))) {
      throw new ForbiddenError(`requires one of role(s): ${roleKeys.join(", ")}`);
    }
  };
}

/**
 * Resolves an actor's EFFECTIVE permission keys for their active org (§2.2 step "Resolve
 * effective permissions: membership_role → role_permission"). Registered by M3-T06's RBAC
 * engine; until then the default denies everything (fail closed).
 */
export type EffectivePermissionResolver = (
  context: HttpRequestContext,
) => Promise<ReadonlySet<string>> | ReadonlySet<string>;

/** Fail-closed default: no resolver registered ⇒ no permissions ⇒ every check 403s. */
const DENY_ALL_RESOLVER: EffectivePermissionResolver = () => new Set<string>();
let effectivePermissionResolver: EffectivePermissionResolver = DENY_ALL_RESOLVER;

/** M3-T06 registers the real (cached) resolver at boot. */
export function setEffectivePermissionResolver(resolver: EffectivePermissionResolver): void {
  effectivePermissionResolver = resolver;
}

/** Restore the fail-closed default (boot reset / tests). */
export function resetEffectivePermissionResolver(): void {
  effectivePermissionResolver = DENY_ALL_RESOLVER;
}

/**
 * Resolve an actor's effective permission set via the SAME registered resolver
 * `requirePermission` gates on — for consumers that must *check* a permission rather than gate
 * on it (e.g. an ABAC predicate that allows a broader scope only when the actor holds a
 * dedicated key, §7.2). Only `organizationId`/`userId` are read, so the assembled `AbacContext`
 * (a subset of the request context) is a valid argument. Fail closed: with no resolver
 * registered the set is empty, so the dependent check denies.
 */
export function resolveActorPermissions(
  actor: Pick<HttpRequestContext, "organizationId" | "userId">,
): Promise<ReadonlySet<string>> | ReadonlySet<string> {
  return effectivePermissionResolver(actor as HttpRequestContext);
}

/**
 * A permission key passed to `requirePermission`. M3's own catalog keys (`PermissionKey`)
 * autocomplete; other modules contribute keys into the aggregated registry (§3.3), so any
 * registered `string` is also accepted (the `& {}` keeps M3 keys in IntelliSense).
 */
export type PermissionKeyInput = PermissionKey | (string & {});

/**
 * RBAC gate (§4.1, §2.2). Resolves the actor's effective permission set via the registered
 * resolver and denies (403) unless `key` is present. Deny by default: with no resolver the
 * set is empty and every route fails closed.
 */
export function requirePermission(key: PermissionKeyInput): GuardHandler {
  return async (request) => {
    const ctx = request.context;
    if (!ctx?.organizationId) throw new UnauthorizedError();
    const granted = await effectivePermissionResolver(ctx);
    if (!granted.has(key)) {
      throw new ForbiddenError(`requires permission '${key}'`);
    }
  };
}
