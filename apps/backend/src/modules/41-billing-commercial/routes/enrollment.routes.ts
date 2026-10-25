// apps/backend/src/modules/41-billing-commercial/routes/enrollment.routes.ts - provider entity enrollment with a payer (ADR-0100 D5).
//
//   GET   /api/v1/billing/commercial/enrollments?providerEntityId=&payerId=   (commercial_billing.read)
//   POST  /api/v1/billing/commercial/enrollments                              (commercial_billing.manage_enrollment + fresh step-up)
//   PATCH /api/v1/billing/commercial/enrollments/:id                          (same; the body names the provider entity)
// Enrollment gates every send: only status 'enrolled', in effect that day, on the clearinghouse the platform is bound to, lets one through.
import type { FastifyInstance } from "fastify";
import type { CommercialAdminService } from "../eligibility/admin-service";
import {
  ENROLLMENT_STEP_UP,
  MANAGE_ENROLLMENT,
  PROVIDER_SCOPE,
  READ,
  REJECT_AI_ACTOR,
  REQUIRE_IDEMPOTENCY_KEY,
  actorOf,
} from "./guards";
import {
  CreateEnrollmentBodySchema,
  EnrollmentListQuerySchema,
  EnrollmentListResponseSchema,
  EnrollmentResponseSchema,
  IdParamsSchema,
  PatchEnrollmentBodySchema,
  parse,
} from "./typebox";

const LIST_LIMIT = 200;
const MANAGE_KEY = "commercial_billing.manage_enrollment";

export function registerCommercialEnrollmentRoutes(
  app: FastifyInstance,
  deps: { readonly admin: CommercialAdminService },
): void {
  const { admin } = deps;

  app.get(
    "/api/v1/billing/commercial/enrollments",
    {
      preHandler: [READ, PROVIDER_SCOPE("commercial_billing.read", "query")],
      schema: { response: { 200: EnrollmentListResponseSchema } },
      config: {
        auditRead: {
          none: "Enrollment rows: provider entity, payer, clearinghouse key, status and dates. No patient, member or coverage data",
        },
      },
    },
    async (request) => {
      const q = parse(EnrollmentListQuerySchema, request.query);
      const items = await admin.listEnrollments(actorOf(request), {
        providerEntityId: q.providerEntityId,
        ...(q.payerId ? { payerId: q.payerId } : {}),
        limit: LIST_LIMIT,
      });
      return { items };
    },
  );

  app.post(
    "/api/v1/billing/commercial/enrollments",
    {
      preHandler: [
        MANAGE_ENROLLMENT,
        PROVIDER_SCOPE(MANAGE_KEY, "body"),
        ENROLLMENT_STEP_UP,
        REJECT_AI_ACTOR,
        REQUIRE_IDEMPOTENCY_KEY,
      ],
      schema: { response: { 201: EnrollmentResponseSchema } },
    },
    async (request, reply) => {
      const b = parse(CreateEnrollmentBodySchema, request.body);
      const row = await admin.createEnrollment(actorOf(request), {
        providerEntityId: b.providerEntityId,
        payerId: b.payerId,
        clearinghouseKey: b.clearinghouseKey,
        status: b.status,
        effectiveFrom: b.effectiveFrom,
        effectiveTo: b.effectiveTo ?? null,
        evidenceRef: b.evidenceRef ?? null,
      });
      return reply.code(201).send(row);
    },
  );

  app.patch(
    "/api/v1/billing/commercial/enrollments/:id",
    {
      preHandler: [
        MANAGE_ENROLLMENT,
        PROVIDER_SCOPE(MANAGE_KEY, "body"),
        ENROLLMENT_STEP_UP,
        REJECT_AI_ACTOR,
        REQUIRE_IDEMPOTENCY_KEY,
      ],
      schema: { response: { 200: EnrollmentResponseSchema } },
    },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(PatchEnrollmentBodySchema, request.body);
      return admin.patchEnrollment(actorOf(request), b.providerEntityId, id, {
        ...(b.status !== undefined ? { status: b.status } : {}),
        ...(b.effectiveTo !== undefined ? { effectiveTo: b.effectiveTo } : {}),
        ...(b.evidenceRef !== undefined ? { evidenceRef: b.evidenceRef } : {}),
      });
    },
  );
}
