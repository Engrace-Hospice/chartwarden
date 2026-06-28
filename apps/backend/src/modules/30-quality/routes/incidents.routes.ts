// apps/backend/src/modules/30-quality/routes/incidents.routes.ts — M30 (§4.1 R-50..R-61).
//
// The safety-surveillance INCIDENT plane (the M30-F03 separation-of-duties spine):
//   R-50 GET  /quality/incidents                       — list the incident register (kind/state/severity
//        filter; PHI when a patient filter is set; cursor-paginated on `(occurred_at DESC, id)`, §4.1.2).
//   R-51 POST /quality/incidents                       — create a draft incident (Idempotency-Key).
//   R-52 GET  /quality/incidents/:incidentId           — detail (state history + investigation notes + CAP).
//   R-53 PATCH /quality/incidents/:incidentId          — update draft fields (version-OCC, no Idempotency-Key).
//   R-54 POST /quality/incidents/:incidentId/submit    — draft → submitted (reporter-owned).
//   R-55 POST /quality/incidents/:incidentId/triage    — submitted → triaged (assign owner + severity).
//   R-56 POST /quality/incidents/:incidentId/investigation — append-only investigation note (assignee-owned).
//   R-57 POST /quality/incidents/:incidentId/investigate   — open CAP / begin investigation (triaged → under_investigation).
//   R-58 POST /quality/incidents/:incidentId/resolve   — under_investigation → resolved; resolver ≠ assignee
//        (M30-F03 / ADR-0022 two-person control — enforced in the @wardenx/quality `transitionIncident`
//        reducer the service drives, and gated at the door by the `capVerifyAuthority` predicate).
//   R-59 POST /quality/incidents/:incidentId/close     — resolved → closed_followup_complete.
//   R-60 POST /quality/incidents/:incidentId/reopen    — closed/reopened → under_investigation.
//   R-61 GET  /quality/incidents/abuse-allegations     — the `allegation_of_abuse` co-sign queue; the ONLY
//        path abuse rows reach a user (the `abuseAllegationAccess` predicate is the gate).
//
// AUTHORIZATION (the REAL §4.6/§4.7 contract — `requirePermission` + `requireAbac` from @wardenx/auth, M3):
// every route gates on its §4.6 permission key, then composes the §4.1 ABAC column — the M3-base `inOrg`
// plus the M30-owned predicate (`incidentVisibility` / `ownsIncident` / `assignedToIncident` /
// `capVerifyAuthority` / `abuseAllegationAccess`) whose target is `request.params` (the `:incidentId` the
// predicates resolve against). These are PHI routes: the §4.1 "requirePatientScope()" gate is realized in
// THIS codebase by the §4.7 predicate chain here PLUS the M3 patient-level RLS predicate active inside the
// service's ONE `withOrgContext` tx (P2c) PLUS the row-level `part2Redisclosure` redaction — there is no
// standalone `requirePatientScope` export in @wardenx/auth (the §4.1 note's mechanism, not a symbol).
// MUTATIONS in the §4.1.1 set carry `Idempotency-Key` (the M1 middleware does the 24h replay/body-mismatch
// caching; this guard enforces PRESENCE). Org/actor/owner binding is ALWAYS server-side (the M2-assembled
// `request.context` via `actorOf`/`writeActorOf`), NEVER read off the body. The service drives the pure
// reducers (it does not re-implement state logic) and emits the §4.10 `m30.incident.*` events transactionally.
import { requireAbac, requirePermission } from "@wardenx/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import type { IncidentListFilter, M30ReadRouteService } from "./read-service";
import type { M30WriteRouteService } from "./write-service";
import {
  AbuseAllegationListQuerySchema,
  AddInvestigationNoteBodySchema,
  CreateIncidentBodySchema,
  IncidentIdParamsSchema,
  IncidentListQuerySchema,
  OpenInvestigationBodySchema,
  ReopenIncidentBodySchema,
  ResolveIncidentBodySchema,
  TriageIncidentBodySchema,
  UpdateIncidentBodySchema,
  parse,
} from "./quality-typebox";

export interface IncidentRouteDeps {
  readonly readService: M30ReadRouteService;
  readonly writeService: M30WriteRouteService;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
// §4.7 ABAC composed AFTER RBAC; the default target is `request.params` (the `:incidentId`).
const ABAC = (key: string, predicate: string): PreHandler => requireAbac(key, predicate) as PreHandler;

// RBAC keys (§4.6).
const INC_READ = P("incident.read");
const INC_WRITE = P("incident.write");
const INC_SUBMIT = P("incident.submit");
const INC_TRIAGE = P("incident.triage");
const INC_INVESTIGATE = P("incident.investigate");
const INC_CAP = P("incident.cap");
const INC_RESOLVE = P("incident.resolve");
const INC_CLOSE = P("incident.close");
const INC_REOPEN = P("incident.reopen");
const INC_ABUSE = P("incident.abuse_review");

// ABAC chains (§4.1 column: `inOrg` base + the M30-owned predicate).
const READ_INORG = ABAC("incident.read", "inOrg");
const READ_VISIBILITY = ABAC("incident.read", "incidentVisibility");
const WRITE_INORG = ABAC("incident.write", "inOrg");
const WRITE_OWNS = ABAC("incident.write", "ownsIncident");
const SUBMIT_INORG = ABAC("incident.submit", "inOrg");
const SUBMIT_OWNS = ABAC("incident.submit", "ownsIncident");
const TRIAGE_INORG = ABAC("incident.triage", "inOrg");
const INVESTIGATE_INORG = ABAC("incident.investigate", "inOrg");
const INVESTIGATE_ASSIGNED = ABAC("incident.investigate", "assignedToIncident");
const CAP_INORG = ABAC("incident.cap", "inOrg");
const CAP_ASSIGNED = ABAC("incident.cap", "assignedToIncident");
const RESOLVE_INORG = ABAC("incident.resolve", "inOrg");
const RESOLVE_CAPVERIFY = ABAC("incident.resolve", "capVerifyAuthority");
const CLOSE_INORG = ABAC("incident.close", "inOrg");
const CLOSE_CAPVERIFY = ABAC("incident.close", "capVerifyAuthority");
const REOPEN_INORG = ABAC("incident.reopen", "inOrg");
const REOPEN_CAPVERIFY = ABAC("incident.reopen", "capVerifyAuthority");
const ABUSE_INORG = ABAC("incident.abuse_review", "inOrg");
const ABUSE_ACCESS = ABAC("incident.abuse_review", "abuseAllegationAccess");
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 incident routes (R-50..R-61). */
export function registerIncidentRoutes(app: FastifyInstance, deps: IncidentRouteDeps): void {
  const { readService, writeService } = deps;

  // R-50 — list the incident register (cursor-paginated; `incidentVisibility` masks abuse rows). §4.1/§4.1.2.
  app.get(
    "/api/v1/quality/incidents",
    { preHandler: [INC_READ, READ_INORG, READ_VISIBILITY] },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(IncidentListQuerySchema, request.query);
      const filter: IncidentListFilter = {
        kinds: q.kind,
        states: q.state,
        severities: q.severity,
        occurredAfter: q.occurredAfter,
        occurredBefore: q.occurredBefore,
        patientId: q.patientId,
      };
      return readService.listIncidents(actor, filter, q.cursor, q.limit);
    },
  );

  // R-61 — abuse-allegation co-sign queue (static route; `abuseAllegationAccess` is the sole path). §4.1.
  // Registered before the `:incidentId` detail route — Fastify resolves static segments ahead of params.
  app.get(
    "/api/v1/quality/incidents/abuse-allegations",
    { preHandler: [INC_ABUSE, ABUSE_INORG, ABUSE_ACCESS] },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(AbuseAllegationListQuerySchema, request.query);
      return readService.listAbuseAllegations(actor, q.cursor, q.limit);
    },
  );

  // R-51 — create a draft incident (Idempotency-Key: (org, reporter, occurredAt, kind)). §4.1/§4.1.1.
  app.post(
    "/api/v1/quality/incidents",
    { preHandler: [INC_WRITE, WRITE_INORG, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(CreateIncidentBodySchema, request.body);
      const res = await writeService.createIncident(actor, {
        kind: body.kind,
        severity: body.severity,
        patientId: body.patientId,
        occurredAt: body.occurredAt,
        data: body.data,
      });
      return reply.code(201).send(res);
    },
  );

  // R-52 — incident detail (state history + investigation notes + CAP plan). §4.1.
  app.get(
    "/api/v1/quality/incidents/:incidentId",
    { preHandler: [INC_READ, READ_INORG, READ_VISIBILITY] },
    async (request) => {
      const actor = actorOf(request);
      const { incidentId } = parse(IncidentIdParamsSchema, request.params);
      return readService.getIncident(actor, incidentId);
    },
  );

  // R-53 — update draft fields (version-OCC; PATCH is exempt from the §4.1.1 Idempotency-Key set). §4.1.
  app.patch(
    "/api/v1/quality/incidents/:incidentId",
    { preHandler: [INC_WRITE, WRITE_INORG, WRITE_OWNS] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { incidentId } = parse(IncidentIdParamsSchema, request.params);
      const body = parse(UpdateIncidentBodySchema, request.body);
      const res = await writeService.updateIncident(actor, incidentId, {
        severity: body.severity,
        data: body.data,
        occurredAt: body.occurredAt,
      });
      return reply.code(200).send(res);
    },
  );

  // R-54 — submit (draft → submitted; reporter-owned). Idempotency-Key (org, incidentId). §4.1/§4.1.1.
  app.post(
    "/api/v1/quality/incidents/:incidentId/submit",
    { preHandler: [INC_SUBMIT, SUBMIT_INORG, SUBMIT_OWNS, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { incidentId } = parse(IncidentIdParamsSchema, request.params);
      const res = await writeService.submitIncident(actor, incidentId);
      return reply.code(200).send(res);
    },
  );

  // R-55 — triage (submitted → triaged; assign owner + severity). Idempotency-Key (org, incidentId, triager). §4.1/§4.1.1.
  app.post(
    "/api/v1/quality/incidents/:incidentId/triage",
    { preHandler: [INC_TRIAGE, TRIAGE_INORG, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { incidentId } = parse(IncidentIdParamsSchema, request.params);
      const body = parse(TriageIncidentBodySchema, request.body);
      const res = await writeService.triageIncident(actor, incidentId, {
        assignedToMembershipId: body.assignedToMembershipId,
        severity: body.severity,
      });
      return reply.code(200).send(res);
    },
  );

  // R-56 — append-only investigation note (assignee-owned). The §4.1.1 table omits R-56 (notes are not
  // replay-deduplicated), so it carries no Idempotency-Key. Returns the new note (201). §4.1.
  app.post(
    "/api/v1/quality/incidents/:incidentId/investigation",
    { preHandler: [INC_INVESTIGATE, INVESTIGATE_INORG, INVESTIGATE_ASSIGNED] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { incidentId } = parse(IncidentIdParamsSchema, request.params);
      const body = parse(AddInvestigationNoteBodySchema, request.body);
      const res = await writeService.addIncidentInvestigationNote(actor, incidentId, {
        body: body.body,
      });
      return reply.code(201).send(res);
    },
  );

  // R-57 — open CAP / begin investigation (triaged → under_investigation; assignee-owned). Idempotency-Key
  // (org, incidentId, rootCauseSummary[:64]). §4.1/§4.1.1.
  app.post(
    "/api/v1/quality/incidents/:incidentId/investigate",
    { preHandler: [INC_CAP, CAP_INORG, CAP_ASSIGNED, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { incidentId } = parse(IncidentIdParamsSchema, request.params);
      const body = parse(OpenInvestigationBodySchema, request.body);
      const res = await writeService.openIncidentInvestigation(actor, incidentId, {
        rootCauseSummary: body.rootCauseSummary,
        actions: body.actions,
        verificationCriteria: body.verificationCriteria,
      });
      return reply.code(200).send(res);
    },
  );

  // R-58 — resolve / verify CAP (under_investigation → resolved). `capVerifyAuthority` requires the verifier
  // to NOT be the assignee (M30-F03 two-person control; also re-asserted inside `transitionIncident`).
  // Idempotency-Key (org, incidentId, resolver). §4.1/§4.1.1.
  app.post(
    "/api/v1/quality/incidents/:incidentId/resolve",
    { preHandler: [INC_RESOLVE, RESOLVE_INORG, RESOLVE_CAPVERIFY, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { incidentId } = parse(IncidentIdParamsSchema, request.params);
      const body = parse(ResolveIncidentBodySchema, request.body);
      const res = await writeService.resolveIncident(actor, incidentId, {
        resolutionNote: body.resolutionNote,
      });
      return reply.code(200).send(res);
    },
  );

  // R-59 — close (resolved → closed_followup_complete). Idempotency-Key (org, incidentId). §4.1/§4.1.1.
  app.post(
    "/api/v1/quality/incidents/:incidentId/close",
    { preHandler: [INC_CLOSE, CLOSE_INORG, CLOSE_CAPVERIFY, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { incidentId } = parse(IncidentIdParamsSchema, request.params);
      const res = await writeService.closeIncident(actor, incidentId);
      return reply.code(200).send(res);
    },
  );

  // R-60 — reopen (closed/reopened → under_investigation). Idempotency-Key (org, incidentId, reopenReason[:64]). §4.1/§4.1.1.
  app.post(
    "/api/v1/quality/incidents/:incidentId/reopen",
    { preHandler: [INC_REOPEN, REOPEN_INORG, REOPEN_CAPVERIFY, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { incidentId } = parse(IncidentIdParamsSchema, request.params);
      const body = parse(ReopenIncidentBodySchema, request.body);
      const res = await writeService.reopenIncident(actor, incidentId, {
        reopenReason: body.reopenReason,
      });
      return reply.code(200).send(res);
    },
  );
}
