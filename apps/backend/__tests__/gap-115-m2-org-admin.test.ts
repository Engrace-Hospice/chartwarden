// GAP-115 — the org-admin write routes (M2 §4.1): organizations, provider entities, service locations.
// Platform-vs-tenant scoping, org binding, immutable regulatory identity, the tax-id cipher fail-closed, the
// location -> provider-entity ownership wall, lifecycle edges, audit.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  createContextActorResolver,
  createInMemoryAuditExecutor,
} from "../src/modules/02-identity/index";
import {
  type ProviderEntityDetail,
  createInMemoryOrgAdminStore,
} from "../src/modules/02-identity/org-admin-store";
import { isValidNpi } from "../src/modules/02-identity/org-admin-validation";
import { registerOrgAdminRoutes } from "../src/modules/02-identity/routes/org-admin-routes";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.sessionId = "sess";
  request.context.attributes.membershipId = `m_${user}`;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const TENANT = { "x-test-user": "admin_a", "x-test-org": "org_a", "x-test-roles": "org_admin" };
const PLATFORM = { "x-test-user": "ops_1", "x-test-org": "org_a", "x-test-roles": "platform_ops" };
const NOBODY = { "x-test-user": "nobody", "x-test-org": "org_a", "x-test-roles": "clinical_rn" };

const orgView = (id: string, name: string) => ({
  id,
  slug: id,
  legalName: `${name} LLC`,
  displayName: name,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const pe = (over: Partial<ProviderEntityDetail> & { id: string }): ProviderEntityDetail => ({
  organizationId: "org_a",
  ccn: "111111",
  legalName: "Desert Hospice",
  doingBusinessAs: null,
  fiscalIntermediary: null,
  npi: "1234567893",
  fiscalYearEnd: "1231",
  iqiesFacilityId: null,
  billingAddress: null,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

function makeServer(opts: { cipher?: boolean | "throws" } = {}) {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      ["admin_a", "ops_1"].map((userId) => ({
        orgId: "org_a",
        userId,
        grants: [
          { roleKey: "org_admin", enabled: true, expiresAt: null, permissionKeys: ["org.manage"] },
        ],
      })),
    ).store,
  );
  registerAbacRegistry(
    createPredicateRegistry({
      organization_lifecycle_platform_ops: (ctx) => ctx.roles.includes("platform_ops"),
    }),
  );
  const store = createInMemoryOrgAdminStore({
    organizations: [orgView("org_a", "Alpha"), orgView("org_b", "Beta")],
    providerEntities: [
      pe({ id: "pe_a" }),
      pe({ id: "pe_b", organizationId: "org_b", ccn: "222222", npi: "1245319599" }),
      pe({ id: "pe_new", ccn: "333333", npi: "1003000126", status: "created" }),
    ],
  });
  const auditSink = createInMemoryAuditExecutor();
  const encrypted: { organizationId: string; providerEntityId: string; plaintext: string }[] = [];
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerOrgAdminRoutes(app, {
    actors: createContextActorResolver(),
    audit: auditSink.executor,
    store,
    ...(opts.cipher === false
      ? {}
      : {
          taxIdCipher: {
            async encrypt(input) {
              if (opts.cipher === "throws") throw new Error("TenantKeyMissing: org_secret");
              encrypted.push(input);
              return `enc:${input.plaintext}`;
            },
          },
        }),
  });
  return { app, store, auditSink, encrypted };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

const NEW_PE = {
  ccn: "444444",
  npi: "1679576722",
  legalName: "Sierra Hospice",
  taxId: "12-3456789",
  fiscalYearEnd: "0630",
};

describe("NPI check digit", () => {
  it("accepts a valid NPI and refuses a mistyped one", () => {
    expect(isValidNpi("1234567893")).toBe(true);
    expect(isValidNpi("1234567890")).toBe(false);
    expect(isValidNpi("123")).toBe(false);
  });
});

describe("organizations", () => {
  it("a tenant admin lists only their own org; a platform operator lists and searches all", async () => {
    const { app } = makeServer();
    const own = await app.inject({ method: "GET", url: "/api/v1/orgs", headers: TENANT });
    expect(own.json().items.map((o: { id: string }) => o.id)).toEqual(["org_a"]);
    const all = await app.inject({ method: "GET", url: "/api/v1/orgs?q=bet", headers: PLATFORM });
    expect(all.json().items.map((o: { id: string }) => o.id)).toEqual(["org_b"]);
    await app.close();
  });

  it("a tenant admin cannot read another org; org.manage is required", async () => {
    const { app } = makeServer();
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/orgs/org_b", headers: TENANT })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/orgs/org_b", headers: PLATFORM }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/orgs", headers: NOBODY })).statusCode,
    ).toBe(403);
    await app.close();
  });

  it("POST /orgs is platform-only, slugs are unique", async () => {
    const { app, auditSink } = makeServer();
    const body = { legalName: "Gamma Care LLC", displayName: "Gamma" };
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/orgs", headers: TENANT, payload: body }))
        .statusCode,
    ).toBe(403);
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/orgs",
      headers: PLATFORM,
      payload: body,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({
      displayName: "Gamma",
      status: "created",
      slug: "gamma-care-llc",
    });
    expect(auditSink.rows.some((r) => r.eventType === "m2.organization.created")).toBe(true);
    const dup = await app.inject({
      method: "POST",
      url: "/api/v1/orgs",
      headers: PLATFORM,
      payload: body,
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("SLUG_TAKEN");
    await app.close();
  });

  it("PATCH: a tenant admin edits the display name; the legal name is platform-only", async () => {
    const { app, auditSink } = makeServer();
    const ok = await app.inject({
      method: "PATCH",
      url: "/api/v1/orgs/org_a",
      headers: TENANT,
      payload: { displayName: "Alpha Hospice" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().displayName).toBe("Alpha Hospice");
    expect(auditSink.rows.some((r) => r.eventType === "m2.organization.updated")).toBe(true);
    const legal = await app.inject({
      method: "PATCH",
      url: "/api/v1/orgs/org_a",
      headers: TENANT,
      payload: { legalName: "Hijacked LLC" },
    });
    expect(legal.statusCode).toBe(403);
    const asPlatform = await app.inject({
      method: "PATCH",
      url: "/api/v1/orgs/org_b",
      headers: PLATFORM,
      payload: { legalName: "Beta Corporation" },
    });
    expect(asPlatform.statusCode).toBe(200);
    const empty = await app.inject({
      method: "PATCH",
      url: "/api/v1/orgs/org_a",
      headers: TENANT,
      payload: {},
    });
    expect(empty.statusCode).toBe(422);
    await app.close();
  });
});

describe("provider entities", () => {
  it("creates one: tax id enveloped by the cipher and never echoed back", async () => {
    const { app, store, encrypted, auditSink } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/provider-entities",
      headers: TENANT,
      payload: NEW_PE,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ccn: "444444", status: "created", organizationId: "org_a" });
    expect(JSON.stringify(res.json())).not.toMatch(/tax|123456789|enc:/i);
    // The EIN is sealed under THIS tenant's key, so the route must hand the cipher the caller's org.
    // ...and to THIS row: the AAD id is the id the store persisted, so the blob cannot be replayed onto another row.
    expect(encrypted).toEqual([
      { organizationId: "org_a", providerEntityId: res.json().id, plaintext: "123456789" },
    ]);
    expect(store.state.pes.get(res.json().id)?.organizationId).toBe("org_a");
    expect(auditSink.rows.some((r) => r.eventType === "m2.provider_entity.created")).toBe(true);
    await app.close();
  });

  it("with no tax-id cipher bound the create refuses 503 TAX_ID_CIPHER_UNBOUND (fail closed)", async () => {
    const { app, store } = makeServer({ cipher: false });
    const before = store.state.pes.size;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/provider-entities",
      headers: TENANT,
      payload: NEW_PE,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("TAX_ID_CIPHER_UNBOUND");
    expect(store.state.pes.size).toBe(before);
    await app.close();
  });

  it("a failing tenant key ring answers 503 TAX_ID_KEY_UNAVAILABLE without echoing the cause", async () => {
    const { app, store } = makeServer({ cipher: "throws" });
    const before = store.state.pes.size;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/provider-entities",
      headers: TENANT,
      payload: NEW_PE,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("TAX_ID_KEY_UNAVAILABLE");
    expect(res.body).not.toContain("org_secret");
    expect(store.state.pes.size).toBe(before);
    await app.close();
  });

  it.each([
    ["a mistyped NPI", { npi: "1234567890" }],
    ["a bad CCN", { ccn: "12" }],
    ["a malformed EIN", { taxId: "123" }],
    ["an impossible fiscal year end", { fiscalYearEnd: "1332" }],
  ])("refuses %s with 422", async (_l, patch) => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/provider-entities",
      headers: TENANT,
      payload: { ...NEW_PE, ...patch },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("a duplicate CCN or NPI is 409", async () => {
    const { app } = makeServer();
    const ccn = await app.inject({
      method: "POST",
      url: "/api/v1/provider-entities",
      headers: TENANT,
      payload: { ...NEW_PE, ccn: "111111" },
    });
    expect(ccn.statusCode).toBe(409);
    expect(ccn.json().error.code).toBe("CCN_TAKEN");
    await app.close();
  });

  it("PATCH edits names and lifecycle but never the CMS identity", async () => {
    const { app } = makeServer();
    const ok = await app.inject({
      method: "PATCH",
      url: "/api/v1/provider-entities/pe_new",
      headers: TENANT,
      payload: { doingBusinessAs: "Desert Sun", status: "active" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ doingBusinessAs: "Desert Sun", status: "active" });
    for (const field of ["ccn", "npi", "taxId", "fiscalYearEnd"]) {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/provider-entities/pe_a",
        headers: TENANT,
        payload: { [field]: "999999" },
      });
      expect(res.statusCode).toBe(422);
    }
    await app.close();
  });

  it("PATCH sets the billing address and reads it back; line2 is optional", async () => {
    const { app } = makeServer();
    const address = { line1: "1 Main St", city: "Portland", state: "OR", postalCode: "97201" };

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/provider-entities/pe_new",
      headers: TENANT,
      payload: { billingAddress: address },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().billingAddress).toEqual({ ...address, line2: null });
    const read = await app.inject({
      method: "GET",
      url: "/api/v1/provider-entities/pe_new",
      headers: TENANT,
    });
    expect(read.json().billingAddress).toMatchObject(address);
    await app.close();
  });

  it.each([
    ["a missing line1", { city: "Portland", state: "OR", postalCode: "97201" }],
    ["a lowercase state", { line1: "1 Main", city: "Portland", state: "or", postalCode: "97201" }],
    ["a bad postal code", { line1: "1 Main", city: "Portland", state: "OR", postalCode: "9720" }],
    [
      "a line1 over the X12 limit",
      { line1: "x".repeat(56), city: "Portland", state: "OR", postalCode: "97201" },
    ],
    [
      "a city over the X12 limit",
      { line1: "1 Main", city: "c".repeat(31), state: "OR", postalCode: "97201" },
    ],
  ])("PATCH refuses a billing address with %s", async (_name, billingAddress) => {
    const { app } = makeServer();

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/provider-entities/pe_new",
      headers: TENANT,
      payload: { billingAddress },
    });

    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("a closed provider entity cannot be reopened; created cannot jump to suspended", async () => {
    const { app } = makeServer();
    await app.inject({
      method: "PATCH",
      url: "/api/v1/provider-entities/pe_a",
      headers: TENANT,
      payload: { status: "closed" },
    });
    const reopen = await app.inject({
      method: "PATCH",
      url: "/api/v1/provider-entities/pe_a",
      headers: TENANT,
      payload: { status: "active" },
    });
    expect(reopen.statusCode).toBe(422);
    const skip = await app.inject({
      method: "PATCH",
      url: "/api/v1/provider-entities/pe_new",
      headers: TENANT,
      payload: { status: "suspended" },
    });
    expect(skip.statusCode).toBe(422);
    await app.close();
  });

  it("another org's provider entity is 404, never 403 (no existence oracle)", async () => {
    const { app } = makeServer();
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/provider-entities/pe_b", headers: TENANT }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/provider-entities/pe_b",
          headers: TENANT,
          payload: { legalName: "x" },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });
});

describe("locations", () => {
  const NEW_LOC = {
    providerEntityId: "pe_a",
    name: "Reno office",
    addressLine1: "1 Main St",
    city: "Reno",
    state: "NV",
    postalCode: "89501",
    timezone: "America/Los_Angeles",
  };

  it("creates a location under the org's own provider entity", async () => {
    const { app, auditSink } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/locations",
      headers: TENANT,
      payload: NEW_LOC,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: "Reno office", status: "created" });
    expect(auditSink.rows.some((r) => r.eventType === "m2.location.created")).toBe(true);
    await app.close();
  });

  it("a provider entity of another org is 404 — the ownership wall", async () => {
    const { app, store } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/locations",
      headers: TENANT,
      payload: { ...NEW_LOC, providerEntityId: "pe_b" },
    });
    expect(res.statusCode).toBe(404);
    expect(store.state.locs.size).toBe(0);
    await app.close();
  });

  it.each([
    ["a bad state", { state: "Nevada" }],
    ["a bad ZIP", { postalCode: "8950" }],
    ["a bad timezone", { timezone: "Mars/Olympus" }],
  ])("refuses %s with 422", async (_l, patch) => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/locations",
      headers: TENANT,
      payload: { ...NEW_LOC, ...patch },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("activation needs an active provider entity; the provider entity cannot be re-pointed", async () => {
    const { app } = makeServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/locations",
      headers: TENANT,
      payload: { ...NEW_LOC, providerEntityId: "pe_new" },
    });
    const id = created.json().id;
    const early = await app.inject({
      method: "PATCH",
      url: `/api/v1/locations/${id}`,
      headers: TENANT,
      payload: { status: "active" },
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("PROVIDER_ENTITY_NOT_ACTIVE");
    const move = await app.inject({
      method: "PATCH",
      url: `/api/v1/locations/${id}`,
      headers: TENANT,
      payload: { providerEntityId: "pe_a" },
    });
    expect(move.statusCode).toBe(422);
    const ok = await app.inject({
      method: "PATCH",
      url: `/api/v1/locations/${id}`,
      headers: TENANT,
      payload: { phone: "775-555-0100" },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });
});
