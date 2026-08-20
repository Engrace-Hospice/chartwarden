// @wardenx/tenancy — Context helpers (M1-T06; spec §3.14).
//
// `withOrgContext()` runs a unit of work inside a transaction with the canonical
// tenant session variable `app.org_id` set, so Postgres RLS (the policies emitted by
// generateRlsPolicy(), §3.13) enforces tenant isolation at the database layer. Every
// PHI-touching code path MUST run inside withOrgContext.
//
// `withPlatformContext()` is the GATED cross-tenant escape hatch for platform jobs
// (NPPES sync, partition rotation, outbox dispatch, …). It does NOT `SET ROLE`
// wardenx_admin on a tenant connection (that would collapse the RLS-bypass boundary
// into the request process — SEC-097/OPS-070). It runs against a SEPARATELY POOLED
// platform credential and is allowlist-gated; non-registered callers are refused.
//
// Relocated here from the M1 spec's `packages/db/src/context.ts` per the manifest
// (`packages/tenancy — withOrgContext() + RLS policy generator`) and ADR-0005 D3
// (`packages/foundation` is banned).
//
// SESSION-VARIABLE MECHANISM. We use `set_config('app.org_id', <value>, /*is_local*/ true)`
// rather than `SET LOCAL app.org_id = <value>`: Postgres `SET LOCAL` cannot bind a
// parameter, so the value would have to be string-interpolated into DDL — a tenant-id
// injection vector. `set_config(name, value, true)` takes the value as a bound parameter
// and is transaction-local exactly like SET LOCAL, so the variable auto-resets when the
// transaction commits or rolls back (never leaks to the next checkout of a pooled
// connection). RLS reads it back with `current_setting('app.org_id', true)`.

import { AsyncLocalStorage } from "node:async_hooks";
import { type SQL, sql } from "drizzle-orm";

/** Minimal structural view of a Drizzle transaction: it can execute a SQL fragment. */
export interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

/** Minimal structural view of a Drizzle database: it can open a transaction. */
export interface TransactionalDb<Tx extends SqlExecutor> {
  transaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R>;
}

/** The tenant scope a request carries. `userId` feeds the M4 audit-trigger attribution. */
export interface OrgContext {
  readonly organizationId: string;
  readonly userId: string;
}

/** A pre-org session identity. It may read only rows whose RLS policy explicitly keys on app.user_id. */
export interface UserContext {
  readonly userId: string;
}

/**
 * Runs `fn` inside a transaction with `app.org_id` and `app.user_id` set transaction-locally,
 * so RLS enforces tenant isolation for every statement `fn` issues on `tx`. Both variables
 * are auto-reset at transaction end (is_local = true), so nothing leaks across pooled
 * connections.
 */
export async function withOrgContext<Tx extends SqlExecutor, T>(
  db: TransactionalDb<Tx>,
  ctx: OrgContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', ${ctx.organizationId}, true)`);
    await tx.execute(sql`SELECT set_config('app.user_id', ${ctx.userId}, true)`);
    return fn(tx);
  });
}

/**
 * Runs a pre-organization operation with only `app.user_id` set. This is deliberately narrower
 * than `withOrgContext`: it grants no tenant scope, and is valid only for policies such as the
 * identity membership picker that explicitly allow a user to see their own rows across orgs.
 */
export async function withUserContext<Tx extends SqlExecutor, T>(
  db: TransactionalDb<Tx>,
  ctx: UserContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${ctx.userId}, true)`);
    return fn(tx);
  });
}

// --- Platform (cross-tenant) context ---------------------------------------------------

/** Refused platform-context entry — the caller is not a registered platform job. */
export class PlatformContextDeniedError extends Error {
  constructor(jobId: string) {
    super(`platform-context denied for caller '${jobId}' (not a registered platform job)`);
    this.name = "PlatformContextDeniedError";
  }
}

/** Identity + justification a platform job presents when entering platform context. */
export interface PlatformCaller {
  /** Registered platform-job id (must be on the allowlist). */
  readonly jobId: string;
  /** Human-readable reason — recorded in the bypass audit event. */
  readonly reason: string;
  /** True when the unit of work reads/writes across tenants (audited at severity=critical). */
  readonly crossTenant?: boolean;
}

/** The audit payload emitted for every platform-context invocation. */
export interface PlatformBypassEvent {
  readonly jobId: string;
  readonly reason: string;
  readonly severity: "warn" | "critical";
}

/**
 * Emits the mandatory `platform.bypass_invoked` audit event for a platform-context entry.
 * Injected (not implemented here) because the audit_event table is HELPER-ONLY — it is
 * written exclusively through `packages/audit` (audit()), wired in at M1-T12. Keeping it a
 * dependency keeps the "every bypass is audited" guarantee in the type signature while
 * keeping this leaf helper free of any cross-module schema write.
 */
export type PlatformBypassAuditor<Tx extends SqlExecutor> = (
  tx: Tx,
  event: PlatformBypassEvent,
) => Promise<void>;

// The allowlist is populated at boot from the platform-job registry; it starts empty so
// nothing can enter platform context until a job is explicitly registered (fail-closed).
const PLATFORM_CONTEXT_ALLOWLIST = new Set<string>();

/** Registers a platform-job id as permitted to enter platform context (called at boot). */
export function registerPlatformJob(jobId: string): void {
  PLATFORM_CONTEXT_ALLOWLIST.add(jobId);
}

/** True if `jobId` is a registered platform job. */
export function isPlatformJobRegistered(jobId: string): boolean {
  return PLATFORM_CONTEXT_ALLOWLIST.has(jobId);
}

/** Test/boot reset hook — clears the allowlist. */
export function resetPlatformJobRegistry(): void {
  PLATFORM_CONTEXT_ALLOWLIST.clear();
}

/**
 * GATED cross-tenant execution for platform jobs. Refuses any caller not on the allowlist
 * (throws PlatformContextDeniedError — no free-text-reason-only entry), audits the bypass,
 * then runs `fn` against the platform credential's transaction. `platformDb` is a separately
 * pooled platform login role carrying the minimal cross-tenant grants — NOT the tenant pool,
 * and there is NO `SET ROLE` here (SEC-097/OPS-070).
 */
export async function withPlatformContext<Tx extends SqlExecutor, T>(
  platformDb: TransactionalDb<Tx>,
  caller: PlatformCaller,
  auditBypass: PlatformBypassAuditor<Tx>,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!PLATFORM_CONTEXT_ALLOWLIST.has(caller.jobId)) {
    throw new PlatformContextDeniedError(caller.jobId);
  }
  return platformDb.transaction(async (tx) => {
    await auditBypass(tx, {
      jobId: caller.jobId,
      reason: caller.reason,
      severity: caller.crossTenant ? "critical" : "warn",
    });
    return fn(tx);
  });
}

// --- Request-context plumbing ----------------------------------------------------------

/**
 * Ambient per-request context. The request middleware (M1-T10) opens this once per request;
 * downstream code (audit(), seam calls, withOrgContextFromRequest) reads the tenant/actor
 * without threading it through every signature.
 */
export interface RequestContext extends OrgContext {
  /** Correlation id stitching audit events + outbox records for one request. */
  readonly correlationId?: string;
  /** Per-request id (echoed in the error envelope / logs). */
  readonly requestId?: string;
}

const requestStore = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `ctx` as the ambient request context for its entire async subtree. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestStore.run(ctx, fn);
}

/** The ambient request context, or undefined outside a request (e.g. a platform job). */
export function getRequestContext(): RequestContext | undefined {
  return requestStore.getStore();
}

/** The ambient request context, or throws if called outside a request scope. */
export function requireRequestContext(): RequestContext {
  const ctx = requestStore.getStore();
  if (!ctx) throw new Error("no ambient request context (call inside runWithRequestContext)");
  return ctx;
}

/**
 * Convenience: runs `fn` in `withOrgContext` using the ambient request context's tenant scope.
 * Throws if there is no ambient request context.
 */
export async function withOrgContextFromRequest<Tx extends SqlExecutor, T>(
  db: TransactionalDb<Tx>,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const { organizationId, userId } = requireRequestContext();
  return withOrgContext(db, { organizationId, userId }, fn);
}
