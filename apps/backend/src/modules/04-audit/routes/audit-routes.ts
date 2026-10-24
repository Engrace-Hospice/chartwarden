// apps/backend/src/modules/04-audit/routes/audit-routes.ts — M4-T06 the audit query route
// inventory (M4 spec §4.1–4.3; the §10.2 "who touched this chart" + §4.2 event search).
//
// These are the read surface over the M1-owned, append-only `audit_event` log: the Compliance
// event search, single-event detail, and the per-patient internal access history. Each is gated by
// the REAL Authorization Contract (`requirePermission("audit.read")` from @chartwarden/auth, M3) — the
// §4.5 permission handshake key M4 registers into M3's catalog in M4-T10. Reads are org-scoped:
// the injected `AuditQuery` port takes the actor's org and (in production) runs inside
// `withOrgContext` so RLS on `app.org_id` is the backstop; the slice default is the in-memory
// adapter from @chartwarden/audit. An ELEVATED / cross-tenant read additionally emits the
// `audit.elevated_access` meta-event (§2.6) — the watchers are watched.
//
// `audit_event` is HELPER-ONLY: this route file never SELECTs the schema directly; it consumes the
// typed query port from @chartwarden/audit (the only sanctioned reader).
import type { AuditContext, AuditExecutor, AuditQuery } from "@chartwarden/audit";
import { requirePermission } from "@chartwarden/auth";
import { ChartWardenError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { auditElevatedAccess, isElevatedAuditRead } from "../audit/audit-meta";
import {
  AuditEventParamsSchema,
  AuditEventsQuerySchema,
  PatientAccessParamsSchema,
  PatientAccessQuerySchema,
  parse,
} from "./audit-typebox";

/** A @chartwarden/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The injection surface for the audit query routes (mirrors M3's `AuthzRouteDeps`). */
export interface AuditRouteDeps {
  /** Read surface over `audit_event` (in-memory in the slice; Drizzle/withOrgContext in prod). */
  query: AuditQuery;
  /** Audit sink for the `audit.elevated_access` meta-event (audit() — the denylist runs there). */
  audit: AuditExecutor;
}

/** The org-scoped actor (org binding is server-side: the context, never the query/body). */
function actorOf(request: FastifyRequest): {
  organizationId: string;
  userId: string;
  roles: readonly string[];
} {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId, roles: ctx.roles };
}

/** Build the audit context for the meta-event from the request. */
function auditContextFor(request: FastifyRequest): AuditContext {
  const ctx = request.context;
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    actorKind: "user",
    actorRole: ctx.roles[0],
    correlationId: ctx.correlationId,
    requestId: String(request.id),
    sourceIp: ctx.ip,
    userAgent: ctx.userAgent,
  };
}

const auditRead = requirePermission("audit.read") as PreHandler;

export function registerAuditRoutes(app: FastifyInstance, deps: AuditRouteDeps): void {
  /** Emit the audit-of-audit meta-event when the reader is elevated / cross-tenant (§2.6). */
  async function metaLogIfElevated(request: FastifyRequest, routeId: string): Promise<void> {
    const { organizationId, roles } = actorOf(request);
    if (isElevatedAuditRead(roles, organizationId)) {
      await auditElevatedAccess(deps.audit, auditContextFor(request), { query: routeId });
    }
  }

  // --- §4.2 audit-event search (the Compliance / survey / incident query) ------------------
  app.get("/api/v1/audit/events", { preHandler: [auditRead] }, async (request) => {
    const { organizationId } = actorOf(request);
    const q = parse(AuditEventsQuerySchema, request.query);
    await metaLogIfElevated(request, "GET /api/v1/audit/events");
    return deps.query.searchEvents(organizationId, q);
  });

  // --- §4.2 single-event detail (the before/after diff) -----------------------------------
  app.get("/api/v1/audit/events/:id", { preHandler: [auditRead] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(AuditEventParamsSchema, request.params);
    await metaLogIfElevated(request, "GET /api/v1/audit/events/:id");
    const event = await deps.query.getEvent(organizationId, id);
    if (!event) throw new ChartWardenError("EVENT_NOT_FOUND", "audit event not found", 404);
    return event;
  });

  // --- §10.2 "who touched this chart" — per-patient internal access history ----------------
  app.get(
    "/api/v1/audit/patients/:patientId/access",
    { preHandler: [auditRead] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientAccessParamsSchema, request.params);
      const q = parse(PatientAccessQuerySchema, request.query);
      await metaLogIfElevated(request, "GET /api/v1/audit/patients/:patientId/access");
      return deps.query.patientAccess(organizationId, patientId, q);
    },
  );
}
