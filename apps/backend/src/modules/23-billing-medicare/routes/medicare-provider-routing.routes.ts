import {
  actorOf,
  parse,
  rejectAiActor,
  requireIdempotencyKey,
} from "@chartwarden/shared/route-kit";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { writeActorOf } from "./actor";
import {
  P,
  PROVIDER_SCOPE,
  STEP_UP,
  targetProviderFromBody,
  targetProviderFromParams,
} from "./guards";
import type { MedicareProviderRoutingService } from "./medicare-provider-routing-service";

const Params = Type.Object({ providerEntityId: Type.String({ format: "uuid" }) });
const Body = Type.Object({
  providerEntityId: Type.String({ format: "uuid" }),
  macJurisdiction: Type.Union(
    ["ngs_j6", "ngs_jk", "cgs_j15", "palmetto_jj", "palmetto_jm", "noridian_jf", "noridian_je"].map(
      (v) => Type.Literal(v),
    ),
  ),
  effectiveFrom: Type.String({ format: "date" }),
  effectiveTo: Type.Optional(Type.Union([Type.String({ format: "date" }), Type.Null()])),
  reason: Type.Union(
    ["provider_documentation", "cms_notice", "legacy_review", "correction"].map((v) =>
      Type.Literal(v),
    ),
  ),
});

export function registerMedicareProviderRoutingRoutes(
  app: FastifyInstance,
  service: MedicareProviderRoutingService,
): void {
  const read = P("billing.mac_credential.read");
  const readScope = PROVIDER_SCOPE("billing.mac_credential.read", targetProviderFromParams);
  const admin = P("billing.mac_credential.admin");
  const adminScope = PROVIDER_SCOPE("billing.mac_credential.admin", targetProviderFromBody);
  app.get(
    "/api/v1/billing/medicare-provider-routing/:providerEntityId",
    {
      preHandler: [read, readScope],
      config: { auditRead: { none: "Medicare provider routing configuration; no patient data" } },
    },
    async (request) => {
      const actor = actorOf(request);
      const { providerEntityId } = parse(Params, request.params);
      return {
        items: await service.history(actor, providerEntityId),
        migrationIssues: await service.backfillIssues(actor, providerEntityId),
      };
    },
  );
  app.post(
    "/api/v1/billing/medicare-provider-routing",
    {
      preHandler: [
        admin,
        adminScope,
        STEP_UP("billing.mac_credential.admin"),
        rejectAiActor(),
        requireIdempotencyKey(),
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const body = parse(Body, request.body);
      return service.configure(actor, body);
    },
  );
}
