// apps/backend/src/modules/28-fhir/routes/admin-config.routes.ts — §4.1 R37-R39: the tenant FHIR config.
//
// R39 (rotate the per-tenant HMAC cursor-signing key) carries a STEP-UP gate on top of `fhir.config.write`
// (../permission-keys.ts pins the set): rotating it invalidates every outstanding signed search cursor, so
// a stolen session must not be able to do it. The rotation is a code-side key regeneration — the plaintext
// key never leaves the server.
import type { FastifyInstance } from "fastify";

import { actorOf, writeActorOf } from "./actor";
import { ABAC_IN_ORG, P, STEP_UP } from "./guards";
import { PutConfigBody, parse } from "./m28-typebox";
import type { FhirGatewayStore } from "./store";

export interface AdminConfigRouteDeps {
  readonly store: FhirGatewayStore;
}

export function registerAdminConfigRoutes(app: FastifyInstance, deps: AdminConfigRouteDeps): void {
  const { store } = deps;

  // R37 — read the tenant's FHIR config.
  app.get(
    "/api/v1/fhir/config",
    {
      preHandler: [P("fhir.config.read"), ABAC_IN_ORG("fhir.config.read")],
      config: {
        auditRead: {
          none: "org-level FHIR gateway configuration (host, SLA windows, dedup window); no patient data.",
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      return { config: await store.getConfig(actor.organizationId) };
    },
  );

  // R38 — upsert the tenant's FHIR config.
  app.put(
    "/api/v1/fhir/config",
    { preHandler: [P("fhir.config.write"), ABAC_IN_ORG("fhir.config.write")] },
    async (request) => {
      const actor = writeActorOf(request);
      const body = parse(PutConfigBody, request.body);
      return store.putConfig(actor.organizationId, {
        tenantFhirHost: body.tenantFhirHost,
        identifierUriBase: body.identifierUriBase,
        inboundReviewSlaHours: body.inboundReviewSlaHours,
        exportDedupWindowMinutes: body.exportDedupWindowMinutes,
      });
    },
  );

  // R39 — rotate the cursor-signing key (STEP-UP). Invalidates every outstanding signed cursor.
  app.post(
    "/api/v1/fhir/config/rotate-cursor-key",
    {
      preHandler: [
        P("fhir.config.write"),
        STEP_UP("fhir.config.write"),
        ABAC_IN_ORG("fhir.config.write"),
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      return store.rotateCursorKey(actor.organizationId);
    },
  );
}
