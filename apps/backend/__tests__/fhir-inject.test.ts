import { createHash } from "node:crypto";
// apps/backend/__tests__/fhir-inject.test.ts — M28 (FHIR Gateway) §4.1 route-inventory HTTP-layer smoke
// test (TASK-050A / TEST-001). Before this file, M28 had zero `app.inject()` coverage —
// `28-fhir/__tests__/m28-routes.test.ts` drives `registerFhirR4Routes` directly against a bare `Fastify()`
// instance (no auth middleware, no permission/ABAC chain), and `m28-abac.test.ts` unit-tests the six §4.7
// predicate functions in isolation. Neither ever calls `.inject()` through the FULL host
// (`buildServer()` + `mountM28Routes()`), so a mis-wired `requirePermission` key, a `requireAbac`
// predicate-name typo, or a schema drift on any of the twenty admin routes would be invisible to every
// existing M28 test. This file closes that gap for the whole §4.1 inventory (39 named routes + the
// generic FHIR-spec fallbacks, ~42 distinct Fastify route registrations across all five plugins mounted
// by `mountM28Routes`).
//
// TWO DISTINCT AUTH MECHANISMS, ONE FILE:
//   - The FHIR-spec bearer surface (R1-R22, `fhir-r4.routes.ts`) does NOT go through the WardenX
//     `requirePermission`/`requireAbac` chain — it resolves a `fhir_client_session` bearer token itself
//     and checks `scopesGranted` in the handler. Most of this file seeds bearer sessions directly into
//     the in-memory store's constructor and drives those routes with an `Authorization: Bearer <token>`
//     header instead of the `x-test-*` shim. The R3 block does NOT: it mints through the real endpoint
//     and then USES the minted token, because a mint whose product is never presented proves only that
//     the endpoint returned a string (F-035, #95).
//   - The admin console (R23-R39, four more route files) goes through the REAL Authorization Contract —
//     `requirePermission(key)` + `requireAbac(action, predicateName)` — exactly the `orders-routes.test.ts`
//     (M11-T06) pattern this file clones: `buildServer()` mounts the host, a header-auth shim populates
//     `request.context`, and a FRESH `createPredicateRegistry()` is seeded with M28's six §4.7 predicates
//     (`buildFhirGatewayAbacPredicates`, built over a small hand-rolled resolver wrapping the SAME
//     in-memory `FhirGatewayStore`) plus a permissive `step_up_recent` stub for R39's `requireStepUp` gate
//     (M3 owns that predicate; a fresh registry starts empty — the M14/M19 precedent for stubbing a
//     composed-but-not-owned predicate locally).
//
// KNOWN, DOCUMENTED (NOT FABRICATED) NON-2xx ROUTES — the posture is READ-ONLY US Core R4 with
// `fhir.write` OFF, and several routes are DESIGNED to answer something other than 2xx even for a
// fully-scoped, well-formed caller:
//   - R3 `/fhir/oauth2/token` is now REAL (F-035, #95). It used to answer 401 `invalid_client` for every
//     input, and this file asserted that as correct — which made it the test that certified the wall:
//     R4-R22 all begin with `resolveBearer`, a bearer is only obtainable at R3, so an endpoint that
//     could never mint one made the entire FHIR surface unreachable by construction. The block below
//     mints a token and then reads with it.
//   - R4 answers 503 `FHIR_READER_UNBOUND` in THIS harness, and that is the honest answer rather than a
//     regression: the M1 seam registry here has no `PatientReader` bound, so the deployment cannot
//     answer, and saying "not found" would be a claim about the tenant's data. Against a real boot the
//     same route returns the resource (`m28-fhir-gateway.live.test.ts`).
//   - A resource type this gateway does not serve answers 404 `not-supported`, never `not-found`.
//   - R12 (`CodeSystem/:system`), R14 (`ValueSet/:vs`) and the six forward-seam/Phase-2 resources
//     (Claim/ClaimResponse/ExplanationOfBenefit/ServiceRequest/QuestionnaireResponse/Location) answer 404.
//   - R17/R18 (`/fhir/r5/*`, `/fhir/r6/*`) answer 415 — those FHIR releases are not served at all.
// Every one of these is asserted as its REAL, current status code with an inline note — not skipped, not
// faked to 2xx.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";

import type { FhirReadDisclosureEnvelope } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer, registerSeam } from "../src/bootstrap/index";
import {
  type FhirGatewayAbacResolver,
  type FhirGatewayStore,
  M28_PERMISSION_KEY_LIST,
  buildFhirGatewayAbacPredicates,
  createInMemoryFhirGatewayStore,
  denyStubFhirGatewayAbacResolver,
  mountM28Routes,
} from "../src/modules/28-fhir/index";

// ── header-auth shim (the M11/M14/M19 precedent) ─────────────────────────────────────────────────────
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes.membershipId = membership;
  }
  if (request.headers["x-step-up"] === "fresh") {
    request.context.attributes.stepUpRecent = true;
  }
}

const ORG = "org_a";
const NOW = "2026-06-08T12:00:00.000Z";

// Memberships (distinct from userIds — the ADMIN routes stamp `actor.membershipId`, and M28's dual
// approval / ABAC ownership checks key on it, not on `userId`).
const MEMBER_ADMIN = "10000000-0000-4000-8000-000000000001";
const MEMBER_COMPLIANCE = "10000000-0000-4000-8000-000000000002";
const MEMBER_NOPERM = "10000000-0000-4000-8000-000000000003";

// Bearer-surface fixtures — seeded straight into the in-memory store's constructor (R3, the only
// HTTP-reachable "mint a session" route, is an intentional fail-closed stub — see file header).
const SESSION_CLIENT_ID = "20000000-0000-4000-8000-000000000001";
const SESSION_JTI = "20000000-0000-4000-8000-000000000002";
const FULL_CLIENT_ID = "20000000-0000-4000-8000-000000000003";
const LIMITED_CLIENT_ID = "20000000-0000-4000-8000-000000000004";

const PATIENT_AGGREGATE_ID = "30000000-0000-4000-8000-000000000001";

// The twelve §4.6 keys M28 contributes (`M28_CONTRIBUTED_PERMISSIONS`).
const ALL_M28_PERMISSIONS = [...M28_PERMISSION_KEY_LIST];
const PERMISSION_SEED = [
  { userId: "admin_1", permissions: ALL_M28_PERMISSIONS },
  { userId: "compliance_1", permissions: ["fhir.client.admin"] },
  { userId: "noperm_1", permissions: [] as string[] },
];

/**
 * A small hand-rolled `FhirGatewayAbacResolver` over the SAME in-memory `FhirGatewayStore` this file's
 * `makeServer()` builds. Only the three methods the admin routes actually bind
 * (`fhir_client_organization_scope`, `fhir_inbound_owner_module_match`, `bulk_export_initiator_or_admin`)
 * are implemented for real; the other three (`fhir_export_scope_satisfied`, `fhir_client_active`,
 * `fhir_export_recipient_authorized`) are REGISTERED but bound by no §4.1 route in Phase 1 (per
 * `abac-predicates.ts`'s own file header), so they stay on the deny-stub default.
 *
 * `holdsPermission` answers from a small membership→permission-set map local to this file — it is
 * DELIBERATELY independent of the M28 RBAC grant seed above: the permissions it resolves
 * (`patient.create`, `prescribing.history.reconcile`) belong to M5/M12, not M28, and the real Drizzle
 * resolver (`abac-resolver-drizzle.ts`) reads them from the platform's own effective-permission table —
 * this is the test-local stand-in for that read.
 */
function buildTestAbacResolver(
  store: FhirGatewayStore,
  orgId: string,
  membershipPermissions: ReadonlyMap<string, ReadonlySet<string>>,
): FhirGatewayAbacResolver {
  return {
    ...denyStubFhirGatewayAbacResolver,
    async clientOrgId(clientId) {
      const client = await store.getClient(orgId, clientId);
      return client ? orgId : null;
    },
    async inboundOwnerModule(org, proposalId) {
      const proposal = await store.getProposal(org, proposalId);
      return proposal ? proposal.ownerModule : null;
    },
    async holdsPermission(_org, membershipId, key) {
      return membershipPermissions.get(membershipId)?.has(key) ?? false;
    },
    async loadBulkExportJob(org, jobId) {
      const job = await store.getJob(org, jobId);
      if (!job) return null;
      return {
        jobId: job.id,
        organizationId: org,
        clientId: job.clientId,
        initiatedByMembershipId: job.initiatedByMembershipId,
      };
    },
  };
}

/** The api-key client R3 mints for. Its secret lives only here and as a sha256 digest in the store. */
const API_KEY_CLIENT_ID = "aaaaaaaa-0000-4000-8000-00000000f1f1";
const API_KEY_SECRET = "s".repeat(48);
const API_KEY_DIGEST = createHash("sha256").update(API_KEY_SECRET, "utf8").digest("hex");

interface MakeServerOptions {
  readonly tokenEndpointUrl?: string;
  readonly disclosureSink?: FhirReadDisclosureEnvelope[];
}

function makeServer(options: MakeServerOptions = {}) {
  const store = createInMemoryFhirGatewayStore({
    now: () => NOW,
    ...(options.disclosureSink ? { disclosureSink: options.disclosureSink } : {}),
    clients: [
      { id: SESSION_CLIENT_ID, organizationId: ORG, name: "Session Test Client" },
      { id: FULL_CLIENT_ID, organizationId: ORG, name: "Full Scope Bearer Client" },
      { id: LIMITED_CLIENT_ID, organizationId: ORG, name: "Limited Scope Bearer Client" },
      {
        id: API_KEY_CLIENT_ID,
        organizationId: ORG,
        name: "Api Key Client",
        type: "api_key",
        status: "active",
        allowedScopes: ["system/Patient.read", "system/Encounter.read"],
        secretDigests: [API_KEY_DIGEST],
      },
    ],
    sessions: [
      {
        jti: SESSION_JTI,
        clientId: SESSION_CLIENT_ID,
        organizationId: ORG,
        token: "tok-session-test",
        scopesGranted: ["system/Patient.read"],
      },
      {
        clientId: FULL_CLIENT_ID,
        organizationId: ORG,
        token: "tok-full",
        // A wildcard read grant plus two write scopes (Phase-1 write scopes do not exist in
        // `FHIR_SUPPORTED_SCOPES` — the admin `POST /clients` route rejects them at registration time via
        // `unsupportedScopes()` — but a SESSION's `scopesGranted` is not re-validated against that closed
        // set at bearer-resolution time, so seeding one directly here is the only way to exercise R16's
        // write-scope check at all in Phase 1).
        scopesGranted: [
          "system/*.read",
          "system/Patient.write",
          "system/MedicationStatement.write",
        ],
      },
      {
        clientId: LIMITED_CLIENT_ID,
        organizationId: ORG,
        token: "tok-limited",
        scopesGranted: ["system/Patient.read"],
      },
    ],
  });

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);

  const membershipPermissions = new Map<string, ReadonlySet<string>>([
    [MEMBER_ADMIN, new Set(["patient.create", "prescribing.history.reconcile"])],
  ]);
  const resolver = buildTestAbacResolver(store, ORG, membershipPermissions);

  // A FRESH predicate registry per server (the M11-T06 precedent — the shared registry would otherwise
  // persist a predicate closed over a prior test's store across the file).
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(buildFhirGatewayAbacPredicates({ resolver }))) {
    reg.register(name, predicate);
  }
  // `step_up_recent` is M3's predicate (composed by R39 via `requireStepUp`, not owned by M28); a fresh
  // registry starts without it, so a permissive test-local stand-in is registered here (the M14/M19
  // precedent for a composed-but-foreign predicate).
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM28Routes(app, {
    store,
    now: () => NOW,
    ...(options.tokenEndpointUrl ? { tokenEndpointUrl: options.tokenEndpointUrl } : {}),
  });
  return { app, store };
}

const SUPER = {
  "x-test-user": "admin_1",
  "x-test-org": ORG,
  "x-test-roles": "org_admin",
  "x-test-membership": MEMBER_ADMIN,
};
const SUPER_STEPUP = { ...SUPER, "x-step-up": "fresh" };
const COMPLIANCE = {
  "x-test-user": "compliance_1",
  "x-test-org": ORG,
  "x-test-roles": "compliance_officer",
  "x-test-membership": MEMBER_COMPLIANCE,
};
const NOPERM = {
  "x-test-user": "noperm_1",
  "x-test-org": ORG,
  "x-test-roles": "none",
  "x-test-membership": MEMBER_NOPERM,
};

const BEARER_FULL = { authorization: "Bearer tok-full" };
const BEARER_LIMITED = { authorization: "Bearer tok-limited" };

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

// ── auth gating — one 401 / one 403 / one 422 on EACH of the two auth mechanisms this module has ───────
describe("M28-fhir-inject — auth gating", () => {
  it("admin surface: no auth headers at all → 401 (route: GET /api/v1/fhir/clients)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/fhir/clients" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("admin surface: authenticated actor holding NO permissions → 403 (route: POST /api/v1/fhir/clients, requires fhir.client.admin)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/fhir/clients",
      headers: NOPERM,
      payload: {
        name: "x",
        type: "api_key",
        allowedScopes: ["system/Patient.read"],
        tier: "tier-2",
        baaContractReference: "baa",
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("admin surface: a correctly-permissioned actor with an empty body → 422 VALIDATION_FAILED (route: PUT /api/v1/fhir/config)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/fhir/config",
      headers: SUPER,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    await app.close();
  });

  it("FHIR-spec bearer surface: no Authorization header → 401 OperationOutcome (route: GET /fhir/r4/Patient/:id)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/fhir/r4/Patient/p1" });
    expect(res.statusCode).toBe(401);
    expect(res.json().resourceType).toBe("OperationOutcome");
    await app.close();
  });

  it("FHIR-spec bearer surface: a bearer whose granted scopes exclude the resource → 403 FHIR_SCOPE_DENIED (route: GET /fhir/r4/Encounter/:id)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/fhir/r4/Encounter/e1",
      headers: BEARER_LIMITED,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().issue[0].code).toBe("forbidden");
    await app.close();
  });

  it("FHIR-spec bearer surface: an empty token-mint body → 422 VALIDATION_FAILED (route: POST /fhir/oauth2/token)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "POST", url: "/fhir/oauth2/token", payload: {} });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    await app.close();
  });
});

// ── R1/R2 — anonymous discovery ──────────────────────────────────────────────────────────────────────
describe("M28-fhir-inject — R1/R2: anonymous discovery", () => {
  it("GET /fhir/r4/metadata → 200 CapabilityStatement", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/fhir/r4/metadata" });
    expect(res.statusCode).toBe(200);
    expect(res.json().resourceType).toBe("CapabilityStatement");
    await app.close();
  });

  it("GET /fhir/.well-known/smart-configuration → 200", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/fhir/.well-known/smart-configuration" });
    expect(res.statusCode).toBe(200);
    expect(res.json().token_endpoint).toBe("/fhir/oauth2/token");
    await app.close();
  });
});

// ── R3 — token mint: well-formed body still fails CLOSED (documented Phase-1 posture, not a bug) ───────
describe("M28-fhir-inject — R3: token mint", () => {
  const TOKEN_URL = "https://fhir.wardenx.test/fhir/oauth2/token";

  it("mints for a valid api key, and the minted token is accepted as a bearer", async () => {
    // The assertion that matters. A mint whose product is never presented proves the endpoint returned
    // a string; this proves the string is a credential — which is exactly what the previous
    // unconditional `invalid_client` made impossible for any input (F-035, #95).
    const { app } = makeServer({ tokenEndpointUrl: TOKEN_URL });
    const minted = await app.inject({
      method: "POST",
      url: "/fhir/oauth2/token",
      payload: {
        grant_type: "client_credentials",
        scope: "system/Patient.read",
        client_id: API_KEY_CLIENT_ID,
        client_secret: API_KEY_SECRET,
      },
    });
    expect(minted.statusCode).toBe(200);
    const grant = minted.json();
    expect(grant.token_type).toBe("bearer");
    expect(grant.scope).toBe("system/Patient.read");
    expect(typeof grant.access_token).toBe("string");

    const used = await app.inject({
      method: "GET",
      url: "/fhir/r4/Patient",
      headers: { authorization: `Bearer ${grant.access_token}` },
    });
    // 200 — the bearer resolved, the scope check passed, and the search ran. (It finds nothing: this
    // harness binds no PatientReader, and a Patient search with no `_id`/`identifier` matches nothing
    // by design.) A 401 here would mean the mint produced a token the gateway does not recognise.
    expect(used.statusCode).toBe(200);
    expect(used.json().resourceType).toBe("Bundle");
    await app.close();
  });

  it("refuses a scope beyond the client's grant with invalid_scope, NAMING the scope (§2.3)", async () => {
    // The one failure that is deliberately specific. §2.3 forbids a silent down-scope, so the partner
    // has to be told which scope was refused — and knowing it already requires holding the credential.
    const { app } = makeServer({ tokenEndpointUrl: TOKEN_URL });
    const res = await app.inject({
      method: "POST",
      url: "/fhir/oauth2/token",
      payload: {
        grant_type: "client_credentials",
        scope: "system/Patient.read system/Condition.read",
        client_id: API_KEY_CLIENT_ID,
        client_secret: API_KEY_SECRET,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_scope");
    expect(res.json().error_description).toContain("system/Condition.read");
    await app.close();
  });

  it("refuses a wrong secret and an unknown client with the SAME generic invalid_client", async () => {
    // Byte-identical bodies on purpose: a description that distinguished them would turn an
    // unauthenticated endpoint into a client-id oracle.
    const { app } = makeServer({ tokenEndpointUrl: TOKEN_URL });
    const wrongSecret = await app.inject({
      method: "POST",
      url: "/fhir/oauth2/token",
      payload: {
        grant_type: "client_credentials",
        scope: "system/Patient.read",
        client_id: API_KEY_CLIENT_ID,
        client_secret: "not-the-secret",
      },
    });
    const unknownClient = await app.inject({
      method: "POST",
      url: "/fhir/oauth2/token",
      payload: {
        grant_type: "client_credentials",
        scope: "system/Patient.read",
        client_id: "aaaaaaaa-0000-4000-8000-0000000000ff",
        client_secret: API_KEY_SECRET,
      },
    });
    expect(wrongSecret.statusCode).toBe(401);
    expect(unknownClient.statusCode).toBe(401);
    expect(wrongSecret.json()).toEqual(unknownClient.json());
    expect(wrongSecret.json().error).toBe("invalid_client");
    await app.close();
  });

  it("refuses the SMART assertion path with 503, not 401, when the deployment has no token-endpoint URL", async () => {
    // A deployment fault reported as a credential fault sends the partner to debug a key that is fine.
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/fhir/oauth2/token",
      payload: {
        grant_type: "client_credentials",
        scope: "system/Patient.read",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: "x".repeat(64),
      },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("temporarily_unavailable");
    await app.close();
  });

  it("refuses an unverifiable assertion with invalid_client once the audience IS configured", async () => {
    const { app } = makeServer({ tokenEndpointUrl: TOKEN_URL });
    const res = await app.inject({
      method: "POST",
      url: "/fhir/oauth2/token",
      payload: {
        grant_type: "client_credentials",
        scope: "system/Patient.read",
        client_id: API_KEY_CLIENT_ID,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: "x".repeat(64),
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_client");
    await app.close();
  });
});

// ── forward-seam + Phase-2 resources — always 404, no bearer required (documented, not a gap) ───────────
describe("M28-fhir-inject — forward-seam / Phase-2 resources: 404 before any reader, no auth needed", () => {
  it.each([
    "Claim",
    "ClaimResponse",
    "ExplanationOfBenefit",
    "ServiceRequest",
    "QuestionnaireResponse",
    "Location",
  ])("GET /fhir/r4/%s/:id → 404 OperationOutcome", async (resource) => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: `/fhir/r4/${resource}/x` });
    expect(res.statusCode).toBe(404);
    expect(res.json().resourceType).toBe("OperationOutcome");
    await app.close();
  });
});

// ── R4/R5/R6 — resource read / search / $everything ──────────────────────────────────────────────────
describe("M28-fhir-inject — R4/R5/R6: resource read, search, $everything", () => {
  it("GET /fhir/r4/Patient/:id → 503 FHIR_READER_UNBOUND when M5's reader seam is not bound", async () => {
    // This harness registers no `PatientReader`, so the M1 deny-stub throws. 503 says "this DEPLOYMENT
    // cannot answer"; the 404 `not-found` this route used to return said "your patient has no such
    // record", which is a claim about the tenant's data and was false for every id ever requested.
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/fhir/r4/Patient/patient-1",
      headers: BEARER_FULL,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().issue[0].details.coding[0].code).toBe("FHIR_READER_UNBOUND");
    await app.close();
  });

  it("GET /fhir/r4/Condition/:id → 404 not-supported, NOT not-found", async () => {
    // Condition is not served (no reader seam exists for it anywhere), so the gateway says so about
    // ITSELF. The CapabilityStatement no longer advertises it either — the two read one list.
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/fhir/r4/Condition/cond-1",
      headers: BEARER_FULL,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().issue[0].code).toBe("not-supported");
    await app.close();
  });

  it("GET /fhir/r4/Encounter/:id → 404 not-supported: Encounter is search-only, and says which", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/fhir/r4/Encounter/enc-1",
      headers: BEARER_FULL,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().issue[0].code).toBe("not-supported");
    expect(res.json().issue[0].diagnostics).toContain("search only");
    await app.close();
  });

  it("GET /fhir/r4/Patient → 200 empty searchset Bundle (a search naming no patient matches nothing)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/fhir/r4/Patient", headers: BEARER_FULL });
    expect(res.statusCode).toBe(200);
    expect(res.json().resourceType).toBe("Bundle");
    expect(res.json().type).toBe("searchset");
    await app.close();
  });

  it("a search that matched nothing writes NO §164.528 accounting row", async () => {
    // §164.528 accounts for DISCLOSURES, not for requests. A ledger that grew on every unmatched search
    // would report disclosures that never happened, to patients who were never disclosed.
    const disclosures: FhirReadDisclosureEnvelope[] = [];
    const { app } = makeServer({ disclosureSink: disclosures });
    const res = await app.inject({ method: "GET", url: "/fhir/r4/Patient", headers: BEARER_FULL });
    expect(res.statusCode).toBe(200);
    expect(disclosures).toHaveLength(0);
    await app.close();
  });

  it("GET /fhir/r4/Patient/:id/$everything → 200 Bundle; an unbound type degrades to an advisory, not a 503", async () => {
    // `$everything` is a compilation. Refusing the whole Bundle because one owner module's seam is
    // unbound would hide the types that ARE readable, so each unavailable type contributes an
    // `OperationOutcome` entry the consumer can see instead of a silent gap.
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/fhir/r4/Patient/patient-1/$everything",
      headers: BEARER_FULL,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resourceType).toBe("Bundle");
    const outcomes = (res.json().entry as { resource: { resourceType: string } }[]).filter(
      (e) => e.resource.resourceType === "OperationOutcome",
    );
    expect(outcomes.length).toBeGreaterThan(0);
    await app.close();
  });
});

// ── R7/R8/R9/R10/R11 — bulk $export lifecycle ────────────────────────────────────────────────────────
describe("M28-fhir-inject — R7-R11: bulk $export lifecycle", () => {
  it("system/patient/group $export all accept (202); poll shows accepted (202); cancel accepts (202)", async () => {
    const { app } = makeServer();

    const systemExport = await app.inject({
      method: "POST",
      url: "/fhir/r4/$export",
      headers: BEARER_FULL,
    });
    expect(systemExport.statusCode).toBe(202);
    const contentLocation = systemExport.headers["content-location"] as string;
    const jobId = contentLocation.split("/").pop() as string;

    const patientExport = await app.inject({
      method: "POST",
      url: "/fhir/r4/Patient/$export",
      headers: BEARER_FULL,
    });
    expect(patientExport.statusCode).toBe(202);

    const groupExport = await app.inject({
      method: "POST",
      url: "/fhir/r4/Group/g1/$export",
      headers: BEARER_FULL,
    });
    expect(groupExport.statusCode).toBe(202);

    const poll = await app.inject({
      method: "GET",
      url: `/fhir/r4/$export-poll-status/${jobId}`,
      headers: BEARER_FULL,
    });
    expect(poll.statusCode).toBe(202);
    expect(poll.json().status).toBe("accepted");

    const cancel = await app.inject({
      method: "DELETE",
      url: `/fhir/r4/$export-poll-status/${jobId}`,
      headers: BEARER_FULL,
    });
    expect(cancel.statusCode).toBe(202);
    expect(cancel.json().resourceType).toBe("OperationOutcome");

    await app.close();
  });
});

// ── R12-R15 — CodeSystem / ValueSet ──────────────────────────────────────────────────────────────────
describe("M28-fhir-inject — R12-R15: CodeSystem / ValueSet", () => {
  it("GET /fhir/r4/CodeSystem/:system → 404 not-supported (Phase-1 posture, not a gap)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/fhir/r4/CodeSystem/loinc",
      headers: BEARER_FULL,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().issue[0].code).toBe("not-supported");
    await app.close();
  });

  // R13 used to answer `result: false` for every request WITHOUT reading its Parameters (#117) — a wrong
  // answer, not a stub: `false` means "that code is not valid in that system", so a conformant client
  // acting on it rejects perfectly good codes. It now resolves the caller's system + code through M38's
  // live `TerminologyProvider`. These tests stand up a fake provider so the four answers are separable.
  const withTerminology = (
    valid: (system: string, code: string) => boolean | { valid: boolean; status?: string },
  ): void => {
    registerSeam("TerminologyProvider", {
      async validate(system: string, code: string) {
        const v = valid(system, code);
        return typeof v === "boolean" ? { valid: v } : v;
      },
    } as never);
  };

  it("POST $validate-code resolves the canonical URI to M38's code-system id and answers from it", async () => {
    const seen: { system: string; code: string }[] = [];
    withTerminology((system, code) => {
      seen.push({ system, code });
      return code === "R52";
    });
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/fhir/r4/CodeSystem/$validate-code",
      headers: BEARER_FULL,
      payload: {
        resourceType: "Parameters",
        parameter: [
          { name: "url", valueUri: "http://hl7.org/fhir/sid/icd-10-cm" },
          { name: "code", valueCode: "R52" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resourceType).toBe("Parameters");
    expect(res.json().parameter).toContainEqual({ name: "result", valueBoolean: true });
    // The FHIR canonical became M38's id — the join the route exists to make.
    expect(seen).toEqual([{ system: "icd10cm", code: "R52" }]);
    await app.close();
  });

  it("POST $validate-code answers false for a code the provider rejects, with a message naming it", async () => {
    withTerminology(() => false);
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/fhir/r4/CodeSystem/$validate-code",
      headers: BEARER_FULL,
      payload: {
        resourceType: "Parameters",
        parameter: [
          { name: "url", valueUri: "http://loinc.org" },
          { name: "code", valueCode: "not-a-loinc" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().parameter).toContainEqual({ name: "result", valueBoolean: false });
    expect(JSON.stringify(res.json())).toContain("not-a-loinc");
    await app.close();
  });

  it("POST $validate-code refuses an empty Parameters instead of answering it (was: 200 result:false)", async () => {
    withTerminology(() => true);
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/fhir/r4/CodeSystem/$validate-code",
      headers: BEARER_FULL,
      payload: { resourceType: "Parameters", parameter: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issue[0].code).toBe("invalid");
    await app.close();
  });

  it("POST $validate-code says not-supported for a code system this server does not serve", async () => {
    withTerminology(() => true);
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/fhir/r4/CodeSystem/$validate-code",
      headers: BEARER_FULL,
      payload: {
        resourceType: "Parameters",
        parameter: [
          { name: "url", valueUri: "http://example.org/some-local-codes" },
          { name: "code", valueCode: "X" },
        ],
      },
    });
    // Not `result: false` — this server cannot answer the question, which is a different thing from
    // answering it "no".
    expect(res.statusCode).toBe(404);
    expect(res.json().issue[0].code).toBe("not-supported");
    await app.close();
  });

  it("GET /fhir/r4/ValueSet/:vs → 404 not-supported (Phase-1 posture, not a gap)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/fhir/r4/ValueSet/some-vs",
      headers: BEARER_FULL,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().issue[0].code).toBe("not-supported");
    await app.close();
  });

  it("GET /fhir/r4/ValueSet/:vs/$expand → 200 ValueSet", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/fhir/r4/ValueSet/some-vs/$expand",
      headers: BEARER_FULL,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resourceType).toBe("ValueSet");
    await app.close();
  });
});

// ── R16 — inbound staging (write scope) ──────────────────────────────────────────────────────────────
describe("M28-fhir-inject — R16: inbound staging", () => {
  it("POST /fhir/r4/Patient with a write-scoped bearer → 202 staged", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/fhir/r4/Patient",
      headers: BEARER_FULL,
      payload: { resourceType: "Patient", name: [{ family: "Doe" }] },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().resourceType).toBe("OperationOutcome");
    await app.close();
  });
});

// ── R17/R18 — FHIR R5/R6 unsupported ─────────────────────────────────────────────────────────────────
describe("M28-fhir-inject — R17/R18: FHIR R5/R6 unsupported", () => {
  it("GET /fhir/r5/Patient/1 → 415", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/fhir/r5/Patient/1" });
    expect(res.statusCode).toBe(415);
    await app.close();
  });

  it("GET /fhir/r6/Patient/1 → 415", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/fhir/r6/Patient/1" });
    expect(res.statusCode).toBe(415);
    await app.close();
  });
});

// ── R23-R30 — admin: client registry lifecycle ───────────────────────────────────────────────────────
describe("M28-fhir-inject — admin: client registry (R23-R30)", () => {
  it("R23/R24/R25/R28/R27/R26 — list, propose, co-approve, rotate, suspend, revoke, walked on one client", async () => {
    const { app } = makeServer();

    // Four fixture clients are seeded in `makeServer()` — three bearer fixtures (session/full/limited)
    // plus the api-key client R3 mints for; R23 must see all of them (org-scoped list), not an empty
    // result.
    const list0 = await app.inject({ method: "GET", url: "/api/v1/fhir/clients", headers: SUPER });
    expect(list0.statusCode).toBe(200);
    expect(list0.json().clients).toHaveLength(4);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/fhir/clients",
      headers: SUPER,
      payload: {
        name: "Partner EHR Co",
        type: "api_key",
        allowedScopes: ["system/Patient.read", "system/MedicationStatement.read"],
        tier: "tier-2",
        baaContractReference: "baa-ref-001",
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().client.status).toBe("pending_approval");
    expect(create.json().plaintextSecret).toBeTypeOf("string");
    const clientId = create.json().client.id as string;

    // R25 — a DISTINCT compliance membership co-approves (D12 dual approval).
    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/fhir/clients/${clientId}/approve`,
      headers: COMPLIANCE,
      payload: { rationale: "BAA verified and scopes reviewed for this partner integration." },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe("active");

    const rotate = await app.inject({
      method: "POST",
      url: `/api/v1/fhir/clients/${clientId}/credentials/rotate`,
      headers: SUPER,
    });
    expect(rotate.statusCode).toBe(200);
    expect(rotate.json().plaintextSecret).toBeTypeOf("string");

    const suspend = await app.inject({
      method: "POST",
      url: `/api/v1/fhir/clients/${clientId}/suspend`,
      headers: SUPER,
      payload: { reason: "rate-limit violation under review" },
    });
    expect(suspend.statusCode).toBe(200);
    expect(suspend.json().client.status).toBe("suspended");

    const revoke = await app.inject({
      method: "POST",
      url: `/api/v1/fhir/clients/${clientId}/revoke`,
      headers: SUPER,
      payload: {
        rationale: "the partner organization was offboarded at the end of its contract term.",
      },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().client.status).toBe("revoked");

    await app.close();
  });

  it("R29/R30 — lists a seeded client's sessions and revokes one by jti", async () => {
    const { app } = makeServer();

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/fhir/clients/${SESSION_CLIENT_ID}/sessions`,
      headers: SUPER,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().sessions).toHaveLength(1);
    expect(list.json().sessions[0].jti).toBe(SESSION_JTI);

    const revokeSession = await app.inject({
      method: "POST",
      url: `/api/v1/fhir/clients/${SESSION_CLIENT_ID}/sessions/${SESSION_JTI}/revoke`,
      headers: SUPER,
    });
    expect(revokeSession.statusCode).toBe(200);
    expect(revokeSession.json().revoked).toBe(true);

    await app.close();
  });
});

// ── R31-R33 — admin: bulk export jobs ────────────────────────────────────────────────────────────────
describe("M28-fhir-inject — admin: bulk export jobs (R31-R33)", () => {
  it("initiates a job, lists it, and the initiator cancels it", async () => {
    const { app } = makeServer();

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/fhir/bulk-export-jobs",
      headers: SUPER,
      payload: { clientId: FULL_CLIENT_ID, requestKind: "system", resourceTypes: ["Patient"] },
    });
    expect(create.statusCode).toBe(202);
    const jobId = create.json().id as string;
    expect(create.json().initiatedByMembershipId).toBe(MEMBER_ADMIN);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/fhir/bulk-export-jobs",
      headers: SUPER,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().jobs.map((j: { id: string }) => j.id)).toContain(jobId);

    // `bulk_export_initiator_or_admin` — SUPER is the job's own initiator, so the ABAC gate passes on
    // that arm alone (no `holdsPermission` lookup needed).
    const cancel = await app.inject({
      method: "POST",
      url: `/api/v1/fhir/bulk-export-jobs/${jobId}/cancel`,
      headers: SUPER,
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe("cancelled");

    await app.close();
  });
});

// ── R34-R36 — admin: inbound proposal review ─────────────────────────────────────────────────────────
describe("M28-fhir-inject — admin: inbound proposal review (R34-R36)", () => {
  it("lists, accepts an m5 (Patient) proposal, and rejects an m12 (MedicationStatement) proposal", async () => {
    const { app, store } = makeServer();

    // Seeded directly on the store (not via R16 HTTP) so the id is known up front rather than parsed out
    // of an OperationOutcome diagnostics string — R16's own 2xx is already proven above.
    const patientProposal = await store.stageInbound(ORG, {
      sourceClientId: FULL_CLIENT_ID,
      resourceType: "Patient",
      sourceFhirId: null,
      payload: { resourceType: "Patient", name: [{ family: "Doe" }] },
    });
    const medProposal = await store.stageInbound(ORG, {
      sourceClientId: FULL_CLIENT_ID,
      resourceType: "MedicationStatement",
      sourceFhirId: null,
      payload: { resourceType: "MedicationStatement", status: "active" },
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/fhir/inbound-proposals",
      headers: SUPER,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().proposals).toHaveLength(2);

    // `fhir_inbound_owner_module_match` — MEMBER_ADMIN holds `patient.create` (m5's write permission) in
    // the test-local ABAC resolver map, so accepting the Patient (m5-owned) proposal passes.
    const accept = await app.inject({
      method: "POST",
      url: `/api/v1/fhir/inbound-proposals/${patientProposal.id}/accept`,
      headers: SUPER,
      payload: { acceptedAggregateId: PATIENT_AGGREGATE_ID },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().proposalStatus).toBe("accepted");

    // Same actor also holds `prescribing.history.reconcile` (m12's write permission), so rejecting the
    // MedicationStatement (m12-owned) proposal passes the SAME predicate on its other owner-module arm.
    const reject = await app.inject({
      method: "POST",
      url: `/api/v1/fhir/inbound-proposals/${medProposal.id}/reject`,
      headers: SUPER,
      payload: {
        rationale: "the reconciled medication history already reflects this entry accurately.",
      },
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json().proposalStatus).toBe("rejected");

    await app.close();
  });
});

// ── R37-R39 — admin: tenant FHIR config ──────────────────────────────────────────────────────────────
describe("M28-fhir-inject — admin: tenant config (R37-R39)", () => {
  it("reads null before any write, writes, then rotates the cursor key under step-up", async () => {
    const { app } = makeServer();

    const read0 = await app.inject({ method: "GET", url: "/api/v1/fhir/config", headers: SUPER });
    expect(read0.statusCode).toBe(200);
    expect(read0.json().config).toBeNull();

    const write = await app.inject({
      method: "PUT",
      url: "/api/v1/fhir/config",
      headers: SUPER,
      payload: {
        tenantFhirHost: "fhir.partner.example.org",
        identifierUriBase: "https://wardenx.example/fhir",
      },
    });
    expect(write.statusCode).toBe(200);
    expect(write.json().tenantFhirHost).toBe("fhir.partner.example.org");
    const fingerprintBefore = write.json().cursorKeyFingerprint as string;

    const rotate = await app.inject({
      method: "POST",
      url: "/api/v1/fhir/config/rotate-cursor-key",
      headers: SUPER_STEPUP,
    });
    expect(rotate.statusCode).toBe(200);
    expect(rotate.json().fingerprint).not.toBe(fingerprintBefore);

    await app.close();
  });

  it("R39 without a fresh step-up is refused (403) even for a fully-permissioned actor — the gate holds independently of the permission grant", async () => {
    const { app } = makeServer();
    await app.inject({
      method: "PUT",
      url: "/api/v1/fhir/config",
      headers: SUPER,
      payload: {
        tenantFhirHost: "fhir.partner.example.org",
        identifierUriBase: "https://wardenx.example/fhir",
      },
    });
    const rotate = await app.inject({
      method: "POST",
      url: "/api/v1/fhir/config/rotate-cursor-key",
      headers: SUPER,
    });
    expect(rotate.statusCode).toBe(403);
    await app.close();
  });
});
