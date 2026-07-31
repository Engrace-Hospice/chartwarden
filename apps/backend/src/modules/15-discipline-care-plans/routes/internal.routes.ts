// apps/backend/src/modules/15-discipline-care-plans/routes/internal.routes.ts — M15 (§4.1) routes 25–28:
// the four `/internal/...` seam surfaces M8 / M14 / M16 / M17 / M22 read M15's facts through when they
// cross the process boundary (the in-process path is the §4.3 seam registry, M15-T05).
//
// TWO locks, both required (§4.1 "system principal"): the three `*_internal` permission keys are never
// granted to a human role template, AND `requireSystemPrincipal()` refuses any session whose
// server-assembled actor kind is not a system principal. A leaked grant therefore cannot turn these into
// an un-caseloaded PHI read path.
//
// The confidential categories are excluded UNCONDITIONALLY on these routes: a system principal carries no
// consent context of its own, so a downstream module that needs SUD or family-violence content must go
// through its own consented read path rather than borrowing M15's seam surface (§7.8 / §7.9).
import type { FastifyInstance } from "fastify";
import { actorOf, requireSystemPrincipal } from "./actor";
import { rejectOffsetPagination } from "./concurrency";
import { P } from "./guards";
import {
  RelevantElementsQuerySchema,
  RiskFactorQuerySchema,
  SupervisoryCadenceQuerySchema,
  VolunteerStatusQuerySchema,
  parseQuery,
} from "./m15-typebox";
import type { M15ReadService } from "./read-service";

export interface InternalRouteDeps {
  readonly readService: M15ReadService;
}

const SYSTEM = requireSystemPrincipal();
const NO_OFFSET = rejectOffsetPagination();

export function registerDisciplinePlanInternalRoutes(
  app: FastifyInstance,
  deps: InternalRouteDeps,
): void {
  const { readService } = deps;

  // 25 — the discipline elements M8 (encounter context) / M14 (IDG packet) / M22 (PDF) pull.
  app.get(
    "/internal/discipline-plans/relevant-elements",
    {
      preHandler: [P("discipline_plan.read_internal"), SYSTEM, NO_OFFSET],
      config: { auditRead: { resourceKind: "discipline_care_plan", list: true } },
    },
    async (request) =>
      readService.listRelevantElements(
        actorOf(request),
        parseQuery(RelevantElementsQuerySchema, request.query),
      ),
  );

  // 26 — the MSW psychosocial risk factors M16's bereavement rubric SCORES (M15 exposes, M16 scores).
  app.get(
    "/internal/discipline-plans/msw-risk-factors",
    {
      preHandler: [P("discipline_plan.read_internal"), SYSTEM, NO_OFFSET],
      config: { auditRead: { resourceKind: "discipline_assessment", list: true } },
    },
    async (request) =>
      readService.listMswRiskFactors(
        actorOf(request),
        parseQuery(RiskFactorQuerySchema, request.query),
      ),
  );

  // 27 — the volunteer's effective 418.78 status (M17's pre-schedule gate). Fail-CLOSED: an unreadable
  // gate store answers `isActive: false`, never an assumed pass (§8.7).
  app.get(
    "/internal/discipline-plans/volunteer-effective-status",
    {
      preHandler: [P("volunteer_compliance.read_internal"), SYSTEM],
      config: {
        auditRead: {
          none: "volunteer workforce-credential status; no patient-identifying field is surfaced",
        },
      },
    },
    async (request) => {
      const q = parseQuery(VolunteerStatusQuerySchema, request.query);
      return readService.getVolunteerEffectiveStatus(actorOf(request), q.volunteerMembershipId);
    },
  );

  // 28 — the supervisory cadence worklist (M17's day-view advisory + M14's dashboard).
  app.get(
    "/internal/discipline-plans/supervisory-cadence",
    {
      preHandler: [P("aide_supervisory.read_internal"), SYSTEM, NO_OFFSET],
      config: { auditRead: { resourceKind: "discipline_care_plan", list: true } },
    },
    async (request) =>
      readService.listSupervisoryCadence(
        actorOf(request),
        parseQuery(SupervisoryCadenceQuerySchema, request.query),
      ),
  );
}
