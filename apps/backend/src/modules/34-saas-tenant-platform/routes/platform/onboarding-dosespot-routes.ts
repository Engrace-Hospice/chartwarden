// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-dosespot-routes.ts — a platform operator registers a
// tenant's DoseSpot clinic on its behalf (`/api/v1/platform/tenants/:orgSlug/dosespot…`, tenant onboarding slice 4, ADR-0110).
//
// The guard stack is the onboarding-data one, with this lane's own key pair (`tenant_dosespot.*`, platform_ops only): the
// permission, the `tenant_lifecycle_platform_ops` predicate (the exact `platform_ops` role), a FRESH step-up on every write, the
// AI-actor block, `Idempotency-Key`, and a required `reason` that lands on the audit row beside the operator and the tenant. The
// service accepts a write only while the tenant is provisioning or onboarding (409 `TENANT_NOT_ONBOARDING`); a DEACTIVATION is the
// one write a live tenant also needs, so it is not status-gated. A first PUT omits `If-Match`; a change carries the version last
// read (428 / 412). Credentials are write-only and never returned.
import { requireStepUp } from "@chartwarden/auth";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { rejectAiActor } from "../../../../bootstrap/reject-ai-actor";
import {
  OPS,
  P,
  type PreHandler,
  operatorOf,
  optionalIfMatch,
  requireIdempotencyKey,
  splitReason,
} from "./onboarding-data-routes";
import type { OnboardingDataService } from "./onboarding-data-service";
import { OnboardingReasonSchema } from "./onboarding-data-typebox";
import {
  OnboardingDoseSpotEnrollRequest,
  OnboardingDoseSpotMembershipParamsSchema,
  OnboardingDoseSpotPutRequest,
} from "./onboarding-dosespot-typebox";
import { OrgSlugParamsSchema, parse } from "./platform-typebox";

export interface OnboardingDoseSpotRouteDeps {
  readonly service: OnboardingDataService;
  /** Per-target-tenant cap on `verify` (a vendor call per request); fail-open. Absent = unlimited. */
  readonly verifyRateLimit?: PreHandler;
}

const READ_KEY = "tenant_dosespot.read_platform";
const WRITE_KEY = "tenant_dosespot.write_platform";

const READ: readonly PreHandler[] = [P(READ_KEY), OPS(READ_KEY)];
const WRITE: readonly PreHandler[] = [
  P(WRITE_KEY),
  OPS(WRITE_KEY),
  requireStepUp(WRITE_KEY) as PreHandler,
  rejectAiActor(),
  requireIdempotencyKey,
];

export function registerOnboardingDoseSpotRoutes(
  app: FastifyInstance,
  deps: OnboardingDoseSpotRouteDeps,
): void {
  const { service } = deps;
  // The limiter runs AFTER the permission, predicate and step-up guards, so an operator who may not verify never spends the budget.
  const VERIFY: readonly PreHandler[] = deps.verifyRateLimit
    ? [...WRITE, deps.verifyRateLimit]
    : WRITE;
  const slugOf = (request: FastifyRequest): string =>
    parse(OrgSlugParamsSchema, request.params).orgSlug;

  // GET — the tenant's registration, masked (`hasSecret`, never the credential). One audited read.
  app.get(
    "/api/v1/platform/tenants/:orgSlug/dosespot",
    { preHandler: [...READ] },
    async (request) => service.getDoseSpot(operatorOf(request), slugOf(request)),
  );

  // PUT — save the registration. 201 on the first save, 200 on a version-checked change.
  app.put(
    "/api/v1/platform/tenants/:orgSlug/dosespot",
    { preHandler: [...WRITE] },
    async (request, reply) => {
      const op = operatorOf(request);
      const { reason, fields } = splitReason(parse(OnboardingDoseSpotPutRequest, request.body));
      const { created, view } = await service.putDoseSpot(
        op,
        slugOf(request),
        fields,
        reason,
        optionalIfMatch(request),
      );
      return reply.code(created ? 201 : 200).send(view);
    },
  );

  // POST verify — the connection test (a no-PHI token mint): registered -> verified.
  app.post(
    "/api/v1/platform/tenants/:orgSlug/dosespot/verify",
    { preHandler: [...VERIFY] },
    async (request) => {
      const op = operatorOf(request);
      const { reason } = splitReason(parse(OnboardingReasonSchema, request.body));
      return service.verifyDoseSpot(op, slugOf(request), reason);
    },
  );

  // POST activate — verified -> active.
  app.post(
    "/api/v1/platform/tenants/:orgSlug/dosespot/activate",
    { preHandler: [...WRITE] },
    async (request) => {
      const op = operatorOf(request);
      const { reason } = splitReason(parse(OnboardingReasonSchema, request.body));
      return service.activateDoseSpot(op, slugOf(request), reason);
    },
  );

  // POST deactivate — active -> verified. NOT gated on the tenant's onboarding status: a live tenant needs this too.
  app.post(
    "/api/v1/platform/tenants/:orgSlug/dosespot/deactivate",
    { preHandler: [...WRITE] },
    async (request) => {
      const op = operatorOf(request);
      const { reason } = splitReason(parse(OnboardingReasonSchema, request.body));
      return service.deactivateDoseSpot(op, slugOf(request), reason);
    },
  );

  // GET prescribers — the roster and whether each prescriber is linked to DoseSpot (no NPI, no DEA, no vendor id).
  app.get(
    "/api/v1/platform/tenants/:orgSlug/dosespot/prescribers",
    { preHandler: [...READ] },
    async (request) => service.listDoseSpotPrescribers(operatorOf(request), slugOf(request)),
  );

  // POST prescribers/:membershipId/enroll — register a roster prescriber with DoseSpot and record the vendor's id.
  app.post(
    "/api/v1/platform/tenants/:orgSlug/dosespot/prescribers/:membershipId/enroll",
    { preHandler: [...WRITE] },
    async (request) => {
      const op = operatorOf(request);
      const { orgSlug, membershipId } = parse(
        OnboardingDoseSpotMembershipParamsSchema,
        request.params,
      );
      const { reason, fields } = splitReason(parse(OnboardingDoseSpotEnrollRequest, request.body));
      return service.enrollDoseSpotPrescriber(op, orgSlug, membershipId, fields, reason);
    },
  );
}
