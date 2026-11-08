// apps/backend/src/modules/16-bereavement/routes/assessment-draft.routes.ts — M16 (ADR-0109 D5) routes 35 / 36: the pre-death
// risk-assessment draft, addressed by ADMISSION because it exists before any bereavement plan.
//
// Both routes gate on their `bereavement.assessment_draft.*` key plus the `bereavement_pre_death_assessor` predicate (an MSW,
// chaplain or bereavement counselor on the patient's care team, or bereavement oversight; a volunteer and every portal session
// are denied). The PUT replaces the whole eight-factor vector, requires `If-Match` (a first write names version 0) and an
// `Idempotency-Key`, and answers 409 `DRAFT_LOCKED` once a plan exists for the admission. The GET declares its M4 read audit
// with `resourceIdParam: admissionId`, so the read event carries the admission it was about.
import { factorsFromFullWire } from "@chartwarden/bereavement";
import { NotFoundError } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import type { M16DraftService } from "./draft-service";
import { ABAC_PRE_DEATH_ASSESSOR, P } from "./guards";
import { AdmissionParams, PreDeathDraftBody, parse } from "./m16-typebox";

export interface DraftRouteDeps {
  readonly draftService: M16DraftService;
}

const IDEMPOTENT = requireIdempotencyKey();

/** The M4 read-audit declaration every PHI draft read carries (§8.1 / M4 §2.5). */
const DRAFT_READ = {
  resourceKind: "bereavement_risk_assessment_draft",
  resourceIdParam: "admissionId",
} as const;

export function registerBereavementAssessmentDraftRoutes(
  app: FastifyInstance,
  deps: DraftRouteDeps,
): void {
  const { draftService } = deps;

  // 35 — read the draft (an empty all-`unknown` draft at version 0 when nothing is recorded yet).
  app.get(
    "/api/v1/bereavement/pre-death-assessments/:admissionId",
    {
      preHandler: [
        P("bereavement.assessment_draft.read"),
        ABAC_PRE_DEATH_ASSESSOR("bereavement.assessment_draft.read"),
      ],
      config: { auditRead: DRAFT_READ },
    },
    async (request) => {
      const { admissionId } = parse(AdmissionParams, request.params);
      const draft = await draftService.getDraft(actorOf(request), admissionId);
      // An admission outside this tenant is indistinguishable from one that does not exist.
      if (!draft) throw new NotFoundError("admission not found");
      return draft;
    },
  );

  // 36 — record the draft (replaces the whole vector; If-Match; 409 once a plan exists).
  app.put(
    "/api/v1/bereavement/pre-death-assessments/:admissionId",
    {
      preHandler: [
        P("bereavement.assessment_draft.write"),
        ABAC_PRE_DEATH_ASSESSOR("bereavement.assessment_draft.write"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { admissionId } = parse(AdmissionParams, request.params);
      const body = parse(PreDeathDraftBody, request.body);
      return draftService.putDraft(writeActorOf(request), admissionId, {
        factors: factorsFromFullWire(body.factors),
        expectedVersion: ifMatchVersion(request, true) ?? 0,
      });
    },
  );
}
