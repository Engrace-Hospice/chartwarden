// apps/backend/src/modules/30-quality/routes/cahps.routes.ts — M30 (§4.1 R-10..R-17).
//
// The CAHPS Hospice Survey surface: read the org's active vendor binding (R-10) + bind/rotate a vendor
// (R-11, immutable history); list the decedents in the current sample window (R-12, PHI) + exclude a
// decedent as ineligible (R-13, PHI); generate a vendor export job (R-14 → 202, PHI) + read its status +
// signed download URL (R-15); ingest the vendor adapter's aggregated results (R-16, the `quality.cahps.
// system` mTLS service route) + read result summaries by period (R-17, aggregate).
//
// PHI: R-12/R-13/R-14 are `org+patient` RLS-scoped (the decedent sample carries `patient_id`), so they
// additionally pass {@link requirePatientScope} — the patient-row narrowing itself is the M3 patient-level
// RLS predicate the P2c Drizzle adapter runs each read/mutation under inside ONE `withOrgContext(org, …)`
// transaction. R-10/R-15/R-16/R-17 are org-scoped (no patient join), so `requirePermission` (org presence)
// + the org RLS predicate is the full gate. The mutating routes in the §4.1.1 table — R-11, R-13, R-14,
// R-16 — carry `Idempotency-Key`; the GET reads are exempt. Org/actor binding is ALWAYS server-side
// (request.context, never the body). Mirrors the M33 routes/exports.routes.ts shape.
import { requirePermission } from "@wardenx/auth";
import { NotFoundError, UnauthorizedError, WardenXError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { type M30ReadActor, type PreHandler, actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import {
  BindCahpsVendorBodySchema,
  CahpsDecedentListQuerySchema,
  CahpsResultListQuerySchema,
  CreateCahpsExportBodySchema,
  ExcludeCahpsDecedentBodySchema,
  ExportIdParamsSchema,
  IngestCahpsResultsBodySchema,
  SampleIdParamsSchema,
  parse,
} from "./quality-typebox";
import type { M30ReadRouteService } from "./read-service";
import type { M30WriteRouteService } from "./write-service";

/** GAP-087 — the decrypted artifact of a completed export, or null while it is not completed / unknown. */
export type CahpsExportFileReader = (
  actor: M30ReadActor,
  exportId: string,
) => Promise<{ filename: string; mimeType: string; bytes: Buffer } | null>;

export interface CahpsRouteDeps {
  readonly readService: M30ReadRouteService;
  readonly writeService: M30WriteRouteService;
  /** The sealed-file reader behind R-15's `downloadUrl`; unbound ⇒ the file route refuses 503. */
  readonly exportFile?: CahpsExportFileReader;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const CAHPS_READ = P("quality.cahps.read");
const CAHPS_ADMIN = P("quality.cahps.admin");
const CAHPS_SYSTEM = P("quality.cahps.system");
const IDEMPOTENT = requireIdempotencyKey();

/**
 * §4.1 PHI guard — the R-12/R-13/R-14 decedent routes are `org+patient` RLS-scoped. This fail-closed
 * presence gate refuses a request that carries no server-assembled session (org+user); the patient-row
 * narrowing itself is the M3 patient-level RLS predicate the P2c read/mutation runs under inside
 * `withOrgContext(org, …)`. The dedicated M3 platform `requirePatientScope()` binds at the composition
 * root (Integrate phase) — until then this keeps the PHI routes unreachable without a bound session.
 */
const requirePatientScope = (): PreHandler => async (request) => {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
};
const PATIENT_SCOPE = requirePatientScope();

/** Register the §4.1 CAHPS routes (R-10..R-17). */
export function registerCahpsRoutes(app: FastifyInstance, deps: CahpsRouteDeps): void {
  const { readService, writeService, exportFile } = deps;

  // R-10 — the org's active vendor binding (immutable-history current row; null when none). §4.1.
  app.get(
    "/api/v1/quality/cahps/vendor",
    {
      preHandler: [CAHPS_READ],
      config: {
        auditRead: { none: "CAHPS vendor assignment + BAA status — tenant configuration, no PHI" },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      return readService.getCahpsVendor(actor);
    },
  );

  // R-11 — bind / rotate the CAHPS vendor (appends a new immutable-history row). Idempotent. §4.1.
  app.post(
    "/api/v1/quality/cahps/vendor",
    { preHandler: [CAHPS_ADMIN, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(BindCahpsVendorBodySchema, request.body);
      const res = await writeService.bindCahpsVendor(actor, body);
      return reply.code(201).send(res);
    },
  );

  // R-12 — list the decedents in the current sample window (PHI; cursor-paginated). §4.1.
  app.get(
    "/api/v1/quality/cahps/decedents",
    {
      preHandler: [CAHPS_READ, PATIENT_SCOPE],
      config: { auditRead: { resourceKind: "cahps_decedent", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(CahpsDecedentListQuerySchema, request.query);
      return readService.listCahpsDecedents(
        actor,
        {
          samplePeriodStart: q.samplePeriodStart,
          samplePeriodEnd: q.samplePeriodEnd,
          eligibleOnly: q.eligibleOnly,
        },
        q.cursor,
        q.limit,
      );
    },
  );

  // R-13 — exclude a decedent as ineligible (reason required; PHI). Idempotent. §4.1.
  app.post(
    "/api/v1/quality/cahps/decedents/:sampleId/exclude",
    { preHandler: [CAHPS_ADMIN, PATIENT_SCOPE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { sampleId } = parse(SampleIdParamsSchema, request.params);
      const body = parse(ExcludeCahpsDecedentBodySchema, request.body);
      const res = await writeService.excludeCahpsDecedent(actor, sampleId, body);
      return reply.code(200).send(res);
    },
  );

  // R-14 — generate a vendor export job over the sample window (PHI → 202 accepted). Idempotent. §4.1.
  app.post(
    "/api/v1/quality/cahps/export",
    { preHandler: [CAHPS_ADMIN, PATIENT_SCOPE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(CreateCahpsExportBodySchema, request.body);
      const res = await writeService.createCahpsExport(actor, body);
      return reply.code(202).send(res);
    },
  );

  // R-15 — read an export job's status + (once complete) its short-lived signed download URL. §4.1.
  app.get(
    "/api/v1/quality/cahps/export/:exportId",
    {
      preHandler: [CAHPS_ADMIN],
      config: { auditRead: { resourceKind: "cahps_export", resourceIdParam: "exportId" } },
    },
    async (request) => {
      const actor = actorOf(request);
      const { exportId } = parse(ExportIdParamsSchema, request.params);
      return readService.getCahpsExport(actor, exportId);
    },
  );

  // R-15b — the completed export's file (the URL R-15 returns). The artifact is stored sealed under the tenant DEK
  // and decrypted only here, for an authorised admin (it carries caregiver names / phones / emails: PHI).
  app.get(
    "/api/v1/quality/cahps/export/:exportId/file",
    {
      preHandler: [CAHPS_ADMIN, PATIENT_SCOPE],
      config: { auditRead: { resourceKind: "cahps_export_file", resourceIdParam: "exportId" } },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { exportId } = parse(ExportIdParamsSchema, request.params);
      if (!exportFile) {
        throw new WardenXError(
          "CAHPS_EXPORT_FILE_UNAVAILABLE",
          "CAHPS export downloads are not available: no tenant key cipher is bound",
          503,
        );
      }
      const file = await exportFile(actor, exportId);
      if (!file) throw new NotFoundError("cahps export file");
      const safeName = file.filename.replace(/[^A-Za-z0-9._-]/g, "_");
      return reply
        .header("content-type", file.mimeType)
        .header("content-disposition", `attachment; filename="${safeName}"`)
        .header("cache-control", "no-store")
        .send(file.bytes);
    },
  );

  // R-16 — ingest the vendor adapter's aggregated results (mTLS service route; `quality.cahps.system`).
  // Aggregate-only (min-cell suppressed on ingest). Idempotent on `payloadHash` (§4.1.1). §4.1.
  app.post(
    "/api/v1/quality/cahps/results/ingest",
    { preHandler: [CAHPS_SYSTEM, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(IngestCahpsResultsBodySchema, request.body);
      const res = await writeService.ingestCahpsResults(actor, body);
      return reply.code(200).send(res);
    },
  );

  // R-17 — result summaries by reporting period (aggregate; cursor-paginated). §4.1.
  app.get(
    "/api/v1/quality/cahps/results",
    {
      preHandler: [CAHPS_READ],
      config: {
        auditRead: {
          none: "aggregate CAHPS top-box scores by period — no decedent or caregiver identity",
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(CahpsResultListQuerySchema, request.query);
      return readService.listCahpsResults(
        actor,
        {
          reportingPeriodStart: q.reportingPeriodStart,
          reportingPeriodEnd: q.reportingPeriodEnd,
          measureId: q.measureId,
        },
        q.cursor,
        q.limit,
      );
    },
  );
}
