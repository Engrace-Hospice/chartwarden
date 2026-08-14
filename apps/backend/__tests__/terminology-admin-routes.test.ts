// apps/backend/__tests__/terminology-admin-routes.test.ts — GAP-063: the six §4.1 routes that had no
// registration anywhere in the app (value-set catalog, the §7.3 remediation report, and the four
// platform-ops `/api/v1/admin/terminology/*` routes).
//
// Runs them through the FULL M1 middleware chain via Fastify `inject` with no live infra: buildServer()
// hosts, the REAL Authorization Contract gates on the §4.4 keys, and a per-test FRESH predicate registry
// backs `requireAbac` (the shared `abacRegistry` is single-owner / no-clear, so a test that registered
// into it would bind every later test in the process — the GAP-011 finding).
//
// The interesting assertions are the ones a permission check alone would pass: an actor holding
// `terminology.admin.load` but NOT the `platform_ops` role is refused, because a permission key travels
// with whatever role template carries it and the §4.4 "platform-only" marking has to live somewhere else.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { CarePlanCodeUsageRecord } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type CodeUsageProducer,
  type TerminologyOpsSeed,
  buildTerminologyAbacPredicates,
  createInMemoryTerminologyOpsStore,
  createRemediationService,
  defaultRemediationSince,
  recommendedActionFor,
  registerAdminTerminologyRoutes,
} from "../src/modules/38-terminology/index";
import { registerTerminologyRoutes } from "../src/modules/38-terminology/routes/terminology-routes";

/** Test-only auth shim: populate request.context from headers (the terminology-routes.test shape). */
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const OPERATOR = "33333333-3333-4333-8333-333333333333";

const PERMISSION_SEED = [
  // The platform operator: holds both admin keys AND the platform_ops role.
  { userId: OPERATOR, permissions: ["terminology.admin.read", "terminology.admin.load"] },
  // A tenant admin who somehow acquired the admin keys but is NOT platform_ops — the case RBAC alone
  // cannot refuse.
  { userId: "tenant_admin_1", permissions: ["terminology.admin.read", "terminology.admin.load"] },
  { userId: "compliance_1", permissions: ["terminology.deprecation_report", "terminology.read"] },
  { userId: "rn_1", permissions: ["terminology.read"] },
];

const OPERATOR_H = {
  "x-test-user": OPERATOR,
  "x-test-org": ORG,
  "x-test-roles": "platform_ops",
};
const TENANT_ADMIN_H = {
  "x-test-user": "tenant_admin_1",
  "x-test-org": ORG,
  "x-test-roles": "org_admin",
};
const COMPLIANCE_H = { "x-test-user": "compliance_1", "x-test-org": ORG, "x-test-roles": "compliance" };
const RN_H = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "clinical_rn" };

/** A code-usage producer over a fixed row set — stands in for M7's problem-list reader. */
function fakeProducer(rows: readonly CarePlanCodeUsageRecord[]): CodeUsageProducer {
  return {
    recordType: "problem_list",
    usage: async (_org, codes) => {
      const wanted = new Set(codes.map((c) => `${c.systemId} ${c.code}`));
      return rows.filter((r) => wanted.has(`${r.systemId} ${r.code}`));
    },
  };
}

const DEPRECATIONS = [
  {
    systemId: "icd10cm" as const,
    deprecatedCode: "I50.20",
    deprecationEffective: "2026-01-01",
    successorCodes: ["I50.21"],
    mappingKind: "equivalent" as const,
    guidance: "Use the systolic-specific code.",
  },
  {
    systemId: "icd10cm" as const,
    deprecatedCode: "G30.0",
    deprecationEffective: "2026-01-01",
    successorCodes: ["G30.1", "G30.8"],
    mappingKind: "broader" as const,
    guidance: null,
  },
];

function makeServer(opts: {
  seed?: TerminologyOpsSeed;
  producer?: CodeUsageProducer;
  stepUpPasses?: boolean;
  now?: () => Date;
}) {
  const { store, registered, embeddingRequests } = createInMemoryTerminologyOpsStore(
    opts.seed ?? {},
  );

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);

  // A registry per test — never the shared one (see the header note).
  const registry = registerAbacRegistry(createPredicateRegistry());
  for (const [name, predicate] of Object.entries(buildTerminologyAbacPredicates())) {
    registry.register(name, predicate);
  }
  // `requireStepUp` is a thin `requireAbac(_, "step_up_recent")` whose real resolver reads M2's session
  // seam. Stubbed here so the step-up conjunct is independently switchable.
  registry.register("step_up_recent", async () => opts.stepUpPasses !== false);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  const remediation = createRemediationService({
    ops: store,
    producers: [opts.producer ?? fakeProducer([])],
    now: opts.now,
  });
  registerTerminologyRoutes(app, {
    // The read surface is exercised by terminology-routes.test; this file only needs the two GAP-063
    // tenant routes, so the provider is never called.
    provider: {} as never,
    ops: store,
    remediation,
  });
  registerAdminTerminologyRoutes(app, { ops: store, now: opts.now });
  return { app, registered, embeddingRequests };
}

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

describe("GAP-063 — M38's six unbuilt §4.1 routes", () => {
  describe("GET /api/v1/terminology/value-sets (catalog)", () => {
    const seed: TerminologyOpsSeed = {
      valueSets: [
        {
          id: "hospice_terminal_diagnosis",
          name: "Terminal diagnosis",
          description: null,
          scope: "hospice",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "level_of_care",
          name: "Level of care",
          description: "RHC/CHC/IRC/GIP",
          scope: "platform",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    it("an actor without terminology.read → 403", async () => {
      const { app } = makeServer({ seed });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/value-sets",
        headers: OPERATOR_H, // holds only the admin keys
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("lists the catalog for a terminology reader", async () => {
      const { app } = makeServer({ seed });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/value-sets",
        headers: RN_H,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().items.map((v: { id: string }) => v.id)).toEqual([
        "hospice_terminal_diagnosis",
        "level_of_care",
      ]);
      await app.close();
    });

    it("filters by scope", async () => {
      const { app } = makeServer({ seed });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/value-sets?scope=platform",
        headers: RN_H,
      });
      expect(res.json().items).toHaveLength(1);
      await app.close();
    });
  });

  describe("GET /api/v1/terminology/remediation (§7.3)", () => {
    const seed: TerminologyOpsSeed = { deprecations: DEPRECATIONS };
    const usage: CarePlanCodeUsageRecord[] = [
      { recordId: "p1", recordType: "problem_list", systemId: "icd10cm", code: "I50.20" },
      { recordId: "p2", recordType: "problem_list", systemId: "icd10cm", code: "I50.20" },
      { recordId: "p3", recordType: "problem_list", systemId: "icd10cm", code: "G30.0" },
      // An ACTIVE code — must not appear: using a current code is not remediation work.
      { recordId: "p4", recordType: "problem_list", systemId: "icd10cm", code: "I50.21" },
    ];

    it("terminology.read alone is NOT enough — the report needs its own key", async () => {
      const { app } = makeServer({ seed, producer: fakeProducer(usage) });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/remediation",
        headers: RN_H,
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("rolls the tenant's records up by deprecated code, biggest exposure first", async () => {
      const { app } = makeServer({ seed, producer: fakeProducer(usage) });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/remediation?since=2025-01-01",
        headers: COMPLIANCE_H,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalAffected).toBe(3); // p4's active code is excluded
      expect(body.affectedCodeCount).toBe(2);
      expect(body.items[0].deprecatedCode).toBe("I50.20");
      expect(body.items[0].affectedRecordCount).toBe(2);
      expect(body.items[0].sampleRecordIds).toEqual(["p1", "p2"]);
      expect(body.items[0].affectedByType).toEqual({ problem_list: 2 });
      await app.close();
    });

    it("names the record classes it actually consulted", async () => {
      // §7.3 lists problem list / claim line / order; only the first has a bound producer. A compliance
      // surface that under-reports must say what it looked at rather than leave it to be inferred.
      const { app } = makeServer({ seed, producer: fakeProducer(usage) });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/remediation?since=2025-01-01",
        headers: COMPLIANCE_H,
      });
      expect(res.json().coveredRecordTypes).toEqual(["problem_list"]);
      await app.close();
    });

    it("defaults `since` to 18 months back", async () => {
      const { app } = makeServer({
        seed,
        producer: fakeProducer(usage),
        now: () => new Date("2026-08-14T00:00:00.000Z"),
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/remediation",
        headers: COMPLIANCE_H,
      });
      expect(res.json().since).toBe("2025-02-14");
      await app.close();
    });

    it("asks no producer at all when nothing was deprecated in the window", async () => {
      let asked = 0;
      const counting: CodeUsageProducer = {
        recordType: "problem_list",
        usage: async () => {
          asked += 1;
          return [];
        },
      };
      const { app } = makeServer({ seed, producer: counting });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/remediation?since=2030-01-01",
        headers: COMPLIANCE_H,
      });
      expect(res.json().totalAffected).toBe(0);
      expect(asked).toBe(0);
      await app.close();
    });

    it("propagates a producer failure instead of reporting a clean bill of health", async () => {
      // FAIL-CLOSED: "no deprecated codes in use" and "we could not check" are materially different
      // statements to put in front of a Compliance Officer.
      const broken: CodeUsageProducer = {
        recordType: "problem_list",
        usage: async () => {
          throw new Error("CarePlanReader is not implemented");
        },
      };
      const { app } = makeServer({ seed, producer: broken });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/remediation?since=2025-01-01",
        headers: COMPLIANCE_H,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      await app.close();
    });

    describe("recommendedAction", () => {
      it("one equivalent successor is a mechanical swap", () => {
        expect(
          recommendedActionFor({ mappingKind: "equivalent", successorCodes: ["I50.21"] }),
        ).toBe("update_to_successor");
      });

      it("everything else is a coding judgement", () => {
        expect(recommendedActionFor({ mappingKind: "broader", successorCodes: ["G30.1"] })).toBe(
          "manual_review",
        );
        expect(
          recommendedActionFor({ mappingKind: "equivalent", successorCodes: ["A", "B"] }),
        ).toBe("manual_review");
        expect(recommendedActionFor({ mappingKind: "none", successorCodes: [] })).toBe(
          "manual_review",
        );
      });
    });

    it("defaultRemediationSince walks back 18 months across a year boundary", () => {
      expect(defaultRemediationSince(new Date("2026-03-31T00:00:00.000Z"))).toBe("2024-10-01");
    });
  });

  describe("the platform-ops surface (§4.1 rows 11-14)", () => {
    const seed: TerminologyOpsSeed = {
      history: [
        {
          logId: "l1",
          systemId: "icd10cm",
          versionId: "v1",
          version: "2026",
          versionStatus: "active",
          action: "loaded",
          conceptCount: 74000,
          newCodes: 400,
          retiredCodes: 12,
          affectedValueSets: 3,
          summary: {},
          at: "2026-01-02T00:00:00.000Z",
        },
        {
          logId: "l2",
          systemId: "snomed",
          versionId: null,
          version: null,
          versionStatus: null,
          action: "tenant_extension_added",
          conceptCount: 0,
          newCodes: 0,
          retiredCodes: 0,
          affectedValueSets: 1,
          summary: {},
          at: "2026-02-02T00:00:00.000Z",
        },
      ],
      versions: [{ system: "icd10cm", version: "2026", versionId: "v1" }],
      activeVersionBySystem: { icd10cm: "v1" },
      extensions: [
        {
          extensionId: "x1",
          valueSetId: "level_of_care",
          organizationId: ORG,
          systemId: "icd10cm",
          code: "I50.22",
          reason: "local policy",
          addedBy: null,
          removedAt: null,
          createdAt: "2026-03-01T00:00:00.000Z",
        },
        {
          extensionId: "x2",
          valueSetId: "level_of_care",
          organizationId: OTHER_ORG,
          systemId: "icd10cm",
          code: "I50.23",
          reason: "other tenant policy",
          addedBy: null,
          removedAt: null,
          createdAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    };

    it("holding terminology.admin.read is NOT enough without the platform_ops role", async () => {
      // The GAP-063 point: §4.4 marks these routes platform-only, and RBAC cannot express that — a
      // permission key travels with whatever role template carries it.
      const { app } = makeServer({ seed });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/terminology/versions",
        headers: TENANT_ADMIN_H,
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("returns the load history for a platform operator", async () => {
      const { app } = makeServer({ seed });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/terminology/versions",
        headers: OPERATOR_H,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().items.map((h: { logId: string }) => h.logId)).toEqual(["l2", "l1"]);
      await app.close();
    });

    it("filters the history by system", async () => {
      const { app } = makeServer({ seed });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/terminology/versions?system=icd10cm",
        headers: OPERATOR_H,
      });
      expect(res.json().items).toHaveLength(1);
      await app.close();
    });

    it("registers a new version and says ingestion is still pending", async () => {
      const { app, registered } = makeServer({ seed });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/terminology/icd10cm/load",
        headers: OPERATOR_H,
        payload: {
          version: "2027",
          sourceFileRef: "minio://terminology/icd10cm-2027.zip",
          checksum: "a".repeat(64),
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().created).toBe(true);
      // The response never lets "registered" read as "the codes are loaded".
      expect(res.json().ingestion).toBe("pending_loader_worker");
      expect(res.json().status).toBe("loading");
      expect(registered()).toHaveLength(1);
      expect(registered()[0]?.loadedBy).toBe(OPERATOR);
      await app.close();
    });

    it("is idempotent on (system, version) — a re-load is 409 carrying the existing id", async () => {
      const { app, registered } = makeServer({ seed });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/terminology/icd10cm/load",
        headers: OPERATOR_H,
        payload: {
          version: "2026", // already registered in the seed
          sourceFileRef: "minio://terminology/icd10cm-2026.zip",
          checksum: "b".repeat(64),
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("VERSION_ALREADY_LOADED");
      expect(res.json().error.details.versionId).toBe("v1");
      expect(registered()).toHaveLength(0); // nothing was written
      await app.close();
    });

    it("refuses the load without a fresh step-up", async () => {
      const { app, registered } = makeServer({ seed, stepUpPasses: false });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/terminology/icd10cm/load",
        headers: OPERATOR_H,
        payload: {
          version: "2028",
          sourceFileRef: "minio://terminology/icd10cm-2028.zip",
          checksum: "c".repeat(64),
        },
      });
      expect(res.statusCode).toBe(403);
      expect(registered()).toHaveLength(0);
      await app.close();
    });

    it("rejects a load body with no checksum", async () => {
      // checksum is REQUIRED here even though the §4.2 body sketch omits it: the column is NOT NULL and
      // is the provenance a re-load is proven against.
      const { app } = makeServer({ seed });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/terminology/icd10cm/load",
        headers: OPERATOR_H,
        payload: { version: "2029", sourceFileRef: "minio://x" },
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it("records an embeddings refresh against the system's active version", async () => {
      const { app, embeddingRequests } = makeServer({ seed });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/terminology/icd10cm/refresh-embeddings",
        headers: OPERATOR_H,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().versionId).toBe("v1");
      expect(res.json().recompute).toBe("pending_embeddings_worker");
      expect(embeddingRequests()).toEqual([{ system: "icd10cm", requestedBy: OPERATOR }]);
      await app.close();
    });

    it("refuses an embeddings refresh for a system with no active version", async () => {
      const { app, embeddingRequests } = makeServer({ seed });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/terminology/snomed/refresh-embeddings",
        headers: OPERATOR_H,
      });
      expect(res.statusCode).toBe(409);
      expect(embeddingRequests()).toHaveLength(0);
      await app.close();
    });

    it("shows extensions from EVERY tenant, not just the operator's own org", async () => {
      const { app } = makeServer({ seed });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/terminology/value-set-extensions",
        headers: OPERATOR_H,
      });
      expect(res.statusCode).toBe(200);
      const orgs = res.json().items.map((x: { organizationId: string }) => x.organizationId);
      expect(orgs).toContain(ORG);
      expect(orgs).toContain(OTHER_ORG);
      await app.close();
    });

    it("hands back a keyset cursor only when the page is full", async () => {
      const { app } = makeServer({ seed });
      const full = await app.inject({
        method: "GET",
        url: "/api/v1/admin/terminology/value-set-extensions?limit=2",
        headers: OPERATOR_H,
      });
      expect(full.json().nextCursor).toBe(`2026-02-01T00:00:00.000Z|x2`);
      const short = await app.inject({
        method: "GET",
        url: "/api/v1/admin/terminology/value-set-extensions?limit=50",
        headers: OPERATOR_H,
      });
      expect(short.json().nextCursor).toBeNull();
      await app.close();
    });

    it("the governance view is unauthenticated-refused like every other admin route", async () => {
      const { app } = makeServer({ seed });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/terminology/value-set-extensions",
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });
});
