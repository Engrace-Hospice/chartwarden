// apps/backend/src/modules/41-billing-commercial/routes/enrollment-report.routes.ts - ADVISORY clearinghouse enrollment reports
// (migration 1323, ADR-0100 note).
//
//   GET  /api/v1/billing/commercial/enrollment-reports?providerEntityId=&state=   (commercial_billing.read + provider scope)
//   POST /api/v1/billing/commercial/enrollment-reports/:id/resolve                (commercial_billing.manage_enrollment + provider scope)
// Resolving changes no gate (it only closes the notice), so it needs no step-up and is idempotent without an Idempotency-Key.
// Applying a report's status goes through the enrollments POST/PATCH, unchanged, with their step-up and Idempotency-Key.
import type { FastifyInstance } from "fastify";
import type { EnrollmentReportService } from "../services/enrollment-report-service";
import { MANAGE_ENROLLMENT, PROVIDER_SCOPE, READ, REJECT_AI_ACTOR, actorOf } from "./guards";
import {
  EnrollmentReportListQuerySchema,
  EnrollmentReportListResponseSchema,
  EnrollmentReportResponseSchema,
  IdParamsSchema,
  ResolveEnrollmentReportBodySchema,
  parse,
} from "./typebox";

const LIST_LIMIT = 200;

export function registerCommercialEnrollmentReportRoutes(
  app: FastifyInstance,
  deps: { readonly reports: EnrollmentReportService },
): void {
  const { reports } = deps;

  app.get(
    "/api/v1/billing/commercial/enrollment-reports",
    {
      preHandler: [READ, PROVIDER_SCOPE("commercial_billing.read", "query")],
      schema: { response: { 200: EnrollmentReportListResponseSchema } },
      config: {
        auditRead: {
          none: "Enrollment reports: provider entity, payer, clearinghouse codes and one vendor status word. No patient data",
        },
      },
    },
    async (request) => {
      const q = parse(EnrollmentReportListQuerySchema, request.query);
      const items = await reports.list(actorOf(request), {
        providerEntityId: q.providerEntityId,
        ...(q.state ? { state: q.state } : {}),
        limit: LIST_LIMIT,
      });
      return { items };
    },
  );

  app.post(
    "/api/v1/billing/commercial/enrollment-reports/:id/resolve",
    {
      preHandler: [
        MANAGE_ENROLLMENT,
        PROVIDER_SCOPE("commercial_billing.manage_enrollment", "body"),
        REJECT_AI_ACTOR,
      ],
      schema: { response: { 200: EnrollmentReportResponseSchema } },
    },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(ResolveEnrollmentReportBodySchema, request.body);
      return reports.resolve(actorOf(request), {
        providerEntityId: b.providerEntityId,
        id,
        resolution: b.resolution,
      });
    },
  );
}
