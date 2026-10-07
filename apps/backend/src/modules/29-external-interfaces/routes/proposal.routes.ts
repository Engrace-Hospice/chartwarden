// apps/backend/src/modules/29-external-interfaces/routes/proposal.routes.ts — §4.1.2 ADT proposal review.
//
// The propose-then-review surface (D5): an inbound ADT never mutates an M5 patient or an M6 admission
// directly — it stages a proposal a compliance officer / supervising RN adjudicates. Accept/reject run the
// T04 `decideProposal` core and are gated by `hl7_inbound_proposal_owner_module_match` (the reviewer must
// hold the owner module's native write path) + step-up (D18). Defer punts to a caseload-RN task (M19
// forward-seam) and leaves the proposal `pending`.
import { NotFoundError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";

import { actorOf, writeActorOf } from "./actor";
import { ABAC_IN_ORG, ABAC_PROPOSAL_OWNER, P, STEP_UP } from "./guards";
import {
  AcceptProposalBody,
  DeferProposalBody,
  ProposalListQuery,
  RejectProposalBody,
  parse,
  parseQuery,
} from "./m29-typebox";
import type { M29Store } from "./store";

export interface ProposalRouteDeps {
  readonly store: M29Store;
}

export function registerProposalRoutes(app: FastifyInstance, deps: ProposalRouteDeps): void {
  const { store } = deps;

  // GET /inbound-proposals — list the review queue.
  app.get(
    "/api/admin/external-interfaces/inbound-proposals",
    {
      preHandler: [
        P("external_interfaces.proposal.read"),
        ABAC_IN_ORG("external_interfaces.proposal.read"),
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parseQuery(ProposalListQuery, request.query);
      return store.listProposals(actor.organizationId, {
        status: q.status,
        ownerModule: q.ownerModule,
        feedId: q.feedId,
        proposedForPatientId: q.proposedForPatientId,
        limit: q.limit,
        cursor: q.cursor,
      });
    },
  );

  // GET /inbound-proposals/:proposalId — single proposal detail.
  app.get(
    "/api/admin/external-interfaces/inbound-proposals/:proposalId",
    {
      preHandler: [
        P("external_interfaces.proposal.read"),
        ABAC_PROPOSAL_OWNER("external_interfaces.proposal.read"),
      ],
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { proposalId } = request.params as { proposalId: string };
      const proposal = await store.getProposal(actor.organizationId, proposalId);
      if (!proposal) throw new NotFoundError("proposal");
      return { proposal };
    },
  );

  // POST /inbound-proposals/:proposalId/accept — apply via owner-module seam (step-up D18).
  app.post(
    "/api/admin/external-interfaces/inbound-proposals/:proposalId/accept",
    {
      preHandler: [
        P("external_interfaces.proposal.accept"),
        STEP_UP("external_interfaces.proposal.accept"),
        ABAC_PROPOSAL_OWNER("external_interfaces.proposal.accept"),
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { proposalId } = request.params as { proposalId: string };
      const body = parse(AcceptProposalBody, request.body);
      const proposal = await store.acceptProposal(
        actor.organizationId,
        actor.membershipId,
        proposalId,
        body,
      );
      return { proposal };
    },
  );

  // POST /inbound-proposals/:proposalId/reject — no mutation; rationale ≥40 chars (step-up D18).
  app.post(
    "/api/admin/external-interfaces/inbound-proposals/:proposalId/reject",
    {
      preHandler: [
        P("external_interfaces.proposal.reject"),
        STEP_UP("external_interfaces.proposal.reject"),
        ABAC_PROPOSAL_OWNER("external_interfaces.proposal.reject"),
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { proposalId } = request.params as { proposalId: string };
      const body = parse(RejectProposalBody, request.body);
      const proposal = await store.rejectProposal(
        actor.organizationId,
        actor.membershipId,
        proposalId,
        body.rationale,
      );
      return { proposal };
    },
  );

  // POST /inbound-proposals/:proposalId/defer — punt to a caseload-RN task; stays pending.
  app.post(
    "/api/admin/external-interfaces/inbound-proposals/:proposalId/defer",
    {
      preHandler: [
        P("external_interfaces.proposal.defer"),
        ABAC_IN_ORG("external_interfaces.proposal.defer"),
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { proposalId } = request.params as { proposalId: string };
      const body = parse(DeferProposalBody, request.body);
      const proposal = await store.deferProposal(
        actor.organizationId,
        actor.membershipId,
        proposalId,
        body.note,
      );
      return { proposal };
    },
  );
}
