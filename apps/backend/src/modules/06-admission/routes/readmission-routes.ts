// apps/backend/src/modules/06-admission/routes/readmission-routes.ts — the benefit-period plan reads behind the web
// readmission screen and the New admission screen's benefit-period field:
//
//   GET /api/v1/admissions/:id/readmission-context?sequence=&startDate=
//   GET /api/v1/patients/:patientId/benefit-period-plan?sequence=&startDate=
//
// AUTHORIZATION: `admission.read`, plus the admission / patient scope predicate every M6 read applies OR'd with
// `admission_intake_scope` (an intake role, a patient of the caller's org, no active / on-hold admission) — passed in
// by `registerAdmissionRoutes`, which owns them. The plan is a decision aid; creating the admission is still
// `POST /api/v1/admissions` (`admission.create`, same OR'd scope).
import { DegradedError, UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { IdParamsSchema, PatientIdParamsSchema, parse } from "./admission-typebox";
import type { ReadmissionService } from "./readmission-service";
import { BenefitPeriodPlanQuerySchema, BenefitPeriodPlanSchema } from "./readmission-typebox";
import { ResourceNotFoundError } from "./service";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface ReadmissionRouteDeps {
  readonly service: ReadmissionService | undefined;
  /** `admission.read` + (`admission.scope` OR `admission_intake_scope`) over the `:id` admission. */
  readonly admissionGuards: readonly PreHandler[];
  /** `admission.read` + (`caseload_or_scope` OR `admission_intake_scope`) over `:patientId`. */
  readonly patientGuards: readonly PreHandler[];
}

function orgOf(request: FastifyRequest): string {
  const organizationId = request.context?.organizationId;
  if (!organizationId || !request.context.userId) throw new UnauthorizedError();
  return organizationId;
}

function bound(service: ReadmissionService | undefined): ReadmissionService {
  if (!service) throw new DegradedError("m6.readmission", "the readmission plan is not bound");
  return service;
}

export function registerReadmissionRoutes(app: FastifyInstance, deps: ReadmissionRouteDeps): void {
  app.get(
    "/api/v1/admissions/:id/readmission-context",
    {
      preHandler: [...deps.admissionGuards],
      schema: { response: { 200: BenefitPeriodPlanSchema } },
      config: { auditRead: { resourceKind: "admission", resourceIdParam: "id" } },
    },
    async (request) => {
      const organizationId = orgOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const query = parse(BenefitPeriodPlanQuerySchema, request.query);
      const plan = await bound(deps.service).getReadmissionContext(organizationId, id, query);
      if (!plan) throw new ResourceNotFoundError(id);
      return plan;
    },
  );

  app.get(
    "/api/v1/patients/:patientId/benefit-period-plan",
    {
      preHandler: [...deps.patientGuards],
      schema: { response: { 200: BenefitPeriodPlanSchema } },
      config: { auditRead: { resourceKind: "admission", patientIdParam: "patientId", list: true } },
    },
    async (request) => {
      const organizationId = orgOf(request);
      const { patientId } = parse(PatientIdParamsSchema, request.params);
      const query = parse(BenefitPeriodPlanQuerySchema, request.query);
      return bound(deps.service).getPatientBenefitPeriodPlan(organizationId, patientId, query);
    },
  );
}
