// apps/backend/src/modules/02-identity/routes/org-admin-routes.ts — GAP-115 (M2 spec §4.1 rows `GET/POST/PATCH
// /api/v1/orgs[/:id]`, `/api/v1/provider-entities[...]`, `/api/v1/locations[...]`).
//
//   GET   /api/v1/orgs                     own org (org admin) · every org, searchable (platform operator)
//   POST  /api/v1/orgs                     create an org spine row                  (platform operator only)
//   GET   /api/v1/orgs/:id                 own org · any org (platform operator)
//   PATCH /api/v1/orgs/:id                 displayName (own org) · + legalName (platform operator)
//   GET   /api/v1/provider-entities/:id    one provider entity of the caller's org (no tax id, ever)
//   POST  /api/v1/provider-entities        create (CCN, NPI check digit, EIN enveloped by the cipher)
//   PATCH /api/v1/provider-entities/:id    name / DBA / fiscal intermediary / iQIES id / lifecycle status
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
import { PLATFORM_OPS_ROLE_KEYS, requireAbac, requirePermission } from "@wardenx/auth";
import { WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  auditLocationCreated,
  auditLocationUpdated,
  auditOrganizationCreated,
  auditOrganizationUpdated,
  auditProviderEntityCreated,
  auditProviderEntityUpdated,
} from "../audit/org-admin-audit";
import type { LocationPatch, OrgAdminStore, ProviderEntityPatch } from "../org-admin-store";
import {
  assertStatusTransition,
  normalizeTaxId,
  requireCcn,
  requireFiscalYearEnd,
  requireNpi,
  requirePostalCode,
  requireSlug,
  requireState,
  requireTimezone,
  slugify,
} from "../org-admin-validation";
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

/** The injected envelope cipher for `provider_entity.tax_id_encrypted` (KMS-backed in production). */
export interface TaxIdCipherPort {
  /** Sealed under the tenant's own DEK, so the cipher needs to know whose key to use. */
  encrypt(input: { organizationId: string; plaintext: string }): Promise<string>;
}

export interface OrgAdminRouteDeps extends AdminRouteDeps {
  readonly store: OrgAdminStore;
  /** Unbound -> POST /provider-entities answers 503 TAX_ID_CIPHER_UNBOUND. */
  readonly taxIdCipher?: TaxIdCipherPort;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
/** Fields of a provider entity that identify it to CMS — never editable through PATCH. */
const IMMUTABLE_PE_FIELDS = ["ccn", "npi", "taxId", "fiscalYearEnd", "organizationId"] as const;

const isPlatformOperator = (request: FastifyRequest): boolean =>
  request.context.roles.some((r) => (PLATFORM_OPS_ROLE_KEYS as readonly string[]).includes(r));

const conflict = (code: string, message: string) => new WardenXError(code, message, 409);

function rejectImmutable(body: Record<string, unknown>, fields: readonly string[]): void {
  const present = fields.filter((f) => body[f] !== undefined);
  if (present.length > 0)
    invalid(
      present[0] as string,
      `${present.join(", ")} cannot be changed here — it identifies the record to CMS; contact support for a re-enrolment.`,
    );
}

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
        throw new WardenXError(
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
    if (!org) throw new WardenXError("FORBIDDEN", "an org-bound session is required", 403);
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
    const body = asBody(request.body);
    const ccn = requireCcn(requiredString(body, "ccn", 6));
    const npi = requireNpi(requiredString(body, "npi", 10));
    const taxId = normalizeTaxId(requiredString(body, "taxId", 20));
    if (!taxId) invalid("taxId", "taxId must be a 9-digit EIN (12-3456789).");
    const input = {
      ccn,
      npi,
      legalName: requiredString(body, "legalName"),
      doingBusinessAs: optionalString(body, "doingBusinessAs") || null,
      fiscalIntermediary: optionalString(body, "fiscalIntermediary") || null,
      fiscalYearEnd: requireFiscalYearEnd(requiredString(body, "fiscalYearEnd", 4)),
      iqiesFacilityId: optionalString(body, "iqiesFacilityId", 50) || null,
    };
    if (!deps.taxIdCipher)
      throw new WardenXError(
        "TAX_ID_CIPHER_UNBOUND",
        "the tax-id envelope cipher (KMS-backed key ring) is not bound; a provider entity cannot be created until it is",
        503,
      );
    const taxIdEncrypted = await deps.taxIdCipher.encrypt({
      organizationId: orgId,
      plaintext: taxId as string,
    });
    const created = await store.createProviderEntity(orgId, { ...input, taxIdEncrypted });
    if ("conflict" in created)
      throw conflict(
        created.conflict === "ccn" ? "CCN_TAKEN" : "NPI_TAKEN",
        `a provider entity with this ${created.conflict.toUpperCase()} already exists`,
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
    const body = asBody(request.body);
    rejectImmutable(body, IMMUTABLE_PE_FIELDS);
    const current = await store.getProviderEntity(orgId, id);
    if (!current) throw notFound("provider entity");

    const patch: ProviderEntityPatch = {};
    const legalName = optionalString(body, "legalName");
    if (legalName !== undefined) {
      if (legalName === "") invalid("legalName", "legalName cannot be empty");
      patch.legalName = legalName;
    }
    for (const f of ["doingBusinessAs", "fiscalIntermediary", "iqiesFacilityId"] as const) {
      const v = optionalString(body, f, f === "iqiesFacilityId" ? 50 : 200);
      if (v !== undefined) patch[f] = v === "" ? null : v;
    }
    const status = optionalString(body, "status");
    if (status !== undefined) {
      if (!["created", "active", "suspended", "closed"].includes(status))
        invalid("status", "status must be created, active, suspended or closed");
      assertStatusTransition(current.status, status);
      patch.status = status as ProviderEntityPatch["status"];
    }
    requireAnyChange(Object.keys(patch));
    const updated = await store.updateProviderEntity(orgId, id, patch);
    if (!updated) throw notFound("provider entity");
    await auditProviderEntityUpdated(deps.audit, auditContextFor(request, actor), {
      organizationId: orgId,
      providerEntityId: id,
      changedFields: Object.keys(patch),
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
    const body = asBody(request.body);
    const providerEntityId = requiredString(body, "providerEntityId", 64);
    const input = {
      providerEntityId,
      name: requiredString(body, "name"),
      addressLine1: requiredString(body, "addressLine1"),
      addressLine2: optionalString(body, "addressLine2") || null,
      city: requiredString(body, "city", 100),
      state: requireState(requiredString(body, "state", 2)),
      postalCode: requirePostalCode(requiredString(body, "postalCode", 10)),
      phone: optionalString(body, "phone", 30) || null,
      fax: optionalString(body, "fax", 30) || null,
      timezone: requireTimezone(requiredString(body, "timezone", 64)),
    };
    const created = await store.createLocation(orgId, input);
    // Not this org's provider entity — the same answer as an unknown one (no existence oracle).
    if (!created) throw notFound("provider entity");
    await auditLocationCreated(deps.audit, auditContextFor(request, actor), {
      organizationId: orgId,
      locationId: created.id,
      providerEntityId,
    });
    return reply.code(201).send(created);
  });

  app.patch("/api/v1/locations/:id", async (request) => {
    await requirePermission("org.manage")(request);
    const orgId = orgOf(request);
    const { id } = request.params as { id: string };
    const actor = await resolveActor(deps, request);
    const body = asBody(request.body);
    rejectImmutable(body, ["providerEntityId", "organizationId"]);
    const current = await store.getLocation(orgId, id);
    if (!current) throw notFound("location");

    const patch: LocationPatch = {};
    const text = (f: "name" | "addressLine1" | "city", max = 200): void => {
      const v = optionalString(body, f, max);
      if (v === undefined) return;
      if (v === "") invalid(f, `${f} cannot be empty`);
      patch[f] = v;
    };
    text("name");
    text("addressLine1");
    text("city", 100);
    for (const f of ["addressLine2", "phone", "fax"] as const) {
      const v = optionalString(body, f, f === "addressLine2" ? 200 : 30);
      if (v !== undefined) patch[f] = v === "" ? null : v;
    }
    const state = optionalString(body, "state", 2);
    if (state !== undefined) patch.state = requireState(state);
    const postal = optionalString(body, "postalCode", 10);
    if (postal !== undefined) patch.postalCode = requirePostalCode(postal);
    const tz = optionalString(body, "timezone", 64);
    if (tz !== undefined) patch.timezone = requireTimezone(tz);
    const status = optionalString(body, "status");
    if (status !== undefined) {
      if (!["created", "active", "suspended", "closed"].includes(status))
        invalid("status", "status must be created, active, suspended or closed");
      assertStatusTransition(current.status, status);
      if (status === "active") {
        const owner = await store.getProviderEntity(orgId, current.providerEntityId);
        if (owner?.status !== "active")
          throw conflict(
            "PROVIDER_ENTITY_NOT_ACTIVE",
            "a location can only be activated under an active provider entity",
          );
      }
      patch.status = status as LocationPatch["status"];
    }
    requireAnyChange(Object.keys(patch));
    const updated = await store.updateLocation(orgId, id, patch);
    if (!updated) throw notFound("location");
    await auditLocationUpdated(deps.audit, auditContextFor(request, actor), {
      organizationId: orgId,
      locationId: id,
      changedFields: Object.keys(patch),
    });
    return updated;
  });
}
