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

const Params = Type.Object({ providerEntityId: Type.String({ format: "uuid" }) });
const RouteBody = Type.Object({
  providerEntityId: Type.String({ format: "uuid" }),
  payerId: Type.String({ format: "uuid" }),
  externalPayerId: Type.String({ minLength: 1, maxLength: 40, pattern: "^[A-Za-z0-9._-]+$" }),
  effectiveFrom: Type.String({ format: "date" }),
  effectiveTo: Type.Optional(Type.Union([Type.String({ format: "date" }), Type.Null()])),
});
const EnrollmentBody = Type.Object({
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
const CloseRouteBody = Type.Object({
  providerEntityId: Type.String({ format: "uuid" }),
  routeId: Type.String({ format: "uuid" }),
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
      config: {
        auditRead: { none: "Claim.MD Medicare routing and enrollment readiness; no patient data" },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { providerEntityId } = parse(Params, request.params);
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
    async (request) => service.createRoute(writeActorOf(request), parse(RouteBody, request.body)),
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
      service.closeRoute(writeActorOf(request), parse(CloseRouteBody, request.body)),
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
      service.recordEnrollment(writeActorOf(request), parse(EnrollmentBody, request.body)),
  );
}
