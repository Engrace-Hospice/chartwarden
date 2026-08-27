// apps/backend/src/modules/15-discipline-care-plans/routes/supervisory.routes.ts — M15 (§4.1) routes
// 15–16: the 42 CFR §418.76(h) RN supervisory attestation.
//
// Both routes compose the §4.5 `aide_supervisor_eligible` predicate over the `:planId` — the §8.6 (S)
// control: only the plan's NAMED supervising RN (or a Clinical Supervisor / DON covering the plan's
// location, the §6 documented override) may attest, and the acting membership is stamped server-side, so
// a caller cannot attest as someone else by putting their id in the body. The sign route adds the §4.1
// step-up gate.
import type { FastifyInstance } from "fastify";
import { writeActorOf } from "./actor";
import { ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { ABAC_SUPERVISOR, P, STEP_UP } from "./guards";
import {
  CreateSupervisoryVisitBody,
  PlanParams,
  SupervisoryVisitParams,
  parse,
} from "./m15-typebox";
import type { M15WriteService } from "./write-service";

export interface SupervisoryRouteDeps {
  readonly writeService: M15WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();

export function registerAideSupervisoryRoutes(
  app: FastifyInstance,
  deps: SupervisoryRouteDeps,
): void {
  const { writeService } = deps;

  // 15 — record a supervisory attestation. A phone-only supervision (null sourceEncounterId) is recorded
  // for survey discoverability but does NOT re-arm the 14-day clock (§2.2.4 D3).
  app.post(
    "/api/v1/discipline-plans/:planId/aide-supervisory-visits",
    {
      preHandler: [
        P("aide_supervisory.author"),
        ABAC_SUPERVISOR("aide_supervisory.author"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const { planId } = parse(PlanParams, request.params);
      const body = parse(CreateSupervisoryVisitBody, request.body);
      const created = await writeService.createSupervisoryVisit(
        writeActorOf(request),
        planId,
        body,
      );
      return reply.code(201).send(created);
    },
  );

  // 16 — sign the attestation (step-up).
  app.post(
    "/api/v1/discipline-plans/:planId/aide-supervisory-visits/:visitId/sign",
    {
      preHandler: [
        P("aide_supervisory.sign"),
        ABAC_SUPERVISOR("aide_supervisory.sign"),
        STEP_UP("aide_supervisory.sign"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { planId, visitId } = parse(SupervisoryVisitParams, request.params);
      return writeService.signSupervisoryVisit(writeActorOf(request), planId, visitId, {
        expectedVersion: ifMatchVersion(request, true),
      });
    },
  );
}
