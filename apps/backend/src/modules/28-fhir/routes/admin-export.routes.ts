// apps/backend/src/modules/28-fhir/routes/admin-export.routes.ts — §4.1 R31-R33: operator-facing bulk
// export administration. R33's cancel gates on `bulk_export_initiator_or_admin` (§4.7).
import type { FastifyInstance } from "fastify";

import { actorOf, writeActorOf } from "./actor";
import { ABAC_BULK_EXPORT_CANCEL, ABAC_IN_ORG, P } from "./guards";
import {
  BulkExportListQuery,
  InitiateBulkExportBody,
  JobIdParams,
  parse,
  parseQuery,
} from "./m28-typebox";
import type { FhirGatewayStore } from "./store";

export interface AdminExportRouteDeps {
  readonly store: FhirGatewayStore;
}

export function registerAdminExportRoutes(app: FastifyInstance, deps: AdminExportRouteDeps): void {
  const { store } = deps;

  // R31 — list the org's bulk-export jobs.
  app.get(
    "/api/v1/fhir/bulk-export-jobs",
    { preHandler: [P("fhir.export.bulk.read"), ABAC_IN_ORG("fhir.export.bulk.read")] },
    async (request) => {
      const actor = actorOf(request);
      const { status, clientId } = parseQuery(BulkExportListQuery, request.query);
      return { jobs: await store.listJobs(actor.organizationId, { status, clientId }) };
    },
  );

  // R32 — an operator kicks off an export (the acting membership is stamped as the initiator).
  app.post(
    "/api/v1/fhir/bulk-export-jobs",
    { preHandler: [P("fhir.export.bulk.initiate"), ABAC_IN_ORG("fhir.export.bulk.initiate")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(InitiateBulkExportBody, request.body);
      const job = await store.createJob(actor.organizationId, {
        clientId: body.clientId,
        requestKind: body.requestKind,
        groupId: body.groupId,
        patientIds: body.patientIds,
        resourceTypes: body.resourceTypes,
        since: body.since,
        initiatedByMembershipId: actor.membershipId,
      });
      return reply.code(202).send(job);
    },
  );

  // R33 — cancel a job (initiator, the bearer client, or a cancel-permitted operator — the §4.7 predicate).
  app.post(
    "/api/v1/fhir/bulk-export-jobs/:id/cancel",
    { preHandler: [P("fhir.export.bulk.cancel"), ABAC_BULK_EXPORT_CANCEL("fhir.export.bulk.cancel")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(JobIdParams, request.params);
      return store.cancelJob(actor.organizationId, id, actor.membershipId);
    },
  );
}
