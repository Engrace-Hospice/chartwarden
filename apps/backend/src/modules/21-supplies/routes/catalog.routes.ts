// apps/backend/src/modules/21-supplies/routes/catalog.routes.ts — M21 (§4.1) rows 11–19: the D11 SKU
// catalog (platform + tenant overlay) and the §2.3 comfort-kit templates.
//
// NOTHING HERE IS PHI. A hospital bed, a brief and a comfort-kit recipe are the same facts for every
// patient, which is why these routes carry no `auditRead` emission — they carry an explicit WAIVER instead,
// so the M4 §2.5 coverage gate records that the omission was decided rather than forgotten. The one thing
// that IS sensitive on this surface is the controlled-substance CLASSIFICATION of a SKU, and that is a
// property of the drug, not of a person.
//
// TWO WRITE ROUTES ARE PLATFORM-ONLY (§4.3): `supplies.item.write` and `supplies.item.retire`.
// `supply_item` carries no `organization_id` at all (D11) and its RLS policy grants writes only to
// `wardenx_admin`, so a tenant session holding the key would still be refused by the database. The
// permission is the first gate and the grant is the backstop — deliberately two, because a catalog write
// that leaked into a tenant would corrupt every other tenant's SKU list.
//
// A TEMPLATE EDIT IS A SUPERSESSION, NOT A PATCH (§2.3). Route 19 is `PUT`, but it INSERTS a new template
// row pointing back through `replaces_template_id` and closes the predecessor's effective window. That is
// why its body is the full new definition: a dispatch from three months ago must still resolve the recipe
// it actually used (§7.2's survey reconstruction).
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import { P } from "./guards";
import {
  CreateSupplyItemBody,
  CreateTemplateBody,
  IdParams,
  ListSupplyItemsQuery,
  ListTemplatesQuery,
  RetireSupplyItemBody,
  SupersedeTemplateBody,
  TemplateIdParams,
  UpsertTenantSupplyItemBody,
  parse,
  parseQuery,
} from "./m21-typebox";
import type { M21ReadService } from "./read-service";
import type { M21WriteService } from "./write-service";

export interface CatalogRouteDeps {
  readonly readService: M21ReadService;
  readonly writeService: M21WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

/** M4 §2.5 — an explicit, justified waiver: the catalog surfaces no patient-linked data at all. */
const NO_PHI = {
  auditRead: { none: "SKU catalog / kit recipe reference data — no patient is identifiable here" },
} as const;

export function registerSupplyCatalogRoutes(app: FastifyInstance, deps: CatalogRouteDeps): void {
  const { readService, writeService } = deps;

  // 11 — the SKU catalog: the platform rows UNION the tenant overlay, one browsable list.
  app.get(
    "/api/v1/supplies/supply-items",
    { preHandler: [P("supplies.item.read"), NO_OFFSET], config: NO_PHI },
    async (request) =>
      readService.listSupplyItems(actorOf(request), parseQuery(ListSupplyItemsQuery, request.query)),
  );

  // 12 — create a canonical HCPCS-keyed SKU (PLATFORM-ONLY; see the module header).
  app.post(
    "/api/v1/supplies/supply-items",
    { preHandler: [P("supplies.item.write"), IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(CreateSupplyItemBody, request.body);
      const created = await writeService.createSupplyItem(writeActorOf(request), body);
      return reply.code(201).send(created);
    },
  );

  // 13 — one SKU, platform or overlay (the id space is disjoint, so one route serves both).
  app.get(
    "/api/v1/supplies/supply-items/:id",
    { preHandler: [P("supplies.item.read")], config: NO_PHI },
    async (request) => {
      const { id } = parse(IdParams, request.params);
      return readService.getSupplyItem(actorOf(request), id);
    },
  );

  // 14 — retire a canonical SKU (PLATFORM-ONLY). Effective-dating, never deletion: a retired HCPCS code
  //      must keep resolving for every historical `supply_request` written against it.
  app.post(
    "/api/v1/supplies/supply-items/:id/retire",
    { preHandler: [P("supplies.item.retire"), IDEMPOTENT] },
    async (request) => {
      const { id } = parse(IdParams, request.params);
      const body = parse(RetireSupplyItemBody, request.body);
      return writeService.retireSupplyItem(writeActorOf(request), id, body);
    },
  );

  // 15 — create a tenant-local, non-billable item (D11's overlay half).
  app.post(
    "/api/v1/supplies/tenant-supply-items",
    { preHandler: [P("supplies.tenant_item.write"), IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(UpsertTenantSupplyItemBody, request.body);
      const created = await writeService.createTenantExtension(writeActorOf(request), body);
      return reply.code(201).send(created);
    },
  );

  // 16 — edit a tenant-local item.
  app.put(
    "/api/v1/supplies/tenant-supply-items/:id",
    { preHandler: [P("supplies.tenant_item.write"), IDEMPOTENT] },
    async (request) => {
      const { id } = parse(IdParams, request.params);
      const body = parse(UpsertTenantSupplyItemBody, request.body);
      return writeService.updateTenantExtension(writeActorOf(request), id, body);
    },
  );

  // 17 — comfort-kit templates. `includePlatformFloor` defaults ON so the admin screen shows the D3 floor
  //      row as locked; a picker passes `false`.
  app.get(
    "/api/v1/supplies/comfort-kit-templates",
    { preHandler: [P("comfort_kit.template.read"), NO_OFFSET], config: NO_PHI },
    async (request) =>
      readService.listComfortKitTemplates(
        actorOf(request),
        parseQuery(ListTemplatesQuery, request.query),
      ),
  );

  // 18 — author a tenant template. The D3 floor validation runs BEFORE anything is written, so a template
  //      that drops below the four-medication floor never exists even transiently.
  app.post(
    "/api/v1/supplies/comfort-kit-templates",
    { preHandler: [P("comfort_kit.template.write"), IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(CreateTemplateBody, request.body);
      const created = await writeService.createComfortKitTemplate(writeActorOf(request), body);
      return reply.code(201).send(created);
    },
  );

  // 19 — supersede a template (see the module header: this INSERTS, it does not patch).
  app.put(
    "/api/v1/supplies/comfort-kit-templates/:templateId",
    { preHandler: [P("comfort_kit.template.write"), IDEMPOTENT] },
    async (request) => {
      const { templateId } = parse(TemplateIdParams, request.params);
      const body = parse(SupersedeTemplateBody, request.body);
      return writeService.supersedeComfortKitTemplate(writeActorOf(request), templateId, body);
    },
  );
}
