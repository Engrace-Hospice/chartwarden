// apps/backend/src/modules/33-reporting/routes/definitions.routes.ts — M33 (§4.1 #8–#14).
//
// The tenant report-definition authoring surface + the D9 IMMUTABLE VERSION CHAIN: create a definition
// (bound to an `active` base, §2.3 BASE_NOT_ACTIVE) with its initial draft spec, list/read definitions,
// list a definition's versions, append a NEW version (editing is never in-place — D9), publish a version
// (promote to `latest`, supersede the prior), and archive a definition. Every route is gated by the REAL
// Authorization Contract (`requirePermission` from @chartwarden/auth, M3) on the §4.6 `report.definition.*`
// keys — those keys carry `abac:"none"` in M33_CONTRIBUTED_PERMISSIONS, so `requirePermission` is the
// authoritative gate (the route-table's `org_member` intent is carried by the M3 `reporting` role
// assignment; M33 owns only `reportable_scope` + `dashboard_visibility` as named predicates — naming an
// unregistered predicate would deny-stub the route, the admin/bases-metrics precedent).
//
// MUTATIONS run through the injected M33WriteRouteService → ONE `withOrgContext` tx on the PRIMARY (RLS
// scopes every statement to `app.org_id`); each carries `requireIdempotencyKey` (the M1 `applyIdempotency`
// middleware does the replay caching; this guard enforces header presence) and returns 201. READS disclose
// the tenant's own definitions/versions; the §164.312(b) read-audit anchor is the M4 write-audit trigger
// on the `withOrgContext` path (no per-handler audit call — the M33 read-route convention). Org/actor/owner
// binding is ALWAYS server-side (request.context, never the body). Mirrors M22 routes/documents-routes.ts.
import { requirePermission } from "@chartwarden/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { parse } from "./reporting-typebox";
import type { M33WriteRouteService } from "./write-service";
import {
  CreateDefinitionRequest,
  CreateVersionRequest,
  DefinitionIdParams,
  DefinitionListQuery,
  DefinitionVersionParams,
} from "./write-typebox";

export interface DefinitionRouteDeps {
  readonly service: M33WriteRouteService;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const DEF_WRITE = P("report.definition.write");
const DEF_LIST = P("report.definition.list");
const DEF_READ = P("report.definition.read");
const DEF_PUBLISH = P("report.definition.publish");
const DEF_ARCHIVE = P("report.definition.archive");
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 report-definition routes (#8–#14). */
export function registerDefinitionRoutes(app: FastifyInstance, deps: DefinitionRouteDeps): void {
  const { service } = deps;

  // 8 — create a tenant definition + its initial draft (v1) spec (§2.3 BASE_NOT_ACTIVE). §4.1/§4.2.
  app.post(
    "/api/v1/reporting/definitions",
    { preHandler: [DEF_WRITE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(CreateDefinitionRequest, request.body);
      const res = await service.createDefinition(actor, {
        baseKey: body.baseKey,
        displayName: body.displayName,
        description: body.description,
        spec: body.spec,
      });
      return reply.code(201).send(res);
    },
  );

  // 9 — list the actor's org definitions (filter status/authorship; cursor-paginated). §4.1.
  app.get("/api/v1/reporting/definitions", { preHandler: [DEF_LIST] }, async (request) => {
    const actor = writeActorOf(request);
    const q = parse(DefinitionListQuery, request.query);
    return service.listDefinitions(
      actor,
      { status: q.status, authorship: q.authorship },
      q.cursor,
      q.limit,
    );
  });

  // 10 — read one definition (the latest-version pointer + lock). §4.1.
  app.get("/api/v1/reporting/definitions/:id", { preHandler: [DEF_READ] }, async (request) => {
    const actor = writeActorOf(request);
    const { id } = parse(DefinitionIdParams, request.params);
    return service.getDefinition(actor, id);
  });

  // 11 — list a definition's version chain (newest first; cursor-paginated). §4.1/D9.
  app.get(
    "/api/v1/reporting/definitions/:id/versions",
    { preHandler: [DEF_READ] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(DefinitionIdParams, request.params);
      const q = parse(DefinitionListQuery, request.query);
      return service.listVersions(actor, id, q.cursor, q.limit);
    },
  );

  // 12 — append a NEW immutable version (D9 — editing is never in-place). §4.1/§4.2.
  app.post(
    "/api/v1/reporting/definitions/:id/versions",
    { preHandler: [DEF_WRITE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(DefinitionIdParams, request.params);
      const body = parse(CreateVersionRequest, request.body);
      const res = await service.createVersion(actor, id, {
        spec: body.spec,
        displayName: body.displayName,
        description: body.description,
      });
      return reply.code(201).send(res);
    },
  );

  // 13 — publish a version: promote it to the definition's `latest`, supersede the prior (D9). §4.1.
  app.post(
    "/api/v1/reporting/definitions/:id/versions/:vid/publish",
    { preHandler: [DEF_PUBLISH, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id, vid } = parse(DefinitionVersionParams, request.params);
      const res = await service.publishVersion(actor, id, vid);
      return reply.code(201).send(res);
    },
  );

  // 14 — archive a definition (terminal; the version chain is retained). §4.1.
  app.post(
    "/api/v1/reporting/definitions/:id/archive",
    { preHandler: [DEF_ARCHIVE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(DefinitionIdParams, request.params);
      const res = await service.archiveDefinition(actor, id);
      return reply.code(201).send(res);
    },
  );
}
