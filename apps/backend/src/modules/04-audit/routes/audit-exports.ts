// apps/backend/src/modules/04-audit/routes/audit-exports.ts — GAP-003 the §4.3/§4.4 compliance
// export surface (M04-F04 / SEC-052).
//
// `audit_export` is M4-OWNED (architecture/module-manifest.ts) so this file talks to the table
// directly over Drizzle + `withOrgContext`. What this file does NOT do: actually RENDER and store
// the artifact. `renderAuditExport` (@chartwarden/audit `export/index.ts`) is pure and already wired
// into `runBuildExport` (`jobs/processors.ts`), but that processor needs a `BuildExportPorts.store`
// object-storage adapter, and no MinIO/S3 client exists anywhere M4 can reach — M22's hand-rolled
// signer (`apps/backend/src/modules/22-documents/seams/s3-object-store.ts`) is module-local (M4's
// `dependsOn` is [1,2,3], no edge to M22) and there is no shared storage package to promote it into
// without a materially larger change than this gap calls for. So this route does exactly what its
// own spec response promises (`202 -> {exportId, status:'pending'}`) and stops there: the export
// row is real and persisted, the request is real and audited, and `GET .../:id` honestly reports
// `status:'pending'` forever until a future task wires the build-export worker — it never fabricates
// a `downloadUrl` or a `ready` status the artifact doesn't back.
//
// The M04-F04/SEC-052 bulk-export controls this route DOES enforce for real, because they need no
// extra infra: `justification` is a required, min-length TypeBox field (enforced below), and the
// "1 export/hour/user" rate limit is a live COUNT against the very table this route writes to — no
// Redis, no estimate.
import { type AuditContext, audit } from "@chartwarden/audit";
import { requirePermission, requireStepUp } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { NotFoundError, RateLimitedError, UnauthorizedError } from "@chartwarden/types";
import { and, eq, gte } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AuditExportIdParamsSchema,
  type CreateAuditExportBody,
  CreateAuditExportBodySchema,
  parse,
} from "./audit-typebox";

/** A @chartwarden/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The injection surface for the audit-exports routes. */
export interface AuditExportsRouteDeps {
  readonly db: DbClient;
  /** Injectable for tests; defaults to the wall clock. */
  readonly now?: () => Date;
}

const EXPORT = schema.auditExports;

/** The artifact TTL from request time (§4.3 "expiresAt stays +7 d"). */
const EXPORT_TTL_DAYS = 7;
/** M04-F04 / SEC-052 — one export request per user per rolling hour. */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

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

const exportPermission = requirePermission("audit.export") as PreHandler;
// §4.3 "step-up required" (SEC-052 bulk-export controls) — a SERVER fact over M3's
// `step_up_recent` predicate, the same posture every other step-up-gated route in this codebase
// takes (see legal-holds.ts / destruction-certificates.ts for the same note).
const exportStepUp = requireStepUp("audit.export") as PreHandler;

function toExportView(row: typeof EXPORT.$inferSelect) {
  // `downloadUrl` is always omitted: it is a presigned MinIO URL over `fileRef` (§4.3 "only
  // present when status='ready'"), and no code path in this file ever sets `status` to anything
  // but `pending` — see the file header for why. Omitting is the honest choice; nothing here can
  // legitimately produce a `ready` row yet.
  return {
    id: row.id,
    status: row.status,
    format: row.format,
    recordCount: row.recordCount,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * Mount the §4.2 audit-export routes: request + retrieve. Behind `audit.export` + a fresh step-up
 * (M04-F04 / SEC-052). See the file header for what `POST` does and deliberately does not do.
 */
export function registerAuditExportsRoutes(
  app: FastifyInstance,
  deps: AuditExportsRouteDeps,
): void {
  const now = deps.now ?? (() => new Date());

  app.post(
    "/api/v1/audit/exports",
    { preHandler: [exportPermission, exportStepUp] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(CreateAuditExportBodySchema, request.body) as CreateAuditExportBody;
      const result = await withOrgContext<DbClient, { exportId: string }>(
        deps.db,
        { organizationId, userId },
        async (tx) => {
          // M04-F04 / SEC-052 — 1 export/hour/user, a real COUNT against this org's own rows.
          const windowStart = new Date(now().getTime() - RATE_LIMIT_WINDOW_MS);
          const recent = await tx
            .select({ id: EXPORT.id })
            .from(EXPORT)
            .where(
              and(
                eq(EXPORT.organizationId, organizationId),
                eq(EXPORT.requestedBy, userId),
                gte(EXPORT.requestedAt, windowStart),
              ),
            )
            .limit(1);
          if (recent.length > 0) {
            throw new RateLimitedError(
              "one audit export per user per hour (M04-F04 / SEC-052); try again later",
            );
          }
          const expiresAt = new Date(now().getTime() + EXPORT_TTL_DAYS * 24 * 60 * 60 * 1000);
          const [row] = await tx
            .insert(EXPORT)
            .values({
              organizationId,
              requestedBy: userId,
              scope: body.scope,
              format: body.format,
              watermarked: body.watermarked ?? true,
              status: "pending",
              expiresAt,
            })
            .returning();
          if (!row) throw new Error("audit_export insert returned no row");
          await audit(tx, auditContextFor(request), {
            eventType: "m4.audit_export.requested",
            resourceKind: "audit_export",
            resourceId: row.id,
            outcome: "success",
            severity: "warn",
            retentionClass: "compliance",
            context: {
              format: body.format,
              justification: body.justification,
              scope: body.scope,
            },
          });
          return { exportId: row.id };
        },
      );
      reply.code(202);
      return { exportId: result.exportId, status: "pending" as const };
    },
  );

  app.get("/api/v1/audit/exports/:id", { preHandler: [exportPermission] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(AuditExportIdParamsSchema, request.params);
    return withOrgContext(deps.db, { organizationId, userId }, async (tx) => {
      const rows = await tx
        .select()
        .from(EXPORT)
        .where(and(eq(EXPORT.organizationId, organizationId), eq(EXPORT.id, id)))
        .limit(1);
      const row = rows[0];
      if (!row) throw new NotFoundError("audit_export", id);
      return toExportView(row);
    });
  });
}
