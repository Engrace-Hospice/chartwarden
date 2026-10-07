// apps/backend/src/modules/29-external-interfaces/routes/labs.routes.ts — §4.2 clinician lab surface.
//
// The deliberately narrow clinician read surface: caseload-scoped `lab_observation` reads (the
// `lab_observation_patient_caseload_or_scope` predicate is the gatekeeper on the single-observation read +
// the abnormal-flag acknowledgment) and the unmatched-lab review queue (the review-unmatched role).
//
// GAP-044 — the queue now has an EXIT. `attach-patient` and `discard` were permanent 501s deferring to
// T-29.13, which is the FRONTEND task; no backend task ever owned them, and the queue they were the exit
// from was itself empty (ingest wrote no link row for an unmatched result). Both are real writes now:
// the bind materializes the `lab_observation` parent that ingest deferred, under the observation id the
// link row reserved; the discard soft-tombstones the link with a ≥10-char reason (§5.2.4). The guard +
// step-up + actor chain each already walked is unchanged.
import { ConflictError, NotFoundError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";

import { getSeam } from "../../../bootstrap/index";
import { actorOf, writeActorOf } from "./actor";
import { ABAC_IN_ORG, ABAC_LAB_CASELOAD, P, STEP_UP } from "./guards";
import { resolveLabListScope } from "./lab-list-scope";
import {
  AttachPatientBody,
  DiscardObservationBody,
  ObservationListQuery,
  parse,
  parseQuery,
} from "./m29-typebox";
import type { M29Store } from "./store";

export interface LabRouteDeps {
  readonly store: M29Store;
}

export function registerLabRoutes(app: FastifyInstance, deps: LabRouteDeps): void {
  const { store } = deps;

  // GET /observations — caseload-scoped lab observations (org-wide roles read across the org; failure fails closed).
  app.get(
    "/api/clinical/labs/observations",
    {
      preHandler: [P("external_interfaces.lab.read"), ABAC_IN_ORG("external_interfaces.lab.read")],
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parseQuery(ObservationListQuery, request.query);
      // GAP-085 — scope is server-derived: org-wide roles read the org; everyone else their caseload.
      const scope = await resolveLabListScope(actor, getSeam("CaseloadProvider"));
      return store.listObservations(actor.organizationId, {
        ...scope,
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
        throw new NotFoundError("observation");
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
      const actor = writeActorOf(request);
      const { observationId } = request.params as { observationId: string };
      const body = parse(AttachPatientBody, request.body);
      return store.bindUnmatchedObservation(
        actor.organizationId,
        actor.membershipId,
        observationId,
        {
          patientId: body.patientId,
          ...(body.note === undefined ? {} : { note: body.note }),
        },
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
      const actor = writeActorOf(request);
      const { observationId } = request.params as { observationId: string };
      const body = parse(DiscardObservationBody, request.body);
      return store.discardUnmatchedObservation(
        actor.organizationId,
        actor.membershipId,
        observationId,
        { reason: body.reason },
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
        throw new NotFoundError("observation");
      }
      if (
        observation.abnormalSummary === "all_normal" ||
        observation.abnormalSummary === "no_flags"
      ) {
        throw new ConflictError("observation carries no abnormal flag to acknowledge");
      }
      // The M36 badge clear is M36's concern (M29 owns no out-of-band delivery); the acknowledgment itself
      // is a read-audited clinical action against the observation.
      return { acknowledged: true, observationId, acknowledgedBy: actor.membershipId };
    },
  );
}
