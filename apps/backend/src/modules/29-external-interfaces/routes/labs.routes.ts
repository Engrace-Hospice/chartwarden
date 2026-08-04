// apps/backend/src/modules/29-external-interfaces/routes/labs.routes.ts — §4.2 clinician lab surface.
//
// The deliberately narrow clinician read surface: caseload-scoped `lab_observation` reads (the
// `lab_observation_patient_caseload_or_scope` predicate is the gatekeeper on the single-observation read +
// the abnormal-flag acknowledgment) and the unmatched-lab review queue (the review-unmatched role). Manual
// bind / discard of an UNMATCHED result materializes a `lab_observation` from a stored wire message and lands
// in T-29.13, so those two routes fail closed here with a typed 501 (honest "not yet"); the routes still walk
// the full guard + step-up + actor chain.
import type { FastifyInstance } from "fastify";

import { actorOf, writeActorOf } from "./actor";
import { ABAC_IN_ORG, ABAC_LAB_CASELOAD, P, STEP_UP } from "./guards";
import {
  AttachPatientBody,
  DiscardObservationBody,
  ObservationListQuery,
  parse,
  parseQuery,
} from "./m29-typebox";
import { type M29Store, M29StoreError } from "./store";

export interface LabRouteDeps {
  readonly store: M29Store;
}

export function registerLabRoutes(app: FastifyInstance, deps: LabRouteDeps): void {
  const { store } = deps;

  // GET /observations — list caseload lab observations (RLS-scoped; wide-scope roles read across the org).
  app.get(
    "/api/clinical/labs/observations",
    {
      preHandler: [P("external_interfaces.lab.read"), ABAC_IN_ORG("external_interfaces.lab.read")],
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parseQuery(ObservationListQuery, request.query);
      return store.listObservations(actor.organizationId, {
        patientId: q.patientId,
        loincCode: q.loincCode,
        abnormalFlag: q.abnormalFlag,
        limit: q.limit,
        cursor: q.cursor,
      });
    },
  );

  // GET /observations/unmatched — the failed-cascade review queue (registered before the :id param route).
  app.get(
    "/api/clinical/labs/observations/unmatched",
    {
      preHandler: [
        P("external_interfaces.lab.review_unmatched"),
        ABAC_IN_ORG("external_interfaces.lab.review_unmatched"),
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parseQuery(ObservationListQuery, request.query);
      return store.listUnmatchedObservations(actor.organizationId, {
        limit: q.limit,
        cursor: q.cursor,
      });
    },
  );

  // GET /observations/:observationId — single observation with its value rows.
  app.get(
    "/api/clinical/labs/observations/:observationId",
    {
      preHandler: [
        P("external_interfaces.lab.read"),
        ABAC_LAB_CASELOAD("external_interfaces.lab.read"),
      ],
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { observationId } = request.params as { observationId: string };
      const observation = await store.getObservation(actor.organizationId, observationId);
      if (!observation) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "observation not found" });
      }
      return { observation };
    },
  );

  // POST /observations/:observationId/attach-patient — manual patient attach for an unmatched result.
  app.post(
    "/api/clinical/labs/observations/:observationId/attach-patient",
    {
      preHandler: [
        P("external_interfaces.lab.review_unmatched"),
        STEP_UP("external_interfaces.lab.review_unmatched"),
        ABAC_IN_ORG("external_interfaces.lab.review_unmatched"),
      ],
    },
    async (request) => {
      writeActorOf(request);
      parse(AttachPatientBody, request.body);
      throw new M29StoreError(
        "manual bind of an unmatched lab result materializes a lab_observation from the stored wire message — T-29.13",
      );
    },
  );

  // POST /observations/:observationId/discard — discard an unmatched result (reason required).
  app.post(
    "/api/clinical/labs/observations/:observationId/discard",
    {
      preHandler: [
        P("external_interfaces.lab.review_unmatched"),
        STEP_UP("external_interfaces.lab.review_unmatched"),
        ABAC_IN_ORG("external_interfaces.lab.review_unmatched"),
      ],
    },
    async (request) => {
      writeActorOf(request);
      parse(DiscardObservationBody, request.body);
      throw new M29StoreError(
        "discard of an unmatched lab result lands with the manual bind — T-29.13",
      );
    },
  );

  // POST /observations/:observationId/acknowledge-abnormal — RN clears the M36 abnormal-flag alert badge.
  app.post(
    "/api/clinical/labs/observations/:observationId/acknowledge-abnormal",
    {
      preHandler: [
        P("external_interfaces.lab.acknowledge_abnormal"),
        ABAC_LAB_CASELOAD("external_interfaces.lab.acknowledge_abnormal"),
      ],
    },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { observationId } = request.params as { observationId: string };
      const observation = await store.getObservation(actor.organizationId, observationId);
      if (!observation) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "observation not found" });
      }
      if (
        observation.abnormalSummary === "all_normal" ||
        observation.abnormalSummary === "no_flags"
      ) {
        return reply.code(409).send({
          code: "CONFLICT",
          message: "observation carries no abnormal flag to acknowledge",
        });
      }
      // The M36 badge clear is M36's concern (M29 owns no out-of-band delivery); the acknowledgment itself
      // is a read-audited clinical action against the observation.
      return { acknowledged: true, observationId, acknowledgedBy: actor.membershipId };
    },
  );
}
