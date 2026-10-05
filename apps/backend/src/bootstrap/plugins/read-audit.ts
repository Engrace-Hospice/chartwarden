// apps/backend/src/bootstrap/plugins/read-audit.ts — PHI read-audit coverage gate (M4 §2.5).
//
// "Read-audit completeness" (M4 spec §2.5): EVERY PHI read route must either emit a read event
// (auditPhiRead/auditListRead) or carry an explicit, justified waiver — a missing read trail is a
// caught omission, never a silent gap. The declaration contract has existed (declareReadAudit /
// assertReadAuditDeclared) but nothing enforced it, so the obligation was dormant (audit finding #4).
//
// This plugin does TWO things:
//   1. COVERAGE (fail-closed boot gate): an `onRoute` hook refuses to register any GOVERNED PHI read
//      route (a GET/HEAD under an enforced path prefix) that lacks `config.auditRead` — an emission
//      config or a `{ none: <justification> }` waiver. The server cannot boot while a PHI read route
//      is undeclared. Keyed off the actually-registered routes, so it can never drift from a stale list.
//   2. EMISSION: a `preSerialization` hook (plus an `onSend` fallback for Buffer/stream/string replies) writes the actual read event for every successful (2xx)
//      response whose route carries an EMISSION config — `auditPhiRead` for a single chart open or
//      `auditListRead` (count + filter) for a list — through `withOrgContext` so the row is org-scoped
//      under RLS, exactly like every other audit write. Emission is best-effort: a failure is logged,
//      never fatal, so an audit hiccup can't take a read offline. Requires a DB client; without one
//      (slice/tests) only coverage runs.
// Write routes are out of scope — the M4 write-audit triggers (generateAuditTrigger) cover mutations.
import {
  type AuditContext,
  type RouteReadAudit,
  type RouteReadAuditEmit,
  auditListRead,
  auditPhiRead,
  declareReadAudit,
  routeReadAuditMode,
} from "@wardenx/audit";
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * PHI read-audit intent for this route (§2.5). REQUIRED on any GET/HEAD under an enforced PHI
     * prefix: an emission config (`{ resourceKind, patientIdParam?, fields? }`) or a justified
     * waiver (`{ none: "<why no PHI is surfaced>" }`).
     */
    auditRead?: RouteReadAudit;
  }
}

/** Thrown at route registration when a governed PHI read route omits its `config.auditRead` (§2.5). */
export class ReadAuditCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadAuditCoverageError";
  }
}

/** Normalize a route's method(s) to an array (Fastify allows a single method or a list). */
function methodsOf(method: string | string[]): string[] {
  return Array.isArray(method) ? method : [method];
}

/**
 * Is this a PHI read route the coverage rule governs? A read is GET or HEAD; "governed" means its
 * URL sits under one of the enforced PHI prefixes. Pure, so the predicate is unit-testable.
 */
export function isGovernedReadRoute(
  method: string | string[],
  url: string,
  prefixes: readonly string[],
): boolean {
  const isRead = methodsOf(method).some((m) => m === "GET" || m === "HEAD");
  if (!isRead) return false;
  return prefixes.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`));
}

/** The emission config for a route, or `null` when the route is absent/waived (no event to emit). */
function emissionConfig(value: RouteReadAudit | undefined): RouteReadAuditEmit | null {
  if (!value || "none" in value) return null;
  return value;
}

/**
 * Read a dot path out of a response payload, e.g. `"data.0.patientId"` — numeric segments index
 * arrays (JS indexes them by string key, so no special case is needed). Returns the value only when
 * it is a non-empty string; anything else (missing, wrong type, empty) reads as "not found".
 */
function atPath(payload: unknown, path: string): string | undefined {
  let cur: unknown = payload;
  for (const segment of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return typeof cur === "string" && cur.length > 0 ? cur : undefined;
}

/**
 * The patient this read touched, for the §164.528 accounting join: route param first, then query
 * param, then the response payload. A route whose config names none of the three emits an event
 * with no patient attribution — correct for a read that genuinely has no single patient (an
 * org-wide queue), and the reason a patient-scoped route must name one of them.
 */
function resolvePatientId(
  cfg: RouteReadAuditEmit,
  params: Record<string, string>,
  query: unknown,
  payload: unknown,
): string | undefined {
  const fromParam = cfg.patientIdParam ? params[cfg.patientIdParam] : undefined;
  if (fromParam) return fromParam;
  const fromQuery = cfg.patientIdQueryParam
    ? (query as Record<string, unknown> | undefined)?.[cfg.patientIdQueryParam]
    : undefined;
  if (typeof fromQuery === "string" && fromQuery.length > 0) return fromQuery;
  const paths = cfg.patientIdPayloadPath;
  for (const path of typeof paths === "string" ? [paths] : (paths ?? [])) {
    const found = atPath(payload, path);
    if (found) return found;
  }
  return undefined;
}

/** Row count for a list read — an `items` array (cursor-page convention), a bare array, or the first array property. */
function rowCount(payload: unknown): number {
  if (Array.isArray(payload)) return payload.length;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items.length;
    for (const v of Object.values(obj)) if (Array.isArray(v)) return v.length;
  }
  return 0;
}

/**
 * Install the read-audit coverage gate (+ emission when a DB client is present). Add BEFORE the module
 * routes are registered: the `onRoute` coverage hook only sees routes registered after it. `enforcedPrefixes`
 * is the set of PHI path prefixes under coverage; `db` enables the `preSerialization` emission hook.
 */
export function applyReadAuditCoverage(
  app: FastifyInstance,
  opts: { enforcedPrefixes: readonly string[]; db?: DbClient },
): void {
  app.addHook("onRoute", (route) => {
    if (!isGovernedReadRoute(route.method, route.url, opts.enforcedPrefixes)) return;
    const method = methodsOf(route.method).join(",");
    const routeId = `${method} ${route.url}`;
    const mode = routeReadAuditMode(route.config?.auditRead);
    if (!mode) {
      throw new ReadAuditCoverageError(
        `PHI read route '${routeId}' must declare config.auditRead — an emission config { resourceKind, patientIdParam?, fields? } or a justified waiver { none: "…" } (§2.5 read-audit completeness)`,
      );
    }
    // Records the intent (and throws if a waiver omits its justification) so a boot-time
    // assertReadAuditDeclared() / the M4 accounting can see the mounted PHI read surface.
    declareReadAudit(routeId, mode);
  });

  // EMISSION — write the actual read event on a successful response (needs a DB client to insert).
  const db = opts.db;
  if (!db) return;
  const emitted = new WeakSet<object>();
  /**
   * Write the read event for one successful response. `payload` is the parsed object when called from
   * preSerialization; from onSend (binary/string replies, which Fastify never serializes — GAP-013) it
   * is a Buffer/stream/string and is deliberately NOT inspected, so no PHI byte can reach the audit row.
   */
  const emit = async (
    request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
    binary: boolean,
  ): Promise<void> => {
    try {
      const cfg = emissionConfig(request.routeOptions?.config?.auditRead);
      if (!cfg) return; // non-PHI route, or a justified waiver → nothing to emit
      if (reply.statusCode < 200 || reply.statusCode >= 300) return; // only successful reads
      const ctx = request.context;
      if (!ctx?.organizationId) return; // unauthenticated/no-org — the route denied anyway
      if (binary && (cfg.list || cfg.patientIdPayloadPath)) {
        // A non-JSON body has no rows/fields to read: such a config on this route is a coding error.
        request.log.error(
          { url: request.routeOptions?.url },
          "read-audit: list/patientIdPayloadPath config on a non-JSON response cannot be honored",
        );
        return;
      }
      const params = (request.params ?? {}) as Record<string, string>;
      const patientId = resolvePatientId(cfg, params, request.query, binary ? undefined : payload);
      const auditCtx: AuditContext = {
        organizationId: ctx.organizationId,
        userId: ctx.userId || null,
        correlationId: ctx.correlationId,
        requestId: request.id,
        sourceIp: ctx.ip,
        userAgent: ctx.userAgent,
      };
      await withOrgContext(
        db,
        { organizationId: ctx.organizationId, userId: ctx.userId || "" },
        async (tx) => {
          if (cfg.list) {
            await auditListRead(tx, auditCtx, {
              resourceKind: cfg.resourceKind,
              count: rowCount(payload),
              filter: request.query as Record<string, unknown> | undefined,
              patientId,
            });
          } else {
            // A single chart open: account it against the resource (defaults to the patient, §164.528).
            const resourceId =
              (cfg.resourceIdParam ? params[cfg.resourceIdParam] : undefined) ?? patientId ?? "";
            await auditPhiRead(tx, auditCtx, {
              resourceKind: cfg.resourceKind,
              resourceId,
              patientId,
              fields: cfg.fields,
            });
          }
        },
      );
    } catch (err) {
      // Best-effort: a read-audit write failure is logged, never fatal (a hiccup must not 500 a read).
      request.log.error({ err }, "read-audit emission failed");
    }
  };

  app.addHook("preSerialization", async (request, reply, payload) => {
    emitted.add(request);
    await emit(request, reply, payload, false);
    return payload;
  });
  // GAP-013: Fastify skips preSerialization for Buffer/stream/string payloads, so those replies were
  // never audited. onSend sees every reply; emit here only when preSerialization did not run.
  app.addHook("onSend", async (request, reply, payload) => {
    if (!emitted.has(request)) await emit(request, reply, payload, true);
    return payload;
  });
}
