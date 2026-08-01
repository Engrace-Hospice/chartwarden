// apps/backend/src/modules/20-field-safety/routes/incidents.routes.ts — M20 (§4.1) rows 12-17: the formal
// incident report and its D9 sign-off.
//
// ── THE OSHA SIGN-OFF IS A SEPARATE ROUTE, A SEPARATE KEY AND A STEP-UP, AND ALL THREE MATTER ───────
//
// §7.6's whole scenario is that the clinician who was bitten sets `osha_reportable = false` in good faith
// and the Compliance Officer, reading the state's own rule a day later, sets it `true`. If the flag were
// just a field on the submit body, that reclassification would be a clinician-level write with a
// state-agency filing behind it. So:
//   • `safety_incident.osha_signoff` is its own §4.6 key (compliance category), held by Clin Supv / DON /
//     Comp Off only;
//   • the route carries `requireStepUp` (§4.1's "∧ step-up", §6's override table);
//   • §3.3's `m20_si_osha_signoff_required` CHECK makes submitting with `true` impossible unless the
//     signed-off PAIR is already on the row — the DB half of D9, which a route-layer-only guard would
//     leave to a repair script to violate; and
//   • the sign-off emits `m20.safety.osha_reportable_incident_filed` at `warn` with the state code and
//     the reporting-window clock, because the officer who receives it needs to know which deadline is
//     running.
//
// Undoing it is deliberately NOT a route: §6 says the classification "cannot be undone without a
// `safety_incident.transition` to `reopened` with reason ≥30 chars and a second sign-off". The sign-off
// route therefore REFUSES on a closed incident (the write service's check), which forces the reopen.
//
// ── ROW 14's `(draft)` QUALIFIER IS THE WRITE SERVICE'S, NOT THE GUARD'S ───────────────────────────
//
// §4.1 spells the cell `clinician_self (draft) ∨ safety_supervisor_or_above`. The lifecycle half runs
// INSIDE the transaction (§2.2.3: `submitted` is the immutability entry point) because a guard that read
// the state would be a second place deciding when a draft stops being editable — and the one that is not
// the transaction is the one that can be stale.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import { ABAC_INCIDENT_EDIT, ABAC_INCIDENT_SUBJECT, ABAC_SUPERVISOR, P, STEP_UP } from "./guards";
import {
  CreateIncidentBody,
  IncidentIdParams,
  IncidentListQuery,
  OshaSignoffBody,
  PatchIncidentBody,
  SubmitIncidentBody,
  TransitionIncidentBody,
  parse,
  parseQuery,
} from "./m20-typebox";
import type { M20ReadService } from "./read-service";
import type { M20WriteService } from "./write-service";

export interface IncidentRouteDeps {
  readonly readService: M20ReadService;
  readonly writeService: M20WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

/** §4.1 rows 13-17 — the incident carries a narrative, a location description and a patient reference. */
const INCIDENT_PHI = {
  resourceKind: "safety_incident",
  patientIdParam: undefined,
  fields: ["narrative_cipher", "witnesses_cipher", "location_description", "patient_id"],
} as const;

export function registerIncidentRoutes(app: FastifyInstance, deps: IncidentRouteDeps): void {
  const { readService, writeService } = deps;

  // 12 — open a draft. `affectedClinicianMembershipId` is the ONE membership a caller may name (§2.2.3's
  //      supervisor-opens-on-behalf-of path), and `incident_subject_or_supervisor` is what keeps naming
  //      somebody else a supervisor-only act.
  app.post(
    "/api/v1/safety/incidents",
    {
      preHandler: [
        P("safety_incident.create"),
        ABAC_INCIDENT_SUBJECT("safety_incident.create"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const body = parse(CreateIncidentBody, request.body);
      const created = await writeService.createIncident(writeActorOf(request), body);
      return reply.code(201).send(created);
    },
  );

  // 13 — the review queue. Narrowed to the caller's own incidents inside the read service when they hold
  //      no oversight role; the guard admits them to the route, the service decides which rows.
  app.get(
    "/api/v1/safety/incidents",
    {
      preHandler: [
        P("safety_incident.read"),
        ABAC_INCIDENT_SUBJECT("safety_incident.read"),
        NO_OFFSET,
      ],
      config: { auditRead: { ...INCIDENT_PHI, list: true } },
    },
    async (request) =>
      readService.listIncidents(actorOf(request), parseQuery(IncidentListQuery, request.query)),
  );

  app.get(
    "/api/v1/safety/incidents/:incidentId",
    {
      preHandler: [
        P("safety_incident.read"),
        ABAC_INCIDENT_SUBJECT("safety_incident.read", "incidentId"),
      ],
      config: { auditRead: { ...INCIDENT_PHI, resourceIdParam: "incidentId" } },
    },
    async (request) => {
      const { incidentId } = parse(IncidentIdParams, request.params);
      return readService.getIncident(actorOf(request), incidentId);
    },
  );

  // 14 — edit a draft (see the header on where the `(draft)` qualifier lives).
  app.patch(
    "/api/v1/safety/incidents/:incidentId",
    {
      preHandler: [
        P("safety_incident.edit_draft"),
        ABAC_INCIDENT_EDIT("safety_incident.edit_draft"),
        IDEMPOTENT,
      ],
      config: { auditRead: { ...INCIDENT_PHI, resourceIdParam: "incidentId" } },
    },
    async (request) => {
      const { incidentId } = parse(IncidentIdParams, request.params);
      const body = parse(PatchIncidentBody, request.body);
      return writeService.patchIncident(writeActorOf(request), incidentId, {
        ...body,
        expectedVersion: ifMatchVersion(request, true),
      });
    },
  );

  // 15 — submit for review. D9's gate: `oshaReportable: true` without the signed-off pair is a 422 that
  //      names the fix, not a constraint violation on a clinician's Submit button.
  app.post(
    "/api/v1/safety/incidents/:incidentId/submit",
    {
      preHandler: [
        P("safety_incident.submit"),
        ABAC_INCIDENT_SUBJECT("safety_incident.submit", "incidentId"),
        IDEMPOTENT,
      ],
      config: { auditRead: { ...INCIDENT_PHI, resourceIdParam: "incidentId" } },
    },
    async (request) => {
      const { incidentId } = parse(IncidentIdParams, request.params);
      const body = parse(SubmitIncidentBody, request.body);
      return writeService.submitIncident(writeActorOf(request), incidentId, {
        ...body,
        expectedVersion: ifMatchVersion(request, true),
      });
    },
  );

  // 16 — the supervisor state machine (§2.2.3). `reopened` re-enters review on the SAME row, because a
  //      second row would break the workers-comp timeline an insurer reads.
  app.post(
    "/api/v1/safety/incidents/:incidentId/state",
    {
      preHandler: [
        P("safety_incident.transition"),
        ABAC_SUPERVISOR("safety_incident.transition"),
        IDEMPOTENT,
      ],
      config: { auditRead: { ...INCIDENT_PHI, resourceIdParam: "incidentId" } },
    },
    async (request) => {
      const { incidentId } = parse(IncidentIdParams, request.params);
      const body = parse(TransitionIncidentBody, request.body);
      return writeService.transitionIncident(writeActorOf(request), incidentId, {
        ...body,
        expectedVersion: ifMatchVersion(request, true),
      });
    },
  );

  // 17 — §7.6 / D9's OSHA-equivalent sign-off (step-up; see the header).
  app.post(
    "/api/v1/safety/incidents/:incidentId/osha-signoff",
    {
      preHandler: [
        P("safety_incident.osha_signoff"),
        ABAC_SUPERVISOR("safety_incident.osha_signoff"),
        STEP_UP("safety_incident.osha_signoff"),
        IDEMPOTENT,
      ],
      config: { auditRead: { ...INCIDENT_PHI, resourceIdParam: "incidentId" } },
    },
    async (request) => {
      const { incidentId } = parse(IncidentIdParams, request.params);
      const body = parse(OshaSignoffBody, request.body);
      return writeService.oshaSignoff(writeActorOf(request), incidentId, {
        ...body,
        expectedVersion: ifMatchVersion(request, true),
      });
    },
  );
}
