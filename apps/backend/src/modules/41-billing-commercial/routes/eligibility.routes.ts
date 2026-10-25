// apps/backend/src/modules/41-billing-commercial/routes/eligibility.routes.ts - commercial eligibility (270/271), issue #724.
//
//   POST  /api/v1/billing/commercial/eligibility/check            run a check through the platform clearinghouse (200; commercial_billing.write)
//   GET   /api/v1/billing/commercial/eligibility?providerEntityId=&patientId=   a patient's checks, newest first (commercial_billing.read)
//   GET   /api/v1/billing/commercial/eligibility/latest?providerEntityId=&patientId=&planId=   newest check + the plan's freshness verdict
//   PATCH /api/v1/billing/commercial/payer-plans/:id/eligibility-policy      warn/block + max age for a plan (manage_enrollment + fresh step-up)
//
// Mutating routes require an Idempotency-Key (the key is also the check row's uniqueness key), reject AI actors, and are scoped to the
// provider entity (and, for a check, the patient). The body never carries a member id: it is resolved from M5's coverage server side.
import type { FastifyInstance } from "fastify";
import type { CommercialAdminService } from "../eligibility/admin-service";
import type { EligibilityService } from "../eligibility/service";
import {
  ENROLLMENT_STEP_UP,
  MANAGE_ENROLLMENT,
  PATIENT_SCOPE,
  PROVIDER_SCOPE,
  READ,
  REJECT_AI_ACTOR,
  REQUIRE_IDEMPOTENCY_KEY,
  WRITE,
  actorOf,
  idempotencyKeyOf,
} from "./guards";
import {
  CheckEligibilityBodySchema,
  EligibilityCheckResponseSchema,
  EligibilityListResponseSchema,
  EligibilityPolicyBodySchema,
  EligibilityPolicyResponseSchema,
  IdParamsSchema,
  LatestEligibilityResponseSchema,
  LatestQuerySchema,
  PatientPlanQuerySchema,
  parse,
} from "./typebox";

export interface EligibilityRouteDeps {
  readonly eligibility: EligibilityService;
  readonly admin: CommercialAdminService;
}

const AUDIT_READ = {
  resourceKind: "commercial_eligibility_check",
  patientIdQueryParam: "patientId",
} as const;

export function registerCommercialEligibilityRoutes(
  app: FastifyInstance,
  deps: EligibilityRouteDeps,
): void {
  const { eligibility, admin } = deps;

  app.post(
    "/api/v1/billing/commercial/eligibility/check",
    {
      preHandler: [
        WRITE,
        PROVIDER_SCOPE("commercial_billing.write"),
        PATIENT_SCOPE("commercial_billing.write"),
        REJECT_AI_ACTOR,
        REQUIRE_IDEMPOTENCY_KEY,
      ],
      schema: { response: { 200: EligibilityCheckResponseSchema } },
    },
    async (request, reply) => {
      const body = parse(CheckEligibilityBodySchema, request.body);
      const view = await eligibility.check(actorOf(request), {
        providerEntityId: body.providerEntityId,
        locationId: body.locationId ?? null,
        patientId: body.patientId,
        planId: body.planId,
        serviceDate: body.serviceDate,
        idempotencyKey: idempotencyKeyOf(request),
      });
      return reply.header("Cache-Control", "no-store").send(view);
    },
  );

  app.get(
    "/api/v1/billing/commercial/eligibility",
    {
      preHandler: [
        READ,
        PROVIDER_SCOPE("commercial_billing.read"),
        PATIENT_SCOPE("commercial_billing.read"),
      ],
      schema: { response: { 200: EligibilityListResponseSchema } },
      config: { auditRead: AUDIT_READ },
    },
    async (request, reply) => {
      const q = parse(PatientPlanQuerySchema, request.query);
      const rows = await eligibility.list(actorOf(request), {
        providerEntityId: q.providerEntityId,
        patientId: q.patientId,
        ...(q.planId ? { planId: q.planId } : {}),
      });
      return reply.header("Cache-Control", "no-store").send({
        items: rows.map((r) => ({
          id: r.id,
          providerEntityId: r.providerEntityId,
          patientId: r.patientId,
          planId: r.planId,
          clearinghouseKey: r.clearinghouseKey,
          serviceDate: r.serviceDate,
          outcome: r.outcome,
          asOfDate: r.asOfDate,
          requestId: r.requestId,
          checkedAt: r.checkedAt,
        })),
      });
    },
  );

  app.get(
    "/api/v1/billing/commercial/eligibility/latest",
    {
      preHandler: [
        READ,
        PROVIDER_SCOPE("commercial_billing.read"),
        PATIENT_SCOPE("commercial_billing.read"),
      ],
      schema: { response: { 200: LatestEligibilityResponseSchema } },
      config: { auditRead: AUDIT_READ },
    },
    async (request, reply) => {
      const q = parse(LatestQuerySchema, request.query);
      return reply
        .header("Cache-Control", "no-store")
        .send(await eligibility.latest(actorOf(request), q));
    },
  );

  app.patch(
    "/api/v1/billing/commercial/payer-plans/:id/eligibility-policy",
    {
      // Relaxing the policy weakens a billing control, so it takes the enrollment-admin permission and a fresh step-up.
      preHandler: [MANAGE_ENROLLMENT, ENROLLMENT_STEP_UP, REJECT_AI_ACTOR, REQUIRE_IDEMPOTENCY_KEY],
      schema: { response: { 200: EligibilityPolicyResponseSchema } },
    },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      const body = parse(EligibilityPolicyBodySchema, request.body);
      return admin.setEligibilityPolicy(actorOf(request), id, body.policy, body.maxAgeDays);
    },
  );
}
