// apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/dsar-export-jobs.ts — M34 §4.1.
//
// The TENANT-scoped DSAR (Data Subject Access Request) export routes (`withOrgContext` — the tenant's own
// org). This is the HIPAA §164.524 right-of-access surface: a patient-scoped FHIR R4 Bundle + rendered
// chart PDF, 30-day fulfillment SLA. The REQUEST route resolves the patient through M5's merged_into_id
// redirect at create time (D9 lock) and enqueues `tenant.dsar_export`; the worker construction is the
// SEPARATE Phase-2D follow-up (the route enqueues via the injected EnqueuePort in the service). Routes
// gate on the §4.5 keys + the §4.6 ABAC predicate `dsar_export_patient_caseload_or_org_admin` (org_admin
// OR caseload on the target patient — M34 reaches the M5 CaseloadProvider seam OPAQUELY, no edge). FULFILL
// and DENY carry `passkey_recent_5min` step-up (§6/D10). The §164.524 read surfaces are auditRead-declared
// in the Drizzle service. Mirrors registerDocumentRoutes EXACTLY.
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import type { GuardRequest } from "@wardenx/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf } from "./actor";
import type { TenantRouteService } from "./service";
import {
  DsarDenyRequest,
  DsarExportRequest,
  DsarExtendRequest,
  DsarFulfillRequest,
  DsarJobParamsSchema,
  DsarListQuerySchema,
  parse,
} from "./tenant-typebox";

export interface DsarExportRouteDeps {
  service: TenantRouteService;
}

// §4.5 permission guards.
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const REQUEST = P("dsar_export.request");
const LIST = P("dsar_export.list_own");
const FULFILL = P("dsar_export.fulfill");
const EXTEND = P("dsar_export.extend");
const DENY = P("dsar_export.deny");
const DOWNLOAD = P("dsar_export.download");

// §4.6 ABAC — caseload-or-org-admin on the target patient. On REQUEST the patient is in the body; the
// predicate reads the resolved fact off the route AbacTarget (M34 never authorizes off the raw body —
// the request `patientId` is surfaced as the target fact, the M22 riskTarget precedent). On the per-:id
// routes the patient is the server-resolved job's patient (resolved in the Drizzle service in prod).
const requestPatientTarget = (request: GuardRequest): Record<string, unknown> => {
  const b = request.body as { patientId?: unknown } | undefined;
  return { patientId: typeof b?.patientId === "string" ? b.patientId : undefined };
};
const ABAC_REQUEST = requireAbac(
  "dsar_export.request",
  "dsar_export_patient_caseload_or_org_admin",
  { getTarget: requestPatientTarget },
) as PreHandler;
const ABAC_JOB = requireAbac(
  "dsar_export.fulfill",
  "dsar_export_patient_caseload_or_org_admin",
) as PreHandler;
const ABAC_EXTEND = requireAbac(
  "dsar_export.extend",
  "dsar_export_patient_caseload_or_org_admin",
) as PreHandler;
const ABAC_DENY = requireAbac(
  "dsar_export.deny",
  "dsar_export_patient_caseload_or_org_admin",
) as PreHandler;
const ABAC_DOWNLOAD = requireAbac(
  "dsar_export.download",
  "dsar_export_patient_caseload_or_org_admin",
) as PreHandler;

// §6/D10 step-up — fulfill + deny are `passkey_recent_5min`.
const STEP_UP_FULFILL = requireStepUp("dsar_export.fulfill") as PreHandler;
const STEP_UP_DENY = requireStepUp("dsar_export.deny") as PreHandler;

export function registerDsarExportRoutes(app: FastifyInstance, deps: DsarExportRouteDeps): void {
  const { service } = deps;

  // tenant-initiated DSAR for a patient; enqueues `tenant.dsar_export` (§4.1).
  app.post(
    "/api/v1/tenant/dsar-export-jobs",
    { preHandler: [REQUEST, ABAC_REQUEST] },
    async (request, reply) => {
      const { organizationId, membershipId } = actorOf(request);
      const body = parse(DsarExportRequest, request.body);
      const res = await service.requestDsarExport(organizationId, membershipId, {
        patientId: body.patientId,
        requestSource: body.requestSource,
        requestorIdentityVerificationEvidence: body.requestorIdentityVerificationEvidence,
      });
      return reply.code(201).send(res);
    },
  );

  // the tenant's DSAR queue (static path before the :id routes; filtered + cursor-paginated) (§4.1).
  app.get("/api/v1/tenant/dsar-export-jobs", { preHandler: [LIST] }, async (request) => {
    const { organizationId } = actorOf(request);
    const q = parse(DsarListQuerySchema, request.query);
    return service.listDsarExports(
      organizationId,
      { patientId: q.patientId, status: q.status },
      q.cursor,
      q.limit,
    );
  });

  // flip to fulfilled + trigger presigned-URL email — step-up (§4.1 / §6).
  app.post(
    "/api/v1/tenant/dsar-export-jobs/:id/fulfill",
    { preHandler: [FULFILL, ABAC_JOB, STEP_UP_FULFILL] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(DsarJobParamsSchema, request.params);
      parse(DsarFulfillRequest, request.body);
      return service.fulfillDsarExport(organizationId, id);
    },
  );

  // one-time §164.524 30-day extension (§4.1).
  app.post(
    "/api/v1/tenant/dsar-export-jobs/:id/extend",
    { preHandler: [EXTEND, ABAC_EXTEND] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(DsarJobParamsSchema, request.params);
      parse(DsarExtendRequest, request.body);
      return service.extendDsarExport(organizationId, id);
    },
  );

  // deny with a permitted-denial reason — step-up (§4.1 / §6).
  app.post(
    "/api/v1/tenant/dsar-export-jobs/:id/deny",
    { preHandler: [DENY, ABAC_DENY, STEP_UP_DENY] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(DsarJobParamsSchema, request.params);
      const body = parse(DsarDenyRequest, request.body);
      return service.denyDsarExport(organizationId, id, {
        deniedReason: body.deniedReason,
        narrative: body.narrative,
      });
    },
  );

  // mint a 24h presigned URL (SEC-052); records the download stamp; rate-limited 1 URL/user/hour (§4.1).
  app.get(
    "/api/v1/tenant/dsar-export-jobs/:id/download",
    { preHandler: [DOWNLOAD, ABAC_DOWNLOAD] },
    async (request) => {
      const { organizationId, membershipId } = actorOf(request);
      const { id } = parse(DsarJobParamsSchema, request.params);
      return service.dsarDownloadUrl(organizationId, id, membershipId);
    },
  );
}
