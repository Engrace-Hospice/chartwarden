import {
  actorOf,
  parse,
  rejectAiActor,
  requireIdempotencyKey,
} from "@chartwarden/shared/route-kit";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { writeActorOf } from "./actor";
import type { ClaimMdMedicareRoutingService } from "./claimmd-medicare-routing-service";
import {
  P,
  PROVIDER_SCOPE,
  STEP_UP,
  targetProviderFromBody,
  targetProviderFromParams,
} from "./guards";

export const ClaimMdMedicareRoutingParamsSchema = Type.Object({
  providerEntityId: Type.String({ format: "uuid" }),
});
const nullableDate = Type.Union([Type.String({ format: "date" }), Type.Null()]);
const nullableDateTime = Type.Union([Type.String({ format: "date-time" }), Type.Null()]);
export const ClaimMdMedicareRoutingResponseSchema = Type.Object({
  routes: Type.Array(
    Type.Object({
      id: Type.String({ format: "uuid" }),
      organizationId: Type.String({ format: "uuid" }),
      providerEntityId: Type.String({ format: "uuid" }),
      payerId: Type.String({ format: "uuid" }),
      macJurisdiction: Type.String(),
      accountReference: Type.String(),
      usage: Type.String(),
      externalPayerId: Type.String(),
      transactionType: Type.String(),
      effectiveFrom: Type.String({ format: "date" }),
      effectiveTo: nullableDate,
      status: Type.String(),
      provenance: Type.String(),
      createdByMembershipId: Type.String({ format: "uuid" }),
      createdAt: Type.String({ format: "date-time" }),
      updatedAt: Type.String({ format: "date-time" }),
    }),
  ),
  enrollments: Type.Array(
    Type.Object({
      id: Type.String({ format: "uuid" }),
      organizationId: Type.String({ format: "uuid" }),
      providerEntityId: Type.String({ format: "uuid" }),
      payerId: Type.String({ format: "uuid" }),
      accountReference: Type.String(),
      usage: Type.String(),
      transactionType: Type.String(),
      status: Type.String(),
      verificationSource: Type.Union([Type.String(), Type.Null()]),
      verificationRef: Type.Union([Type.String(), Type.Null()]),
      verifiedByMembershipId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
      verifiedAt: nullableDateTime,
      effectiveFrom: Type.String({ format: "date" }),
      effectiveTo: nullableDate,
      createdAt: Type.String({ format: "date-time" }),
      updatedAt: Type.String({ format: "date-time" }),
    }),
  ),
});
export const ClaimMdMedicareRouteBodySchema = Type.Object({
  providerEntityId: Type.String({ format: "uuid" }),
  payerId: Type.String({ format: "uuid" }),
  externalPayerId: Type.String({ minLength: 1, maxLength: 40, pattern: "^[A-Za-z0-9._-]+$" }),
  effectiveFrom: Type.String({ format: "date" }),
  effectiveTo: Type.Optional(Type.Union([Type.String({ format: "date" }), Type.Null()])),
});
export const ClaimMdMedicareEnrollmentBodySchema = Type.Object({
  providerEntityId: Type.String({ format: "uuid" }),
  payerId: Type.String({ format: "uuid" }),
  status: Type.Union(
    ["pending", "verified", "not_required", "rejected", "suspended", "expired"].map((s) =>
      Type.Literal(s),
    ),
  ),
  effectiveFrom: Type.String({ format: "date" }),
  effectiveTo: Type.Optional(Type.Union([Type.String({ format: "date" }), Type.Null()])),
  verificationSource: Type.Optional(
    Type.Union(
      ["vendor_portal", "vendor_written_confirmation", "documented_policy"].map((s) =>
        Type.Literal(s),
      ),
    ),
  ),
  verificationRef: Type.Optional(
    Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:/#-]+$" }),
  ),
});
export const CloseClaimMdMedicareRouteBodySchema = Type.Object({
  providerEntityId: Type.String({ format: "uuid" }),
  routeId: Type.String({ format: "uuid" }),
  effectiveTo: Type.String({ format: "date" }),
});
const NullableString = Type.Union([Type.String(), Type.Null()]);
const ClaimMdRouteView = Type.Object({
  id: Type.String({ format: "uuid" }),
  organizationId: Type.String({ format: "uuid" }),
  providerEntityId: Type.String({ format: "uuid" }),
  payerId: Type.String({ format: "uuid" }),
  macJurisdiction: Type.String(),
  accountReference: Type.String(),
  usage: Type.String(),
  externalPayerId: Type.String(),
  transactionType: Type.String(),
  effectiveFrom: Type.String({ format: "date" }),
  effectiveTo: NullableString,
  status: Type.String(),
  provenance: Type.String(),
  createdByMembershipId: Type.String({ format: "uuid" }),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
});
const ClaimMdEnrollmentView = Type.Object({
  id: Type.String({ format: "uuid" }),
  organizationId: Type.String({ format: "uuid" }),
  providerEntityId: Type.String({ format: "uuid" }),
  payerId: Type.String({ format: "uuid" }),
  accountReference: Type.String(),
  usage: Type.String(),
  transactionType: Type.String(),
  status: Type.String(),
  verificationSource: NullableString,
  verificationRef: NullableString,
  verifiedByMembershipId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  verifiedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  effectiveFrom: Type.String({ format: "date" }),
  effectiveTo: NullableString,
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
});
export const ClaimMdMedicareRoutingResponse = Type.Object({
  routes: Type.Array(ClaimMdRouteView),
  enrollments: Type.Array(ClaimMdEnrollmentView),
});
export const ClaimMdMedicareIdResponse = Type.Object({ id: Type.String({ format: "uuid" }) });
export const ClaimMdMedicareCloseRouteResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  effectiveTo: Type.String({ format: "date" }),
});

export function registerClaimMdMedicareRoutingRoutes(
  app: FastifyInstance,
  service: ClaimMdMedicareRoutingService,
): void {
  const read = P("billing.mac_credential.read");
  const write = P("billing.mac_credential.admin");
  app.get(
    "/api/v1/billing/claimmd-medicare-routing/:providerEntityId",
    {
      preHandler: [read, PROVIDER_SCOPE("billing.mac_credential.read", targetProviderFromParams)],
      schema: {
        params: ClaimMdMedicareRoutingParamsSchema,
        response: { 200: ClaimMdMedicareRoutingResponseSchema },
      },
      config: {
        auditRead: { none: "Claim.MD Medicare routing and enrollment readiness; no patient data" },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { providerEntityId } = parse(ClaimMdMedicareRoutingParamsSchema, request.params);
      return service.list(actor, providerEntityId);
    },
  );
  app.post(
    "/api/v1/billing/claimmd-medicare-routing/routes",
    {
      preHandler: [
        write,
        PROVIDER_SCOPE("billing.mac_credential.admin", targetProviderFromBody),
        STEP_UP("billing.mac_credential.admin"),
        rejectAiActor(),
        requireIdempotencyKey(),
      ],
    },
    async (request) =>
      service.createRoute(
        writeActorOf(request),
        parse(ClaimMdMedicareRouteBodySchema, request.body),
      ),
  );
  app.post(
    "/api/v1/billing/claimmd-medicare-routing/routes/close",
    {
      preHandler: [
        write,
        PROVIDER_SCOPE("billing.mac_credential.admin", targetProviderFromBody),
        STEP_UP("billing.mac_credential.admin"),
        rejectAiActor(),
        requireIdempotencyKey(),
      ],
    },
    async (request) =>
      service.closeRoute(
        writeActorOf(request),
        parse(CloseClaimMdMedicareRouteBodySchema, request.body),
      ),
  );
  app.post(
    "/api/v1/billing/claimmd-medicare-routing/enrollments",
    {
      preHandler: [
        write,
        PROVIDER_SCOPE("billing.mac_credential.admin", targetProviderFromBody),
        STEP_UP("billing.mac_credential.admin"),
        rejectAiActor(),
        requireIdempotencyKey(),
      ],
    },
    async (request) =>
      service.recordEnrollment(
        writeActorOf(request),
        parse(ClaimMdMedicareEnrollmentBodySchema, request.body),
      ),
  );
}
