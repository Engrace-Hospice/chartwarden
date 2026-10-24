import {
  type AuditContext,
  audit,
  decodeCursor,
  encodeCursor,
  isMessagingOnlyCriteria,
  resolveLimit,
} from "@chartwarden/audit";
// apps/backend/src/modules/04-audit/routes/destruction-certificates.ts — GAP-003 the §6
// destruction-certificate surface (M4 spec §4.2-4.3, §6, §10.5).
//
// `destruction_certificate` is M4-OWNED (architecture/module-manifest.ts) so this file talks to the
// table directly over Drizzle + `withOrgContext`. What this file does NOT do: actually execute a
// destruction. `runExecuteDestruction` (@chartwarden/audit `jobs/processors.ts`) needs a Drizzle-backed
// `ExecuteDestructionPorts` adapter (eraser + certificate-status writer) that — like the rest of
// M4's BullMQ worker wiring (`registerAuditWorkers`/`scheduleAuditJobs`, see
// apps/backend/src/index.ts's "M4-T11 BullMQ worker-construction precedent" comment) — has never
// been bound anywhere in this codebase; building that binding is a materially larger, separate
// piece of infra than "give Compliance an HTTP surface" (GAP-003's actual ask). `approve` therefore
// does exactly what its own spec response promises and nothing more: it flips the certificate's
// status to `approved` (a real, persisted, audited state transition) and stops there — it does not
// pretend the certificate's rows were destroyed. The `HELD_RECORDS_PRESENT` pre-check below is a
// best-effort UX guard over the certificate's `dataClass`; the AUTHORITATIVE legal-hold check is,
// and remains, `createDrizzleAuditEraserPorts.legalHoldFor` (erasers/audit-eraser.ts) at actual
// per-row execution time — which is exactly why a held row can never be destroyed even though this
// route's own pre-check is approximate.
import { requirePermission, requireStepUp } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { NotFoundError, UnauthorizedError, ChartWardenError } from "@chartwarden/types";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LegalHoldCriteria } from "./audit-typebox";
import {
  DestructionCertificateIdParamsSchema,
  type DestructionCertificateListQuery,
  DestructionCertificateListQuerySchema,
  HoldDestructionCertificateBodySchema,
  parse,
} from "./audit-typebox";

/** A @chartwarden/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The injection surface for the destruction-certificates routes. */
export interface DestructionCertificatesRouteDeps {
  readonly db: DbClient;
}

const CERT = schema.destructionCertificates;
const HOLD = schema.legalHolds;

function actorOf(request: FastifyRequest): {
  organizationId: string;
  userId: string;
  roles: readonly string[];
} {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId, roles: ctx.roles };
}

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

const destructionRead = requirePermission("destruction.read") as PreHandler;
const destructionApprovePermission = requirePermission("destruction.approve") as PreHandler;
// §4.5 "step-up re-auth required" — a SERVER fact over M3's `step_up_recent` predicate, never a
// caller-supplied token (see destruction-certificates typebox comment / the M26 audit-C2 precedent).
const destructionStepUp = requireStepUp("destruction.approve") as PreHandler;

function toCertificateView(row: typeof CERT.$inferSelect) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    dataClass: row.dataClass,
    recordCount: row.recordCount,
    dateRangeStart: row.dateRangeStart.toISOString(),
    dateRangeEnd: row.dateRangeEnd.toISOString(),
    method: row.method,
    status: row.status,
    approvedBy: row.approvedBy,
    executedAt: row.executedAt ? row.executedAt.toISOString() : null,
    refusalReason: row.refusalReason,
    createdAt: row.createdAt.toISOString(),
  };
}

/** True when an ACTIVE legal hold's criteria plausibly covers `dataClass` (best-effort; over-
 *  matching is the safe direction here — see file header). A hold with no `resourceKinds`
 *  restriction covers everything; one that lists `resourceKinds` covers `dataClass` only when it
 *  names it (mirrors `createDrizzleAuditEraserPorts.legalHoldFor`'s conservative substring match). */
export function holdCoversDataClass(
  criteria: LegalHoldCriteria,
  dataClass: string,
  range: { start: Date; end: Date },
): boolean {
  // GAP-008: a hold whose date range does not touch the certificate's range cannot cover any of its rows.
  if (criteria.dateRange) {
    const from = Date.parse(criteria.dateRange.from);
    const to = Date.parse(criteria.dateRange.to);
    if (
      !Number.isNaN(from) &&
      !Number.isNaN(to) &&
      (to < range.start.getTime() || from > range.end.getTime())
    ) {
      return false;
    }
  }
  // ADR-0086 (proposed): a messaging-only hold protects `message.<class>` data and nothing else, so it must not
  // block an audit-class certificate (it would otherwise read as "no resourceKinds => covers everything").
  if (isMessagingOnlyCriteria(criteria) && !dataClass.startsWith("message.")) return false;
  if (!criteria.resourceKinds || criteria.resourceKinds.length === 0) return true;
  return criteria.resourceKinds.some((k) => dataClass.includes(k) || k.includes(dataClass));
}

/**
 * Mount the §4.2 destruction-certificate routes: list, approve, hold. Behind
 * `destruction.read`/`destruction.approve` (M4 spec §4.5); `approve` additionally requires a fresh
 * step-up (§4.5 note). See the file header for what `approve` does and deliberately does not do.
 */
export function registerDestructionCertificatesRoutes(
  app: FastifyInstance,
  deps: DestructionCertificatesRouteDeps,
): void {
  app.get(
    "/api/v1/destruction-certificates",
    { preHandler: [destructionRead] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const q = parse(
        DestructionCertificateListQuerySchema,
        request.query,
      ) as DestructionCertificateListQuery;
      return withOrgContext(deps.db, { organizationId, userId }, async (tx) => {
        const limit = resolveLimit(q.limit);
        const where = [eq(CERT.organizationId, organizationId)];
        if (q.status) where.push(eq(CERT.status, q.status));
        const cur = q.cursor ? decodeCursor(q.cursor) : null;
        if (cur) {
          where.push(
            sql`(${CERT.createdAt}, ${CERT.id}) < (${cur.createdAt}::timestamptz, ${cur.id})`,
          );
        }
        const rows = await tx
          .select()
          .from(CERT)
          .where(and(...where))
          .orderBy(desc(CERT.createdAt), desc(CERT.id))
          .limit(limit + 1);
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        const nextCursor =
          hasMore && last
            ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null;
        return { items: page.map(toCertificateView), nextCursor };
      });
    },
  );

  app.post(
    "/api/v1/destruction-certificates/:id/approve",
    { preHandler: [destructionApprovePermission, destructionStepUp] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(DestructionCertificateIdParamsSchema, request.params);
      return withOrgContext<DbClient, { status: "approved" }>(
        deps.db,
        { organizationId, userId },
        async (tx) => {
          const existing = await tx
            .select()
            .from(CERT)
            .where(and(eq(CERT.organizationId, organizationId), eq(CERT.id, id)))
            .limit(1);
          const cert = existing[0];
          if (!cert) throw new NotFoundError("destruction_certificate", id);
          if (cert.status !== "pending") {
            throw new ChartWardenError(
              "INVALID_STATUS_TRANSITION",
              `destruction_certificate ${id} is '${cert.status}', not 'pending'`,
              409,
            );
          }
          const activeHolds = await tx
            .select({ criteria: HOLD.criteria })
            .from(HOLD)
            .where(and(eq(HOLD.organizationId, organizationId), eq(HOLD.status, "active")));
          const held = activeHolds.some((h) =>
            holdCoversDataClass(h.criteria as LegalHoldCriteria, cert.dataClass, {
              start: cert.dateRangeStart,
              end: cert.dateRangeEnd,
            }),
          );
          if (held) {
            throw new ChartWardenError(
              "HELD_RECORDS_PRESENT",
              `destruction_certificate ${id}'s data class ('${cert.dataClass}') is covered by an active legal hold`,
              409,
            );
          }
          await tx
            .update(CERT)
            .set({ status: "approved", approvedBy: userId })
            .where(eq(CERT.id, id));
          await audit(tx, auditContextFor(request), {
            eventType: "m4.destruction_certificate.approved",
            resourceKind: "destruction_certificate",
            resourceId: id,
            outcome: "success",
            severity: "warn",
            retentionClass: "compliance",
            context: { dataClass: cert.dataClass, recordCount: cert.recordCount },
          });
          return { status: "approved" as const };
        },
      );
    },
  );

  app.post(
    "/api/v1/destruction-certificates/:id/hold",
    { preHandler: [destructionApprovePermission] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(DestructionCertificateIdParamsSchema, request.params);
      const body = parse(HoldDestructionCertificateBodySchema, request.body);
      return withOrgContext<DbClient, { status: "held" }>(
        deps.db,
        { organizationId, userId },
        async (tx) => {
          const existing = await tx
            .select()
            .from(CERT)
            .where(and(eq(CERT.organizationId, organizationId), eq(CERT.id, id)))
            .limit(1);
          const cert = existing[0];
          if (!cert) throw new NotFoundError("destruction_certificate", id);
          if (cert.status === "executed" || cert.status === "held") {
            throw new ChartWardenError(
              "INVALID_STATUS_TRANSITION",
              `destruction_certificate ${id} is '${cert.status}' and cannot be deferred`,
              409,
            );
          }
          await tx
            .update(CERT)
            .set({ status: "held", refusalReason: body.reason })
            .where(eq(CERT.id, id));
          await audit(tx, auditContextFor(request), {
            eventType: "m4.destruction_certificate.held",
            resourceKind: "destruction_certificate",
            resourceId: id,
            outcome: "success",
            severity: "warn",
            retentionClass: "compliance",
            context: { dataClass: cert.dataClass, reason: body.reason },
          });
          return { status: "held" as const };
        },
      );
    },
  );
}
