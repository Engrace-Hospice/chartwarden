// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/support-ledger-hook.ts — slice 7 (7S).
//
// The ledger of what a ChartWarden operator did while a consented support session was open on a tenant. An `onResponse` hook on
// every `/api/v1/platform/tenants/:orgSlug/*` route appends ONE `support_session_event` (kind `ops.write`) per SUCCESSFUL non-GET
// request, when the operator holds an open session on that tenant. What it records is the route TEMPLATE, the method and the
// status, never a request body, never an id out of one, never the slug; the tenant reads exactly that (`detail`) and nothing of
// who did it.
//
// What this is and is not. It is a trail the tenant can read and a surveyor can follow, tied to the consent the session rests on.
// It is NOT a gate: a session authorizes nothing in the platform lane (CW-AC-12 stays the control), so an operator's write with no
// session, or after the tenant ended help, still goes through and leaves only its own audit rows.
//
// One row per WRITE, not per response: an idempotent replay (the same Idempotency-Key sent again after the first request
// succeeded) is answered from the cache by an earlier `preHandler` hook, before any handler runs, and must not count again. A
// `preHandler` hook registered after that one marks the requests that got past it, and only those are recorded.
//
// Best effort, after the response: the write has already committed, so a failure to append the row is logged (ids and an error
// class, never a message) and never turns a success into an error. The ceiling: a process crash between the commit and this hook
// loses the ledger row; the write's own audit rows remain.
import type { FastifyInstance } from "fastify";

/** The route prefix the hook covers: every platform route that acts on one tenant by slug. */
export const PLATFORM_TENANT_ROUTE_PREFIX = "/api/v1/platform/tenants/:orgSlug/";

const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** One successful operator write on a tenant, as the hook hands it over. */
export interface SupportLedgerWrite {
  readonly actorMembershipId: string;
  readonly orgSlug: string;
  /** The Fastify route TEMPLATE (`/api/v1/platform/tenants/:orgSlug/...`), never the URL. */
  readonly route: string;
  readonly method: string;
  readonly status: number;
  readonly actorIp: string | null;
}

/** Appends the ledger row when the operator holds an open session on the tenant, and does nothing otherwise. */
export interface SupportLedgerRecorder {
  recordOpsWrite(write: SupportLedgerWrite): Promise<void>;
}

export interface SupportLedgerHookDeps {
  readonly recorder: SupportLedgerRecorder;
  /** Log sink for a failed append (ids and an error class only). */
  readonly warn?: (message: string, context: Record<string, unknown>) => void;
}

/** Register the hook. Call BEFORE the platform routes are mounted so it is in scope for all of them. */
export function registerSupportLedgerHook(app: FastifyInstance, deps: SupportLedgerHookDeps): void {
  // Requests that were not answered by an earlier hook (an idempotent replay is): they reached a handler.
  const reachedHandler = new WeakSet<object>();
  app.addHook("preHandler", async (request) => {
    reachedHandler.add(request);
  });
  app.addHook("onResponse", async (request, reply) => {
    if (!reachedHandler.has(request)) return;
    const route = request.routeOptions?.url;
    if (!route?.startsWith(PLATFORM_TENANT_ROUTE_PREFIX)) return;
    if (READ_ONLY_METHODS.has(request.method)) return;
    if (reply.statusCode < 200 || reply.statusCode >= 300) return;
    const membershipId = request.context?.attributes?.membershipId;
    const orgSlug = (request.params as { orgSlug?: unknown } | undefined)?.orgSlug;
    if (typeof membershipId !== "string" || membershipId.length === 0) return;
    if (typeof orgSlug !== "string" || orgSlug.length === 0) return;
    try {
      await deps.recorder.recordOpsWrite({
        actorMembershipId: membershipId,
        orgSlug,
        route,
        method: request.method,
        status: reply.statusCode,
        actorIp: request.ip ?? null,
      });
    } catch (error) {
      deps.warn?.("m34.support_ledger: the ops.write row was not appended", {
        actorMembershipId: membershipId,
        route,
        method: request.method,
        status: reply.statusCode,
        errorClass: error instanceof Error ? error.name : "unknown",
      });
    }
  });
}
