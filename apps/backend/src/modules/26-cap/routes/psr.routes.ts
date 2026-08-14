// apps/backend/src/modules/26-cap/routes/psr.routes.ts — M26 (§4.1) the PS&R reconciliation surface: CSV
// import, import status, the per-line variance queue, and variance resolution. Reads gate on cap.psr.read;
// import on cap.psr.import; resolve on cap.psr.reconcile. Org/actor binding is server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { P } from "./guards";
import {
  LineIdParams,
  PeriodIdParams,
  PsrImportRequest,
  ResolveVarianceRequest,
  parse,
  validateParams,
} from "./m26-typebox";
import type { M26ReadService } from "./read-service";
import type { M26WriteService } from "./write-service";

export interface PsrRouteDeps {
  readonly readService: M26ReadService;
  readonly writeService: M26WriteService;
}

const PSR_READ = P("cap.psr.read");
const PSR_IMPORT = P("cap.psr.import");
const PSR_RECONCILE = P("cap.psr.reconcile");
const IDEMPOTENT = requireIdempotencyKey();
const pParam = (request: { params: unknown }, key: string): string =>
  (request.params as Record<string, string>)[key] ?? "";

export function registerPsrRoutes(app: FastifyInstance, deps: PsrRouteDeps): void {
  const { readService, writeService } = deps;

  app.post(
    "/api/v1/cap/periods/:periodId/psr-imports",
    { preHandler: [validateParams(PeriodIdParams), PSR_IMPORT, IDEMPOTENT] },
    async (request, reply) => {
      const { periodId } = parse(PeriodIdParams, request.params);
      const body = parse(PsrImportRequest, request.body);
      const res = await writeService.importPsr(
        writeActorOf(request),
        pParam(request, "periodId"),
        body,
      );
      return reply.code(202).send({ ...res, status: "queued" });
    },
  );

  app.get(
    "/api/v1/cap/psr-imports/:importId",
    {
      preHandler: [PSR_READ],
      config: {
        auditRead: { none: "PS&R import status + MAC-reported period totals; no patient is named" },
      },
    },
    async (request, reply) =>
      reply.send(await readService.getPsrImport(actorOf(request), pParam(request, "importId"))),
  );

  // `PsrVarianceView.patientId` is nullable — a beneficiary-scope variance line names the patient
  // whose paid amount disagrees with the MAC's, so the queue is a §3.4 list read over PHI.
  app.get(
    "/api/v1/cap/psr-imports/:importId/reconciliation",
    {
      preHandler: [PSR_READ],
      config: { auditRead: { resourceKind: "cap_psr_variance", list: true } },
    },
    async (request, reply) =>
      reply.send(
        await readService.listPsrReconciliation(actorOf(request), pParam(request, "importId")),
      ),
  );

  app.patch(
    "/api/v1/cap/psr-imports/:importId/reconciliation/:lineId/resolve",
    { preHandler: [validateParams(LineIdParams), PSR_RECONCILE, IDEMPOTENT] },
    async (request, reply) => {
      const { lineId } = parse(LineIdParams, request.params);
      const body = parse(ResolveVarianceRequest, request.body);
      await writeService.resolveVariance(writeActorOf(request), lineId, body);
      return reply.code(204).send();
    },
  );
}
