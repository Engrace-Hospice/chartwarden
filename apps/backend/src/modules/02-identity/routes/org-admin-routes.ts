// apps/backend/src/modules/02-identity/routes/org-admin-routes.ts — GAP-115 (M2 spec §4.1 rows `GET/POST/PATCH
// /api/v1/orgs[/:id]`, `/api/v1/provider-entities[...]`, `/api/v1/locations[...]`).
//
//   GET   /api/v1/orgs                     own org (org admin) · every org, searchable (platform operator)
//   POST  /api/v1/orgs                     create an org spine row                  (platform operator only)
//   GET   /api/v1/orgs/:id                 own org · any org (platform operator)
//   PATCH /api/v1/orgs/:id                 displayName (own org) · + legalName (platform operator)
//   GET   /api/v1/provider-entities/:id    one provider entity of the caller's org (no tax id, ever)
//   POST  /api/v1/provider-entities        create (CCN, NPI check digit, EIN enveloped by the cipher)
//   PATCH /api/v1/provider-entities/:id    name / DBA / fiscal intermediary / iQIES id / billing address / lifecycle status
//   GET   /api/v1/locations/:id            one service location
//   POST  /api/v1/locations                create under one of the caller's provider entities
//   PATCH /api/v1/locations/:id            address / contact / timezone / lifecycle status
//
// AUTHORIZATION. `org.manage` (RBAC) on every route. Anything that reaches past the caller's own org — listing
// or creating organizations, editing another org's name — additionally goes through the platform-ops gate
// (`organization_lifecycle_platform_ops` / the platform-owned role keys, GAP-003), so a tenant `org_admin` can
// never touch a neighbour. Provider-entity and location writes are ORG-BOUND by construction: they act on the
// session's own org and the store re-asserts ownership (a location has no org column — its provider entity is
// the wall).
//
// WHAT IS NOT HERE, ON PURPOSE. The regulatory identity of a provider entity (CCN, NPI, tax id, fiscal year end)
// is immutable through PATCH: those are what CMS enrolment and every claim key on, so a change is a re-enrolment
// handled by support, not a form field. The tax id is write-once and never read back. Organization LIFECYCLE
// (activate / suspend / close) is the separate platform route (organization-lifecycle-routes.ts).
//
// TAX ID CIPHER. `provider_entity.tax_id_encrypted` is NOT NULL and an EIN must never be stored in the clear.
// The envelope cipher is an injected port; until the KMS-backed key ring binds it, POST /provider-entities
// refuses with 503 `TAX_ID_CIPHER_UNBOUND` (the M8/M20/M32 `*_CIPHER_UNBOUND` posture) — everything else works.
import { PLATFORM_OPS_ROLE_KEYS, requireAbac, requirePermission } from "@chartwarden/auth";
import { ChartWardenError } from "@chartwarden/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  auditLocationCreated,
  auditLocationUpdated,
  auditOrganizationCreated,
  auditOrganizationUpdated,
  auditProviderEntityCreated,
  auditProviderEntityUpdated,
} from "../audit/org-admin-audit";
import {
  type TaxIdCipherPort,
  createLocationForOrg,
  createProviderEntityForOrg,
  updateLocationForOrg,
  updateProviderEntityForOrg,
} from "../org-admin-site-service";
import type { OrgAdminStore } from "../org-admin-store";
import { requireSlug, slugify } from "../org-admin-validation";
import {
  type AdminRouteDeps,
  asBody,
  assertOrgMatch,
  auditContextFor,
  invalid,
  notFound,
  optionalString,
  requiredString,
  resolveActor,
} from "./admin-route-kit";

export type { TaxIdCipherPort } from "../org-admin-site-service";

export interface OrgAdminRouteDeps extends AdminRouteDeps {
  readonly store: OrgAdminStore;
  /** Unbound -> POST /provider-entities answers 503 TAX_ID_CIPHER_UNBOUND. */
  readonly taxIdCipher?: TaxIdCipherPort;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const isPlatformOperator = (request: FastifyRequest): boolean =>
  request.context.roles.some((r) => (PLATFORM_OPS_ROLE_KEYS as readonly string[]).includes(r));

const conflict = (code: string, message: string) => new ChartWardenError(code, message, 409);

function requireAnyChange(changed: readonly string[]): void {
  if (changed.length === 0) invalid("body", "Nothing to change: send at least one editable field.");
}

export function registerOrgAdminRoutes(app: FastifyInstance, deps: OrgAdminRouteDeps): void {
  const { store } = deps;

  // ── organizations ─────────────────────────────────────────────────────────────────────────────
  app.get("/api/v1/orgs", async (request) => {
    await requirePermission("org.manage")(request);
    const query = (request.query ?? {}) as { q?: unknown; cursor?: unknown; limit?: unknown };
    if (!isPlatformOperator(request)) {
      const own = request.context.organizationId
        ? await store.getOrganization(request.context.organizationId)
        : null;
      return { items: own ? [own] : [], nextCursor: null };
    }
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Math.floor(Number(query.limit) || DEFAULT_LIMIT)),
    );
    const offset = Math.max(0, Math.floor(Number(query.cursor) || 0));
    const q = typeof query.q === "string" && query.q.trim() ? query.q.trim() : undefined;
    const rows = await store.listOrganizations({ ...(q ? { q } : {}), limit: limit + 1, offset });
    return {
      items: rows.slice(0, limit),
      nextCursor: rows.length > limit ? String(offset + limit) : null,
    };
  });

  app.get("/api/v1/orgs/:id", async (request) => {
    await requirePermission("org.manage")(request);
    const { id } = request.params as { id: string };
    if (!isPlatformOperator(request)) assertOrgMatch(request, id);
    const org = await store.getOrganization(id);
    if (!org) throw notFound("organization");
    return org;
  });

  app.post("/api/v1/orgs", async (request, reply) => {
    await requirePermission("org.manage")(request);
    await requireAbac("org.manage", "organization_lifecycle_platform_ops")(request);
    const actor = await resolveActor(deps, request);
    const body = asBody(request.body);
    const legalName = requiredString(body, "legalName");
    const displayName = optionalString(body, "displayName") || legalName;
    const slug = requireSlug(optionalString(body, "slug") || slugify(legalName));
    const created = await store.createOrganization({
      slug,
      legalName,
      displayName,
      createdByUserId: actor.userId,
    });
    if ("conflict" in created) throw conflict("SLUG_TAKEN", `the slug '${slug}' is already in use`);
    await auditOrganizationCreated(deps.audit, auditContextFor(request, actor), created.id);
    return reply.code(201).send(created);
  });

  app.patch("/api/v1/orgs/:id", async (request) => {
    await requirePermission("org.manage")(request);
    const { id } = request.params as { id: string };
    const platform = isPlatformOperator(request);
    if (!platform) assertOrgMatch(request, id);
    const actor = await resolveActor(deps, request);
    const body = asBody(request.body);
    const patch: { legalName?: string; displayName?: string } = {};
    const displayName = optionalString(body, "displayName");
    if (displayName !== undefined) {
      if (displayName === "") invalid("displayName", "displayName cannot be empty");
      patch.displayName = displayName;
    }
    const legalName = optionalString(body, "legalName");
    if (legalName !== undefined) {
      // The legal name is what claims and contracts carry: a tenant administrator edits the display name only.
      if (!platform)
        throw new ChartWardenError(
          "FORBIDDEN",
          "only a platform operator can change the legal name",
          403,
        );
      if (legalName === "") invalid("legalName", "legalName cannot be empty");
      patch.legalName = legalName;
    }
    requireAnyChange(Object.keys(patch));
    const updated = await store.updateOrganization(id, patch);
    if (!updated) throw notFound("organization");
    await auditOrganizationUpdated(
      deps.audit,
      auditContextFor(request, actor),
      id,
      Object.keys(patch),
    );
    return updated;
  });

  // ── provider entities ─────────────────────────────────────────────────────────────────────────
  const orgOf = (request: FastifyRequest): string => {
    const org = request.context.organizationId;
    if (!org) throw new ChartWardenError("FORBIDDEN", "an org-bound session is required", 403);
    return org;
  };

  app.get("/api/v1/provider-entities/:id", async (request) => {
    await requirePermission("org.manage")(request);
    const { id } = request.params as { id: string };
    const pe = await store.getProviderEntity(orgOf(request), id);
    if (!pe) throw notFound("provider entity");
    return pe;
  });

  app.post("/api/v1/provider-entities", async (request, reply) => {
    await requirePermission("org.manage")(request);
    const orgId = orgOf(request);
    const actor = await resolveActor(deps, request);
    const created = await createProviderEntityForOrg(
      {
        store,
        ...(deps.taxIdCipher ? { taxIdCipher: deps.taxIdCipher } : {}),
        logError: (err, context) =>
          request.log.error({ err, ...context }, "tax-id encryption failed"),
      },
      orgId,
      request.body,
    );
    await auditProviderEntityCreated(deps.audit, auditContextFor(request, actor), {
      organizationId: orgId,
      providerEntityId: created.id,
    });
    return reply.code(201).send(created);
  });

  app.patch("/api/v1/provider-entities/:id", async (request) => {
    await requirePermission("org.manage")(request);
    const orgId = orgOf(request);
    const { id } = request.params as { id: string };
    const actor = await resolveActor(deps, request);
    const { updated, changedFields } = await updateProviderEntityForOrg(
      { store },
      orgId,
      id,
      request.body,
    );
    await auditProviderEntityUpdated(deps.audit, auditContextFor(request, actor), {
      organizationId: orgId,
      providerEntityId: id,
      changedFields,
    });
    return updated;
  });

  // ── locations ─────────────────────────────────────────────────────────────────────────────────
  app.get("/api/v1/locations/:id", async (request) => {
    await requirePermission("org.manage")(request);
    const { id } = request.params as { id: string };
    const loc = await store.getLocation(orgOf(request), id);
    if (!loc) throw notFound("location");
    return loc;
  });

  app.post("/api/v1/locations", async (request, reply) => {
    await requirePermission("org.manage")(request);
    const orgId = orgOf(request);
    const actor = await resolveActor(deps, request);
    const created = await createLocationForOrg({ store }, orgId, request.body);
    await auditLocationCreated(deps.audit, auditContextFor(request, actor), {
      organizationId: orgId,
      locationId: created.id,
      providerEntityId: created.providerEntityId,
    });
    return reply.code(201).send(created);
  });

  app.patch("/api/v1/locations/:id", async (request) => {
    await requirePermission("org.manage")(request);
    const orgId = orgOf(request);
    const { id } = request.params as { id: string };
    const actor = await resolveActor(deps, request);
    const { updated, changedFields } = await updateLocationForOrg(
      { store },
      orgId,
      id,
      request.body,
    );
    await auditLocationUpdated(deps.audit, auditContextFor(request, actor), {
      organizationId: orgId,
      locationId: id,
      changedFields,
    });
    return updated;
  });
}
