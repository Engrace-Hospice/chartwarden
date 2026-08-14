// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/tenant-export-approval.ts — M34
// (§3.7 SEC-052; GAP-097). The platform-ops RELEASE side of the oversized-tenant-export-bundle hold:
// `POST /api/v1/platform/tenant-export-jobs/:id/approve-oversized` — documented in typebox.ts since
// M34-T-phase (`ApproveOversizedExportRequest`) but never registered as a route, so a bundle that hit
// the SEC-052 oversized-hold path (GAP-094's `holdForOversizedApproval`) had no way to ever become
// downloadable. This is the second-actor co-sign: a DISTINCT platform-ops actor from whoever requested
// the export records an `approvalReason`, the service verifies the job is genuinely in the held state
// (via its `tenant_export_job_event` ledger — the newest event must be `oversized_hold`, GAP-094), then
// flips the job to `fulfilled` so the tenant-scoped download route's `status === 'fulfilled'` gate opens.
//
// Gated by the same Authorization Contract shape as the sibling support-sessions.ts co-sign routes:
// `requirePermission`/`requireAbac` on the §4.5 `tenant_export.approve_oversized` key +
// `tenant_lifecycle_platform_ops` predicate, plus `requireStepUp` (a second-actor release of a bulk PHI
// export is exactly the class of operation §6/D10 step-up exists for — mirrors `tenant_export.download`'s
// own step-up on the tenant-scoped side). Org/actor binding is server-side (`request.context`, never the
// body) — the target job's own `organizationId` (a DIFFERENT org than the platform-ops actor's own) is
// resolved from the row itself under `withPlatformContext`, not from the caller's session.
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ApproveOversizedExportRequest,
  TenantExportJobParamsSchema,
  parse,
} from "./platform-typebox";
import type { TenantPlatformRouteService } from "./service";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface TenantExportApprovalRouteDeps {
  /** The §4.1 platform-ops route service (in-memory slice; Drizzle under `withPlatformContext` in prod). */
  service: TenantPlatformRouteService;
}

function actorOf(request: FastifyRequest): { membershipId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  const membershipId = ctx.attributes?.membershipId;
  if (typeof membershipId !== "string") throw new UnauthorizedError();
  return { membershipId };
}

const jobIdOf = (request: FastifyRequest): string =>
  parse(TenantExportJobParamsSchema, request.params).id;

const APPROVE = requirePermission("tenant_export.approve_oversized") as PreHandler;
const ABAC_PLATFORM_OPS = requireAbac(
  "tenant_export.approve_oversized",
  "tenant_lifecycle_platform_ops",
) as PreHandler;
const STEP_UP_APPROVE = requireStepUp("tenant_export.approve_oversized") as PreHandler;

export function registerTenantExportApprovalRoutes(
  app: FastifyInstance,
  deps: TenantExportApprovalRouteDeps,
): void {
  const { service } = deps;

  // 1 — SEC-052 second-actor release of an oversized-hold bundle (§3.7). GAP-097.
  app.post(
    "/api/v1/platform/tenant-export-jobs/:id/approve-oversized",
    { preHandler: [APPROVE, ABAC_PLATFORM_OPS, STEP_UP_APPROVE] },
    async (request) => {
      const { membershipId } = actorOf(request);
      const body = parse(ApproveOversizedExportRequest, request.body);
      return service.approveOversizedExport(jobIdOf(request), membershipId, {
        approvalReason: body.approvalReason,
      });
    },
  );
}
