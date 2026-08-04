// apps/backend/src/modules/33-reporting/routes/views-shares.routes.ts — M33 (§4.1 #15–#21).
//
// The saved-view + SHARING surface (D17): list (mine / org-shared), create a view over a published
// definition version, read/edit a view, set its share scope (`private | role | org`), set the single
// org-default (Org Admin), and archive. Every route is gated by the REAL Authorization Contract
// (`requirePermission` + `requireAbac` from @wardenx/auth, M3) on the §4.6 `report.view.*` /
// `report.share.*` keys. The view read/edit/share/archive keys bind the `dashboard_visibility` predicate
// M33 OWNS (§4.7.2 owner/org/role ladder) — applied here over the `:id` view (the predicate reads the
// target `viewId`, so the getTarget maps the route param). `report.view.list` / `report.view.write`
// (create) / `report.view.set_org_default` carry `abac:"none"` in the catalog (no existing view to resolve
// a visibility against / role-carried org-admin intent), so `requirePermission` is their full gate.
//
// #19 share to `org` scope additionally requires the `report.share.org` permission (D17) — enforced by
// invoking that guard inline on the org branch (the real RBAC contract, never a body-trusted check).
// MUTATIONS run through the injected service → ONE `withOrgContext` tx on the PRIMARY (RLS scopes to
// `app.org_id`); each carries `requireIdempotencyKey` + returns 201. READS disclose the actor's own /
// org-shared views; the M4 write-audit trigger on the `withOrgContext` path is the §164.312(b) anchor.
// Org/actor/owner binding is ALWAYS server-side (request.context). Mirrors M22 routes/documents-routes.ts.
import { requireAbac, requirePermission } from "@wardenx/auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type PreHandler, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { parse } from "./reporting-typebox";
import type { M33WriteRouteService } from "./write-service";
import {
  CreateViewRequest,
  ShareViewRequest,
  UpdateViewRequest,
  ViewIdParams,
  ViewListQuery,
} from "./write-typebox";

export interface ViewShareRouteDeps {
  readonly service: M33WriteRouteService;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
// `dashboard_visibility` (§4.7.2) decides read/edit/share on a saved view; the predicate reads the target
// `viewId`, so we map the route `:id` param onto it (the default target is `request.params`, which carries
// `id`, not `viewId`).
const VIS = (key: string): PreHandler =>
  requireAbac(key, "dashboard_visibility", {
    getTarget: (request) => ({ viewId: (request.params as { id?: string }).id ?? "" }),
    notFoundOnDeny: true, // §2.2 existence non-leak — a 403 would reveal a view the actor may not see
  }) as PreHandler;

const VIEW_LIST = P("report.view.list");
const VIEW_WRITE = P("report.view.write");
const VIEW_READ = P("report.view.read");
const VIEW_READ_VIS = VIS("report.view.read");
const VIEW_WRITE_VIS = VIS("report.view.write");
const VIEW_ARCHIVE = P("report.view.archive");
const VIEW_ARCHIVE_VIS = VIS("report.view.archive");
const VIEW_SET_DEFAULT = P("report.view.set_org_default");
const SHARE_WRITE = P("report.share.write");
const SHARE_WRITE_VIS = VIS("report.share.write");
const SHARE_ORG = requirePermission("report.share.org") as (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 saved-view + sharing routes (#15–#21). */
export function registerViewShareRoutes(app: FastifyInstance, deps: ViewShareRouteDeps): void {
  const { service } = deps;

  // 15 — list views (scope=mine → the actor's own; scope=org → org-shared; cursor-paginated). §4.1.
  app.get("/api/v1/reporting/views", { preHandler: [VIEW_LIST] }, async (request) => {
    const actor = writeActorOf(request);
    const q = parse(ViewListQuery, request.query);
    return service.listViews(actor, { scope: q.scope }, q.cursor, q.limit);
  });

  // 16 — create a saved view over a published definition version. §4.1/§4.2.
  app.post(
    "/api/v1/reporting/views",
    { preHandler: [VIEW_WRITE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(CreateViewRequest, request.body);
      const res = await service.createView(actor, {
        definitionVersionId: body.definitionVersionId,
        displayName: body.displayName,
        pinnedFilters: body.pinnedFilters,
        shareScope: body.shareScope,
        shareRoleKeys: body.shareRoleKeys,
      });
      return reply.code(201).send(res);
    },
  );

  // 17 — read one view (the §4.7.2 visibility ladder gates access). §4.1.
  app.get(
    "/api/v1/reporting/views/:id",
    { preHandler: [VIEW_READ, VIEW_READ_VIS] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(ViewIdParams, request.params);
      return service.getView(actor, id);
    },
  );

  // 18 — edit a view (display / pinned filters / share scope). §4.1/§4.2.
  app.patch(
    "/api/v1/reporting/views/:id",
    { preHandler: [VIEW_WRITE, VIEW_WRITE_VIS, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ViewIdParams, request.params);
      const body = parse(UpdateViewRequest, request.body);
      const res = await service.updateView(actor, id, {
        displayName: body.displayName,
        pinnedFilters: body.pinnedFilters,
        shareScope: body.shareScope,
        shareRoleKeys: body.shareRoleKeys,
      });
      return reply.code(200).send(res);
    },
  );

  // 19 — set a view's share scope (D17). `org` additionally requires report.share.org (inline guard). §4.1.
  app.post(
    "/api/v1/reporting/views/:id/share",
    { preHandler: [SHARE_WRITE, SHARE_WRITE_VIS, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ViewIdParams, request.params);
      const body = parse(ShareViewRequest, request.body);
      // org-scope sharing requires the dedicated permission — invoke the real RBAC guard on that branch.
      if (body.shareScope === "org") await SHARE_ORG(request, reply);
      const res = await service.shareView(
        actor,
        id,
        {
          shareScope: body.shareScope,
          shareRoleKeys: body.shareRoleKeys,
          sharedWithMembershipId: body.sharedWithMembershipId,
        },
        true, // reaching here means the org-scope guard (if any) passed
      );
      return reply.code(201).send(res);
    },
  );

  // 20 — set the single org-default view (Org Admin; `report.view.set_org_default`). §4.1/D17.
  app.post(
    "/api/v1/reporting/views/:id/set-org-default",
    { preHandler: [VIEW_SET_DEFAULT, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ViewIdParams, request.params);
      const res = await service.setOrgDefault(actor, id);
      return reply.code(201).send(res);
    },
  );

  // 21 — archive a view (clears the org-default flag). §4.1.
  app.post(
    "/api/v1/reporting/views/:id/archive",
    { preHandler: [VIEW_ARCHIVE, VIEW_ARCHIVE_VIS, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ViewIdParams, request.params);
      const res = await service.archiveView(actor, id);
      return reply.code(201).send(res);
    },
  );
}
