// apps/backend/__tests__/terminology-routes.test.ts — M38-T06 terminology route-inventory
// integration tests (M38 spec §4.1–4.2; §4.4 permission handshake; §7.4 canonical lockdown).
//
// Exercises M38's routes through the FULL M1 middleware chain via Fastify `inject` with no live
// infra: buildServer() mounts the foundation host, registerTerminologyRoutes() mounts the §4.1
// inventory over the in-memory TerminologyProvider (@chartwarden/terminology) seeded with concepts /
// value-set members / a deprecation. The REAL Authorization Contract gates every route on the
// §4.4 keys (`terminology.read` / `terminology.value_set.extend`); a header-auth shim populates
// request.context. The §7.4 lockdown is proven structurally: NO route mutates a canonical table —
// the only write reachable is the org-scoped, add-only value-set extension.
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import {
  type ResolvedConcept,
  createInMemoryTerminologyStore,
  createTerminologyProvider,
} from "@chartwarden/terminology";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { registerTerminologyRoutes } from "../src/modules/38-terminology/index";

/** Test-only auth shim: populate request.context from headers (mirrors audit-routes.test). */
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const ORG = "org_a";
const VS = "hospice_terminal_diagnosis";

function seedConcepts(): ResolvedConcept<"icd10cm">[] {
  return [
    {
      systemId: "icd10cm",
      code: "I50.21",
      display: "Acute systolic (congestive) heart failure",
      status: "active",
      effectiveDate: "2020-01-01",
      endDate: null,
      properties: { isBillableLeaf: true, chapter: "IX", parentCode: "I50.2" },
    },
    {
      systemId: "icd10cm",
      code: "I50.20",
      display: "Unspecified systolic (congestive) heart failure",
      status: "deprecated",
      effectiveDate: "2019-01-01",
      endDate: null,
      properties: { isBillableLeaf: false, chapter: "IX", parentCode: "I50.2" },
    },
    {
      // I50.22 — active, open-ended, NOT a platform member: the valid tenant-extension target the
      // §7.6 happy-path test adds (the add-time gate at addTenantExtension requires an active code).
      systemId: "icd10cm",
      code: "I50.22",
      display: "Chronic systolic (congestive) heart failure",
      status: "active",
      effectiveDate: "2020-01-01",
      endDate: null,
      properties: { isBillableLeaf: true, chapter: "IX", parentCode: "I50.2" },
    },
  ];
}

const PERMISSION_SEED = [
  { userId: "rn_1", permissions: ["terminology.read"] }, // clinician: read only
  { userId: "coder_1", permissions: ["terminology.read", "terminology.value_set.extend"] }, // Coder
  { userId: "intern_1", permissions: ["patient.read"] }, // no terminology key
];

function makeServer(flags?: { forOrg(orgId: string): Promise<Record<string, boolean>> }) {
  const { store } = createInMemoryTerminologyStore({
    concepts: seedConcepts(),
    deprecations: [
      {
        system: "icd10cm",
        deprecatedCode: "I50.20",
        deprecationEffective: "2023-10-01",
        successorCodes: ["I50.21"],
        mappingKind: "narrower",
        guidance: "Use the systolic-specific code.",
      },
    ],
    valueSetMembers: [
      {
        valueSetId: VS,
        systemId: "icd10cm",
        code: "I50.21",
        display: "Acute systolic (congestive) heart failure",
        annotations: {},
      },
    ],
  });
  const provider = createTerminologyProvider(store);

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerTerminologyRoutes(app, { provider, flags });
  return app;
}

const CLINICIAN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "clinical_rn" };
const CODER = { "x-test-user": "coder_1", "x-test-org": ORG, "x-test-roles": "coder" };
const INTERN = { "x-test-user": "intern_1", "x-test-org": ORG, "x-test-roles": "intern" };

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("M38-T06 terminology route inventory", () => {
  describe("§4.4 terminology.read gate (the contract gates every read)", () => {
    it("unauthenticated → 401", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/icd10cm/validate?code=I50.21",
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("an actor without terminology.read → 403", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/icd10cm/validate?code=I50.21",
        headers: INTERN,
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  describe("§4.2 read surface (validate / lookup / search / deprecation)", () => {
    it("validate returns valid:true for an active code", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/icd10cm/validate?code=I50.21&asOf=2024-06-01",
        headers: CLINICIAN,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ valid: true, status: "active", asOf: "2024-06-01" });
      await app.close();
    });

    it("validate flags a deprecated code valid:true with its successor", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/icd10cm/validate?code=I50.20",
        headers: CLINICIAN,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.valid).toBe(true);
      expect(body.status).toBe("deprecated");
      expect(body.successor.successorCodes).toEqual(["I50.21"]);
      await app.close();
    });

    it("lookup returns the full concept; 404 for an unknown code", async () => {
      const app = makeServer();
      const ok = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/icd10cm/I50.21",
        headers: CLINICIAN,
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ systemId: "icd10cm", code: "I50.21" });

      const missing = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/icd10cm/X99.9",
        headers: CLINICIAN,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe("NOT_FOUND");
      await app.close();
    });

    it("an unknown / not-yet-licensed code system (cpt, §7.8) is rejected as malformed", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/cpt/validate?code=99213",
        headers: CLINICIAN,
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it("search returns matching concepts", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/icd10cm/search?q=systolic&mode=fuzzy",
        headers: CLINICIAN,
      });
      expect(res.statusCode).toBe(200);
      const codes = res.json().results.map((c: { code: string }) => c.code);
      expect(codes).toContain("I50.21");
      await app.close();
    });

    it("deprecation returns the successor mapping (or null)", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/icd10cm/I50.20/deprecation",
        headers: CLINICIAN,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().mapping.successorCodes).toEqual(["I50.21"]);
      await app.close();
    });
  });

  describe("§7.7 semantic search rides the ai.full flag (M38-T09)", () => {
    it("mode=semantic with no flag reader → FEATURE_NOT_ENABLED (403) in Phase 1", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/icd10cm/search?q=heart+failure&mode=semantic",
        headers: CLINICIAN,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FEATURE_NOT_ENABLED");
      await app.close();
    });

    it("mode=semantic with ai.full OFF for the org → FEATURE_NOT_ENABLED (403)", async () => {
      const app = makeServer({ forOrg: async () => ({ "ai.full": false }) });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/icd10cm/search?q=heart+failure&mode=semantic",
        headers: CLINICIAN,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FEATURE_NOT_ENABLED");
      await app.close();
    });

    it("mode=semantic with ai.full ON → 200 (capability unlocked, Phase 2)", async () => {
      const app = makeServer({ forOrg: async () => ({ "ai.full": true }) });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/icd10cm/search?q=systolic&mode=semantic",
        headers: CLINICIAN,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().mode).toBe("semantic");
      await app.close();
    });

    it("exact/fuzzy are never gated by the flag (default mode is fuzzy)", async () => {
      const app = makeServer(); // no flag reader at all
      const fuzzy = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/icd10cm/search?q=systolic",
        headers: CLINICIAN,
      });
      expect(fuzzy.statusCode).toBe(200);
      expect(fuzzy.json().mode).toBe("fuzzy");
      await app.close();
    });
  });

  describe("§4.2 value-set surface (expand / is-member)", () => {
    it("expand returns the platform members", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/terminology/value-sets/${VS}/expand`,
        headers: CLINICIAN,
      });
      expect(res.statusCode).toBe(200);
      const codes = res.json().items.map((m: { code: string }) => m.code);
      expect(codes).toContain("I50.21");
      await app.close();
    });

    it("is-member answers with provenance", async () => {
      const app = makeServer();
      const yes = await app.inject({
        method: "GET",
        url: `/api/v1/terminology/value-sets/${VS}/is-member?system=icd10cm&code=I50.21`,
        headers: CLINICIAN,
      });
      expect(yes.json()).toEqual({ isMember: true, source: "platform" });

      const no = await app.inject({
        method: "GET",
        url: `/api/v1/terminology/value-sets/${VS}/is-member?system=icd10cm&code=Z99.9`,
        headers: CLINICIAN,
      });
      expect(no.json()).toEqual({ isMember: false, source: null });
      await app.close();
    });
  });

  describe("§4.4 / §7.6 tenant value-set extension (the only tenant write)", () => {
    it("a reader without terminology.value_set.extend cannot add an extension → 403", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/terminology/value-sets/${VS}/extensions`,
        headers: CLINICIAN,
        payload: { system: "icd10cm", code: "I50.22", reason: "local clinical preference" },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("a Coder adds an extension (201), then it is visible as a tenant_extension member", async () => {
      const app = makeServer();
      const add = await app.inject({
        method: "POST",
        url: `/api/v1/terminology/value-sets/${VS}/extensions`,
        headers: CODER,
        payload: { system: "icd10cm", code: "I50.22", reason: "local clinical preference" },
      });
      expect(add.statusCode).toBe(201);
      expect(add.json()).toMatchObject({ valueSetId: VS, system: "icd10cm", code: "I50.22" });
      const extensionId = add.json().extensionId as string;
      expect(extensionId).toBeTruthy();

      const member = await app.inject({
        method: "GET",
        url: `/api/v1/terminology/value-sets/${VS}/is-member?system=icd10cm&code=I50.22`,
        headers: CODER,
      });
      expect(member.json()).toEqual({ isMember: true, source: "tenant_extension" });

      const del = await app.inject({
        method: "DELETE",
        url: `/api/v1/terminology/value-sets/${VS}/extensions/${extensionId}`,
        headers: CODER,
      });
      expect(del.statusCode).toBe(204);
      await app.close();
    });

    it("rejects an extension with too-short a reason (VALIDATION_FAILED)", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/terminology/value-sets/${VS}/extensions`,
        headers: CODER,
        payload: { system: "icd10cm", code: "I50.22", reason: "short" },
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it("§7.10 refuses adding a deprecated code → INVALID_CODE (422)", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/terminology/value-sets/${VS}/extensions`,
        headers: CODER,
        // I50.20 is deprecated — a tenant can't pin a code we know is being retired.
        payload: { system: "icd10cm", code: "I50.20", reason: "local clinical preference" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("INVALID_CODE");
      await app.close();
    });

    it("§7.10 refuses adding an unknown code → INVALID_CODE (422)", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/terminology/value-sets/${VS}/extensions`,
        headers: CODER,
        payload: { system: "icd10cm", code: "Z99.9", reason: "local clinical preference" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("INVALID_CODE");
      await app.close();
    });

    it("§7.10 refuses re-adding an existing platform member → REDUNDANT_EXTENSION (409)", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/terminology/value-sets/${VS}/extensions`,
        headers: CODER,
        // I50.21 is already a platform member of the value set — the add is a no-op conflict.
        payload: { system: "icd10cm", code: "I50.21", reason: "local clinical preference" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("REDUNDANT_EXTENSION");
      await app.close();
    });
  });

  describe("§7.4 tenants cannot write canonical (lockdown by route omission)", () => {
    it("no canonical-write route exists — concept create / admin load are not reachable", async () => {
      const app = makeServer();
      // The only mutating verb the inventory exposes targets the org-scoped extension table;
      // there is no POST/PUT to a per-system concept or to the canonical admin load surface here.
      const concept = await app.inject({
        method: "POST",
        url: "/api/v1/terminology/icd10cm/I99.9",
        headers: CODER,
        payload: { display: "forged concept" },
      });
      expect(concept.statusCode).toBe(404);

      const load = await app.inject({
        method: "POST",
        url: "/api/v1/admin/terminology/icd10cm/load",
        headers: CODER,
        payload: { version: "2025", sourceFileRef: "x", reauthToken: "y" },
      });
      expect(load.statusCode).toBe(404);
      await app.close();
    });
  });
});
