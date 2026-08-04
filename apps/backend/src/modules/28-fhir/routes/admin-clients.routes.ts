import { unsupportedScopes } from "@wardenx/fhir";
// apps/backend/src/modules/28-fhir/routes/admin-clients.routes.ts — §4.1 R23-R30: the FHIR client
// registry admin surface.
//
// The D12 dual-approval lifecycle (propose → co-approve → active) and the W-FHIR-12 revocation cascade
// (revoke/suspend → sessions revoked + in-flight exports cancelled) live in the store's §2.2 FSM path; the
// routes bind the §4.6 permission + §4.7 ABAC and shape the request. `rate_limit_rps` is a PLATFORM-FLOOR /
// tenant-tighten-only value (§2.3): the tier's floor is the default and an override may only LOWER it.
import { ValidationError } from "@wardenx/types";
import { FHIR_TIER_RATE_LIMIT_FLOOR_RPS, type FhirClientTier } from "@wardenx/types";
import type { FastifyInstance } from "fastify";

import { actorOf, writeActorOf } from "./actor";
import { ABAC_CLIENT_ORG, ABAC_IN_ORG, P } from "./guards";
import {
  ApproveClientBody,
  ClientIdParams,
  ClientListQuery,
  ClientSessionParams,
  CreateClientBody,
  RevokeClientBody,
  SuspendClientBody,
  parse,
  parseQuery,
} from "./m28-typebox";
import type { FhirGatewayStore } from "./store";

export interface AdminClientsRouteDeps {
  readonly store: FhirGatewayStore;
}

export function registerAdminClientRoutes(app: FastifyInstance, deps: AdminClientsRouteDeps): void {
  const { store } = deps;

  // R23 — list the org's registered clients.
  app.get(
    "/api/v1/fhir/clients",
    {
      preHandler: [P("fhir.client.read"), ABAC_IN_ORG("fhir.client.read")],
      config: {
        auditRead: {
          none: "FHIR API client registry metadata (name/type/tier/scopes/rate-limit); no patient data.",
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { status } = parseQuery(ClientListQuery, request.query);
      return { clients: await store.listClients(actor.organizationId, { status }) };
    },
  );

  // R24 — propose a new client (D12: the proposer is stamped as the FIRST of the two distinct approvers).
  app.post(
    "/api/v1/fhir/clients",
    { preHandler: [P("fhir.client.admin"), ABAC_IN_ORG("fhir.client.admin")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(CreateClientBody, request.body);
      const bad = unsupportedScopes(body.allowedScopes);
      if (bad.length > 0) {
        throw new ValidationError("one or more requested scopes are not supported", [
          {
            field: "allowedScopes",
            code: "INVALID_SCOPE",
            message: `unsupported: ${bad.join(", ")}`,
          },
        ]);
      }
      const floor = FHIR_TIER_RATE_LIMIT_FLOOR_RPS[body.tier as FhirClientTier];
      // Tighten-only: an override may only LOWER the platform floor for the tier (§2.3).
      if (body.rateLimitRpsOverride !== undefined && body.rateLimitRpsOverride > floor) {
        throw new ValidationError("rate_limit_rps override may only tighten the tier floor", [
          {
            field: "rateLimitRpsOverride",
            code: "RATE_LIMIT_LOOSENS_FLOOR",
            message: `override ${body.rateLimitRpsOverride} exceeds the tier-${body.tier} floor ${floor}`,
          },
        ]);
      }
      if (body.type === "smart_backend_services" && !body.jwksUri) {
        throw new ValidationError("smart_backend_services clients require a jwksUri", [
          {
            field: "jwksUri",
            code: "REQUIRED",
            message: "jwksUri is required for SMART Backend Services",
          },
        ]);
      }
      const result = await store.createClient(actor.organizationId, {
        name: body.name,
        type: body.type,
        jwksUri: body.jwksUri,
        allowedScopes: body.allowedScopes,
        tier: body.tier as FhirClientTier,
        rateLimitRps: body.rateLimitRpsOverride ?? floor,
        ipAllowlist: body.ipAllowlist ?? [],
        baaContractReference: body.baaContractReference,
        proposedByMembershipId: actor.membershipId,
      });
      return reply.code(201).send(result);
    },
  );

  // R25 — the Compliance Officer co-approves (D12; the store refuses self-approval).
  app.post(
    "/api/v1/fhir/clients/:id/approve",
    { preHandler: [P("fhir.client.admin"), ABAC_CLIENT_ORG("fhir.client.admin")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(ClientIdParams, request.params);
      const { rationale } = parse(ApproveClientBody, request.body);
      return store.approveClient(actor.organizationId, id, actor.membershipId, rationale);
    },
  );

  // R26 — revoke (terminal; runs the W-FHIR-12 cascade).
  app.post(
    "/api/v1/fhir/clients/:id/revoke",
    { preHandler: [P("fhir.client.admin"), ABAC_CLIENT_ORG("fhir.client.admin")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(ClientIdParams, request.params);
      const { rationale } = parse(RevokeClientBody, request.body);
      return store.revokeClient(actor.organizationId, id, actor.membershipId, rationale);
    },
  );

  // R27 — suspend (reversible; also runs the cascade — a suspended client's live sessions must die).
  app.post(
    "/api/v1/fhir/clients/:id/suspend",
    { preHandler: [P("fhir.client.admin"), ABAC_CLIENT_ORG("fhir.client.admin")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(ClientIdParams, request.params);
      const { reason } = parse(SuspendClientBody, request.body);
      return store.suspendClient(actor.organizationId, id, actor.membershipId, reason);
    },
  );

  // R28 — rotate the API-key credential (plaintext returned ONCE; the prior credential is retired).
  app.post(
    "/api/v1/fhir/clients/:id/credentials/rotate",
    { preHandler: [P("fhir.client.admin"), ABAC_CLIENT_ORG("fhir.client.admin")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(ClientIdParams, request.params);
      return store.rotateCredential(actor.organizationId, id, actor.membershipId);
    },
  );

  // R29 — list the client's sessions (the active-bearer ledger).
  app.get(
    "/api/v1/fhir/clients/:id/sessions",
    {
      preHandler: [P("fhir.client.session.read"), ABAC_CLIENT_ORG("fhir.client.session.read")],
      config: {
        auditRead: {
          none: "OAuth session metadata (jti/scopes/issued-expires-revoked); no patient data.",
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(ClientIdParams, request.params);
      return { sessions: await store.listSessions(actor.organizationId, id) };
    },
  );

  // R30 — manually revoke one session (a leaked bearer token dies now, not at its TTL).
  app.post(
    "/api/v1/fhir/clients/:id/sessions/:jti/revoke",
    { preHandler: [P("fhir.client.admin"), ABAC_CLIENT_ORG("fhir.client.admin")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id, jti } = parse(ClientSessionParams, request.params);
      await store.revokeSession(actor.organizationId, id, jti);
      return { revoked: true, jti };
    },
  );
}
