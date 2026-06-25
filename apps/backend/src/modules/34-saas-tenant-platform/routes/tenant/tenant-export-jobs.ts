// apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/tenant-export-jobs.ts — M34 §4.1.
//
// The TENANT-scoped tenant-export routes (`withOrgContext` — the tenant's own org). The org-scoped side of
// the DSAR/tenant-export split (D9): an NDJSON-per-table + PDFs + manifest.json archive, tar.gz packaged,
// 24h presigned URL, used for migration / BAA-termination / compliance-audit / surveyor requests. The
// REQUEST route enqueues `tenant.export` (the worker construction is the SEPARATE Phase-2D follow-up — the
// route enqueues via the injected EnqueuePort in the service). Routes gate on the §4.5 keys + the §4.6
// ABAC predicate `tenant_export_org_admin_or_platform_ops`. REQUEST + DOWNLOAD carry `passkey_recent_5min`
// step-up (§6/D10); oversized bundles require a prior platform-ops `approve-oversized` (the PLATFORM-scoped
// route, separate file) before a download URL is issued. The list/download surfaces are auditRead-declared
// in the Drizzle service. Mirrors registerDocumentRoutes EXACTLY.
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf } from "./actor";
import type { TenantRouteService } from "./service";
import {
  TenantExportJobParamsSchema,
  TenantExportListQuerySchema,
  TenantExportRequest,
  parse,
} from "./tenant-typebox";

export interface TenantExportRouteDeps {
  service: TenantRouteService;
}

// §4.5 permission guards.
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const REQUEST = P("tenant_export.request");
const LIST = P("tenant_export.list_own");
const DOWNLOAD = P("tenant_export.download");

// §4.6 ABAC — org_admin (own tenant) OR platform_ops.
const ABAC_REQUEST = requireAbac(
  "tenant_export.request",
  "tenant_export_org_admin_or_platform_ops",
) as PreHandler;
const ABAC_DOWNLOAD = requireAbac(
  "tenant_export.download",
  "tenant_export_org_admin_or_platform_ops",
) as PreHandler;

// §6/D10 step-up — request + download are `passkey_recent_5min`.
const STEP_UP_REQUEST = requireStepUp("tenant_export.request") as PreHandler;
const STEP_UP_DOWNLOAD = requireStepUp("tenant_export.download") as PreHandler;

export function registerTenantExportRoutes(
  app: FastifyInstance,
  deps: TenantExportRouteDeps,
): void {
  const { service } = deps;

  // tenant-initiated full export — step-up; enqueues `tenant.export` (§4.1 / §6).
  app.post(
    "/api/v1/tenant/tenant-export-jobs",
    { preHandler: [REQUEST, ABAC_REQUEST, STEP_UP_REQUEST] },
    async (request, reply) => {
      const { organizationId, membershipId } = actorOf(request);
      const body = parse(TenantExportRequest, request.body);
      const res = await service.requestTenantExport(organizationId, membershipId, {
        requestedPurpose: body.requestedPurpose,
        justification: body.justification,
      });
      return reply.code(201).send(res);
    },
  );

  // the tenant's export queue (static path before the :id route; filtered + cursor-paginated) (§4.1).
  app.get("/api/v1/tenant/tenant-export-jobs", { preHandler: [LIST] }, async (request) => {
    const { organizationId } = actorOf(request);
    const q = parse(TenantExportListQuerySchema, request.query);
    return service.listTenantExports(organizationId, { status: q.status }, q.cursor, q.limit);
  });

  // mint a 24h presigned URL (SEC-052); records the download stamp; oversized bundles require prior
  // platform-ops approve-oversized — step-up (§4.1 / §6).
  app.get(
    "/api/v1/tenant/tenant-export-jobs/:id/download",
    { preHandler: [DOWNLOAD, ABAC_DOWNLOAD, STEP_UP_DOWNLOAD] },
    async (request) => {
      const { organizationId, membershipId } = actorOf(request);
      const { id } = parse(TenantExportJobParamsSchema, request.params);
      return service.tenantExportDownloadUrl(organizationId, id, membershipId);
    },
  );
}
