// apps/backend/src/modules/30-quality/routes/infection.routes.ts — M30 (§4.1 R-90..R-93).
//
// The safety-surveillance INFECTION plane (per-patient surveillance events that auto-cluster into outbreak
// cases via the §3 DB trigger; the aggregate outbreak view drives the CoP §418.60 infection-control program):
//   R-90 GET   /quality/infection/events                — list surveillance events (pathogen/patient filter;
//        PHI; cursor-paginated on `(observed_at DESC, id)`, §4.1.2).
//   R-91 POST  /quality/infection/events                — record an event (auto-clusters). PHI. Idempotency-Key
//        (org, filer, observedAt, pathogen, bodySite).
//   R-92 GET   /quality/infection/outbreaks             — list outbreak cases (status/pathogen filter; aggregate).
//   R-93 PATCH /quality/infection/outbreaks/:caseId     — update outbreak status (notify/contain/resolve;
//        aggregate; version-OCC, no Idempotency-Key).
//
// AUTHORIZATION (the REAL §4.6/§4.7 contract — `requirePermission` + `requireAbac` from @chartwarden/auth, M3):
// each route gates on its §4.6 key, then composes the §4.1 ABAC column (the M3-base `inOrg`). The two event
// routes (R-90/R-91) are PHI: the §4.1 "requirePatientScope()" gate is realized in THIS codebase by the
// `inOrg` predicate here PLUS the M3 patient-level RLS predicate active inside the service's ONE
// `withOrgContext` tx (P2c) PLUS the row-level `part2Redisclosure` redaction — there is no standalone
// `requirePatientScope` export in @chartwarden/auth (the §4.1 note's mechanism, not a symbol). The outbreak
// routes (R-92/R-93) are aggregate-only (org-scoped, no patient PHI). R-91 carries `Idempotency-Key`; the
// PATCH (R-93) is version-OCC-protected and §4.1.1-exempt. Org/actor binding is ALWAYS server-side
// (`request.context` via `actorOf`/`writeActorOf`), NEVER the body. The service emits the §4.10
// `m30.infection.*` events transactionally inside the same unit of work as the mutation.
import { requireAbac, requirePermission } from "@chartwarden/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { assertPatientInScope } from "./patient-scope";
import {
  CaseIdParamsSchema,
  InfectionEventListQuerySchema,
  InfectionOutbreakListQuerySchema,
  RecordInfectionEventBodySchema,
  UpdateInfectionOutbreakBodySchema,
  parse,
} from "./quality-typebox";
import type {
  InfectionEventFilter,
  InfectionOutbreakFilter,
  M30ReadRouteService,
} from "./read-service";
import { type PatientScopeResolver, defaultPatientScopeResolver } from "./scope-resolver";
import type { M30WriteRouteService } from "./write-service";

export interface InfectionRouteDeps {
  readonly readService: M30ReadRouteService;
  readonly writeService: M30WriteRouteService;
  /** GAP-091 — resolves the caller's patient scope from the server session (defaults to the M5 caseload). */
  readonly resolveScope?: PatientScopeResolver;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
// §4.7 ABAC composed AFTER RBAC; the default target is `request.params` (the `:caseId` on R-93).
const ABAC = (key: string, predicate: string): PreHandler =>
  requireAbac(key, predicate) as PreHandler;

const INF_READ = P("infection.read");
const INF_WRITE = P("infection.write");

const READ_INORG = ABAC("infection.read", "inOrg");
const WRITE_INORG = ABAC("infection.write", "inOrg");
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 infection routes (R-90..R-93). */
export function registerInfectionRoutes(app: FastifyInstance, deps: InfectionRouteDeps): void {
  const { readService, writeService } = deps;
  const scopeOf = deps.resolveScope ?? defaultPatientScopeResolver;

  // R-90 — list surveillance events (cursor-paginated; PHI). §4.1/§4.1.2.
  app.get(
    "/api/v1/quality/infection/events",
    {
      preHandler: [INF_READ, READ_INORG],
      config: { auditRead: { resourceKind: "infection_event", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(InfectionEventListQuerySchema, request.query);
      const filter: InfectionEventFilter = {
        pathogen: q.pathogen,
        patientId: q.patientId,
        observedAfter: q.observedAfter,
        observedBefore: q.observedBefore,
      };
      return readService.listInfectionEvents(
        actor,
        filter,
        q.cursor,
        q.limit,
        await scopeOf(actor, "infection"),
      );
    },
  );

  // R-91 — record a surveillance event (auto-clusters into an outbreak case via the §3 trigger). PHI.
  // Idempotency-Key (org, filer, observedAt, pathogen, bodySite). §4.1/§4.1.1.
  app.post(
    "/api/v1/quality/infection/events",
    { preHandler: [INF_WRITE, WRITE_INORG, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(RecordInfectionEventBodySchema, request.body);
      // GAP-091 — an event is recorded only for a patient in the filer's scope (404 otherwise).
      assertPatientInScope(await scopeOf(actor), body.patientId, "patient", false);
      const res = await writeService.recordInfectionEvent(actor, {
        patientId: body.patientId,
        pathogen: body.pathogen,
        bodySite: body.bodySite,
        observedAt: body.observedAt,
      });
      return reply.code(201).send(res);
    },
  );

  // R-92 — list outbreak cases (aggregate-only; org-scoped). §4.1.
  app.get(
    "/api/v1/quality/infection/outbreaks",
    {
      preHandler: [INF_READ, READ_INORG],
      config: { auditRead: { resourceKind: "infection_outbreak", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(InfectionOutbreakListQuerySchema, request.query);
      const filter: InfectionOutbreakFilter = { status: q.status, pathogen: q.pathogen };
      return readService.listInfectionOutbreaks(actor, filter, q.cursor, q.limit);
    },
  );

  // R-93 — update outbreak status (notify/contain/resolve; aggregate; version-OCC; §4.1.1-exempt PATCH). §4.1.
  app.patch(
    "/api/v1/quality/infection/outbreaks/:caseId",
    { preHandler: [INF_WRITE, WRITE_INORG] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { caseId } = parse(CaseIdParamsSchema, request.params);
      const body = parse(UpdateInfectionOutbreakBodySchema, request.body);
      const res = await writeService.updateInfectionOutbreak(actor, caseId, {
        status: body.status,
        resolutionNote: body.resolutionNote,
      });
      return reply.code(200).send(res);
    },
  );
}
