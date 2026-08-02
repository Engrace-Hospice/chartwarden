// apps/backend/src/modules/28-fhir/routes/admin-inbound.routes.ts — §4.1 R34-R36: the staged inbound
// proposal review queue (D8). Accept/reject gate on `fhir.inbound.accept`/`fhir.inbound.reject` PLUS the
// §4.7 `fhir_inbound_owner_module_match` — a proposal is only ever decided by a reviewer holding the owner
// module's native write path (m5 patient demographics / m12 medhx reconcile). A rejection needs a ≥40-char
// rationale (the store enforces the §2.3 minimum).
import type { FastifyInstance } from "fastify";

import { writeActorOf } from "./actor";
import { ABAC_IN_ORG, ABAC_INBOUND_OWNER_MATCH, P } from "./guards";
import {
  AcceptProposalBody,
  InboundListQuery,
  ProposalIdParams,
  RejectProposalBody,
  parse,
  parseQuery,
} from "./m28-typebox";
import { actorOf } from "./actor";
import type { FhirGatewayStore } from "./store";

export interface AdminInboundRouteDeps {
  readonly store: FhirGatewayStore;
}

export function registerAdminInboundRoutes(app: FastifyInstance, deps: AdminInboundRouteDeps): void {
  const { store } = deps;

  // R34 — the operator review queue.
  app.get(
    "/api/v1/fhir/inbound-proposals",
    { preHandler: [P("fhir.inbound.review"), ABAC_IN_ORG("fhir.inbound.review")] },
    async (request) => {
      const actor = actorOf(request);
      const { ownerModule, status } = parseQuery(InboundListQuery, request.query);
      return { proposals: await store.listProposals(actor.organizationId, { ownerModule, status }) };
    },
  );

  // R35 — accept: the owner module now owns the native record it created (§2.2 `accepted_aggregate_id`).
  app.post(
    "/api/v1/fhir/inbound-proposals/:id/accept",
    { preHandler: [P("fhir.inbound.accept"), ABAC_INBOUND_OWNER_MATCH("fhir.inbound.accept")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(ProposalIdParams, request.params);
      const body = parse(AcceptProposalBody, request.body);
      return store.acceptProposal(
        actor.organizationId,
        id,
        actor.membershipId,
        body.acceptedAggregateId,
        body.rationale ?? null,
      );
    },
  );

  // R36 — reject: the payload is destruction-scheduled at +30 days (§3.7); the rationale is retained.
  app.post(
    "/api/v1/fhir/inbound-proposals/:id/reject",
    { preHandler: [P("fhir.inbound.reject"), ABAC_INBOUND_OWNER_MATCH("fhir.inbound.reject")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(ProposalIdParams, request.params);
      const { rationale } = parse(RejectProposalBody, request.body);
      return store.rejectProposal(actor.organizationId, id, actor.membershipId, rationale);
    },
  );
}
