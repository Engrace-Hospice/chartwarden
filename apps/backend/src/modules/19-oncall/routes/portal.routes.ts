// apps/backend/src/modules/19-oncall/routes/portal.routes.ts — M19 (§4.1) row 36: the M31-served portal
// view of recent triage activity.
//
// ONE ROUTE, THREE CONTROLS, AND THE PATIENT ID COMES FROM NONE OF THE PLACES A CALLER CAN WRITE.
//
//   1. `portal_session_consent_active` validates M39's `family_caregiver_access` consent for the SPECIFIC
//      patient, and the predicate refuses any session class that is not a portal one — so a staff session
//      cannot reach the lay-language projection and thereby bypass the clinical routes' caseload gate.
//   2. THE PATIENT ID IS TAKEN FROM THE SESSION (`context.attributes.portalPatientId`), never from the
//      query string. §8.3.1's threat (b) is exactly a caregiver with a valid portal session naming another
//      patient's id; sourcing it from the session makes the mismatch unrepresentable rather than merely
//      refused, and §8.3.1 fixes the answer at 403 (hence `notFoundOnDeny: false` in the guard).
//   3. THE PROJECTION IS `PortalTriageSummary`, WHICH HAS NO FIELD FOR WHAT IS WITHHELD. No hospitalization
//      risk band (D11 excludes the advisory), no vendor handoff (D13 — the family does not need to know
//      whether the agency or a contracted service answered), no protocol answers, no escalation tiers, no
//      clinician free text. §8.3.4 asks for a projection that is not filtered at runtime but is
//      structurally incapable of carrying the content, and the read service's SELECT names six columns to
//      match.
import { ForbiddenError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { actorOf } from "./actor";
import { rejectOffsetPagination } from "./concurrency";
import { ABAC_PORTAL_CONSENT, P } from "./guards";
import { PortalRecentQuery, parseQuery } from "./m19-typebox";
import type { M19ReadService } from "./read-service";

export interface PortalRouteDeps {
  readonly readService: M19ReadService;
}

const NO_OFFSET = rejectOffsetPagination();

/** Control 2 — the portal session's OWN patient anchor. Absent ⇒ 403, never "fall back to the query". */
function portalPatientIdOf(request: {
  context?: { attributes?: Record<string, unknown> };
}): string {
  const attrs = request.context?.attributes;
  const value = attrs?.portalPatientId ?? attrs?.patientId;
  if (typeof value !== "string" || value.length === 0) {
    throw new ForbiddenError(
      "this portal session carries no patient anchor; the triage care log is scoped by the session, not by a request parameter (§8.3.1)",
    );
  }
  return value;
}

export function registerPortalTriageRoutes(app: FastifyInstance, deps: PortalRouteDeps): void {
  const { readService } = deps;

  // 36 — the lay-language care log. Only calls that reached `documented` / `closed` appear: an open call
  //      is a conversation in progress, and surfacing it would show a caregiver a half-finished clinical
  //      judgement (§5.3's projection is a care LOG, not a live board).
  app.get(
    "/api/v1/portal/triage/recent",
    {
      preHandler: [
        P("portal.triage.read_recent"),
        ABAC_PORTAL_CONSENT("portal.triage.read_recent"),
        NO_OFFSET,
      ],
      config: { auditRead: { resourceKind: "triage_call_portal", list: true } },
    },
    async (request) =>
      readService.listPortalRecent(
        actorOf(request),
        portalPatientIdOf(request),
        parseQuery(PortalRecentQuery, request.query),
      ),
  );
}
