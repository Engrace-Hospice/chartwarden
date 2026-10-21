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
} from "@chartwarden/auth";
import type { CarePlanCodeUsageRecord } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type CodeUsageProducer,
  type PlatformUploadSigner,
  type TerminologyJobProducer,
  type TerminologyOpsSeed,
  buildTerminologyAbacPredicates,
  createAttributionResolver,
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
const COMPLIANCE_H = {
  "x-test-user": "compliance_1",
  "x-test-org": ORG,
  "x-test-roles": "compliance",
};
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

/** A recording job producer standing in for the BullMQ one. */
function fakeJobs(opts: { failEnqueue?: boolean } = {}): TerminologyJobProducer & {
  loads: { versionId: string; activate: boolean }[];
  embeddings: { system: string; versionId: string }[];
} {
  const loads: { versionId: string; activate: boolean }[] = [];
  const embeddings: { system: string; versionId: string }[] = [];
  return {
    loads,
    embeddings,
    async enqueueLoadVersion(versionId, activate) {
      if (opts.failEnqueue) throw new Error("valkey down");
      loads.push({ versionId, activate });
    },
    async enqueueRefreshEmbeddings(system, versionId) {
      embeddings.push({ system, versionId });
    },
  };
}

function makeServer(opts: {
  seed?: TerminologyOpsSeed;
  producer?: CodeUsageProducer;
  stepUpPasses?: boolean;
  now?: () => Date;
  /** GAP-108: the §4.3 producer. Default: a recording fake (the common case); `null` = no queue configured. */
  jobs?: ReturnType<typeof fakeJobs> | null;
  uploads?: PlatformUploadSigner;
  embeddingsAvailable?: boolean;
  provider?: unknown;
}) {
  const { store, registered, embeddingRequests, attestations } = createInMemoryTerminologyOpsStore(
    opts.seed ?? {},
  );
  const jobs = opts.jobs === undefined ? fakeJobs() : opts.jobs;

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
    provider: (opts.provider ?? {}) as never,
    ops: store,
    remediation,
    attribution: createAttributionResolver(store, 0),
  });
  registerAdminTerminologyRoutes(app, {
    ops: store,
    now: opts.now,
    ...(jobs ? { jobs } : {}),
    ...(opts.uploads ? { uploads: opts.uploads } : {}),
    embeddingsAvailable: opts.embeddingsAvailable ?? true,
  });
  return { app, registered, embeddingRequests, attestations, jobs };
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

    it("registers a new version AND enqueues its load (no longer 'pending_loader_worker')", async () => {
      const { app, registered, jobs } = makeServer({ seed });
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
      // GAP-108: the load is queued; the version moves loading → staged → active as the worker runs it.
      expect(res.json().ingestion).toBe("enqueued");
      expect(res.json().status).toBe("loading");
      expect(registered()).toHaveLength(1);
      expect(registered()[0]?.loadedBy).toBe(OPERATOR);
      expect(jobs?.loads).toEqual([{ versionId: res.json().versionId, activate: true }]);
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

    it("records and ENQUEUES an embeddings refresh against the system's active version", async () => {
      const { app, embeddingRequests, jobs } = makeServer({ seed });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/terminology/icd10cm/refresh-embeddings",
        headers: OPERATOR_H,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().versionId).toBe("v1");
      expect(res.json().recompute).toBe("enqueued");
      expect(embeddingRequests()).toEqual([{ system: "icd10cm", requestedBy: OPERATOR }]);
      expect(jobs?.embeddings).toEqual([{ system: "icd10cm", versionId: "v1" }]);
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

  // ── GAP-108: the loader behind the load route ─────────────────────────────────────────────────────
  describe("GAP-108 — the load route drives the loader", () => {
    const loadBody = (version: string, extra: Record<string, unknown> = {}) => ({
      version,
      sourceFileRef: `terminology/upload/${version}.zip`,
      checksum: "d".repeat(64),
      ...extra,
    });
    const post = (app: ReturnType<typeof makeServer>["app"], system: string, payload: unknown) =>
      app.inject({
        method: "POST",
        url: `/api/v1/admin/terminology/${system}/load`,
        headers: OPERATOR_H,
        payload: payload as never,
      });

    it("answers 503 BEFORE registering anything when no job queue is configured", async () => {
      const { app, registered } = makeServer({ jobs: null });
      const res = await post(app, "icd10cm", loadBody("2031"));
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("LOADER_UNAVAILABLE");
      expect(registered()).toHaveLength(0); // no dead `loading` row
      await app.close();
    });

    it("passes activate=false through (the stage-only dry run)", async () => {
      const { app, jobs } = makeServer({});
      const res = await post(app, "icd10cm", loadBody("2032", { activate: false }));
      expect(res.statusCode).toBe(200);
      expect(jobs?.loads[0]?.activate).toBe(false);
      await app.close();
    });

    it("re-drives a still-loading version on a repeated request (409 + requeued) instead of orphaning it", async () => {
      const { app, jobs } = makeServer({
        seed: { versions: [{ system: "icd10cm", version: "2026", versionId: "v1" }] },
      });
      const res = await post(app, "icd10cm", loadBody("2026"));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details).toMatchObject({ versionId: "v1", requeued: true });
      expect(jobs?.loads).toEqual([{ versionId: "v1", activate: true }]);
      await app.close();
    });

    it("reports a registered-but-unqueued version as 503 (repeat the request to re-drive it)", async () => {
      const { app } = makeServer({ jobs: fakeJobs({ failEnqueue: true }) });
      const res = await post(app, "icd10cm", loadBody("2033"));
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("LOADER_ENQUEUE_FAILED");
      await app.close();
    });

    it("refuses a system with no loader (cms_hope) as 422", async () => {
      const { app } = makeServer({});
      const res = await post(app, "cms_hope", loadBody("2034"));
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("SYSTEM_NOT_LOADABLE");
      await app.close();
    });

    it.each(["snomed", "loinc", "rxnorm"])(
      "%s: refused 403 LICENSE_ATTESTATION_REQUIRED without an attestation — and nothing is queued",
      async (system) => {
        const { app, jobs, registered } = makeServer({
          seed: { licensedSystems: ["snomed", "loinc", "rxnorm"] },
        });
        const res = await post(app, system, loadBody("2035"));
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe("LICENSE_ATTESTATION_REQUIRED");
        expect(registered()).toHaveLength(0);
        expect(jobs?.loads).toHaveLength(0);
        await app.close();
      },
    );

    it("succeeds for a licensed system once an attestation exists, via the route that records it", async () => {
      const { app, jobs } = makeServer({ seed: { licensedSystems: ["snomed"] } });
      const att = await app.inject({
        method: "POST",
        url: "/api/v1/admin/terminology/snomed/license-attestation",
        headers: OPERATOR_H,
        payload: {
          licensee: "ChartWarden Platform",
          licenseReference: "SNOMED-AFF-1",
          effectiveFrom: "2020-01-01",
          attributionText: "SNOMED CT is used under licence (test).",
        },
      });
      expect(att.statusCode).toBe(201);
      const res = await post(app, "snomed", loadBody("2036"));
      expect(res.statusCode).toBe(200);
      expect(jobs?.loads).toHaveLength(1);
      await app.close();
    });

    it("a public system cannot be attested (409) and an invalid attestation is 422", async () => {
      const { app } = makeServer({ seed: { licensedSystems: ["snomed"] } });
      const publicAtt = await app.inject({
        method: "POST",
        url: "/api/v1/admin/terminology/icd10cm/license-attestation",
        headers: OPERATOR_H,
        payload: {
          licensee: "x",
          licenseReference: "y",
          effectiveFrom: "2020-01-01",
          attributionText: "z",
        },
      });
      expect(publicAtt.statusCode).toBe(409);
      expect(publicAtt.json().error.code).toBe("LICENSE_NOT_REQUIRED");
      const bad = await app.inject({
        method: "POST",
        url: "/api/v1/admin/terminology/snomed/license-attestation",
        headers: OPERATOR_H,
        payload: {
          licensee: " ",
          licenseReference: "y",
          effectiveFrom: "2020-01-01",
          attributionText: "z",
        },
      });
      expect(bad.statusCode).toBe(422);
      await app.close();
    });

    it("attestation recording and revocation need step-up; listing needs only admin.read", async () => {
      const { app, attestations } = makeServer({
        seed: { licensedSystems: ["snomed"] },
        stepUpPasses: false,
      });
      const rec = await app.inject({
        method: "POST",
        url: "/api/v1/admin/terminology/snomed/license-attestation",
        headers: OPERATOR_H,
        payload: {
          licensee: "x",
          licenseReference: "y",
          effectiveFrom: "2020-01-01",
          attributionText: "z",
        },
      });
      expect(rec.statusCode).toBe(403);
      expect(attestations()).toHaveLength(0);
      const list = await app.inject({
        method: "GET",
        url: "/api/v1/admin/terminology/license-attestations",
        headers: OPERATOR_H,
      });
      expect(list.statusCode).toBe(200);
      await app.close();
    });

    it("revokes an attestation and 404s a second revoke", async () => {
      const { app } = makeServer({ seed: { licensedSystems: ["loinc"] } });
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/admin/terminology/loinc/license-attestation",
        headers: OPERATOR_H,
        payload: {
          licensee: "x",
          licenseReference: "y",
          effectiveFrom: "2020-01-01",
          attributionText: "LOINC attribution",
        },
      });
      const id = created.json().attestationId as string;
      const revoke = () =>
        app.inject({
          method: "POST",
          url: `/api/v1/admin/terminology/license-attestations/${id}/revoke`,
          headers: OPERATOR_H,
        });
      expect((await revoke()).statusCode).toBe(200);
      expect((await revoke()).statusCode).toBe(404);
      await app.close();
    });

    it("embeddings refresh answers 503 EMBEDDINGS_NOT_CONFIGURED while no backend is bound — never a fake success", async () => {
      const { app, embeddingRequests, jobs } = makeServer({
        seed: { activeVersionBySystem: { icd10cm: "v1" } },
        embeddingsAvailable: false,
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/terminology/icd10cm/refresh-embeddings",
        headers: OPERATOR_H,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("EMBEDDINGS_NOT_CONFIGURED");
      expect(embeddingRequests()).toHaveLength(0);
      expect(jobs?.embeddings).toHaveLength(0);
      await app.close();
    });

    it("presigns a platform-bucket upload under a server-minted key, or 503s without object storage", async () => {
      const calls: { objectKey: string; sha256Hex: string }[] = [];
      const uploads: PlatformUploadSigner = {
        presignUpload: async (a) => {
          calls.push({ objectKey: a.objectKey, sha256Hex: a.sha256Hex });
          return {
            url: "https://minio.test/put",
            headers: { "x-amz-checksum-sha256": "abc" },
            expiresAt: "2026-10-06T00:15:00.000Z",
          };
        },
      };
      const ok = makeServer({ uploads });
      const sha = "e".repeat(64);
      const res = await ok.app.inject({
        method: "POST",
        url: "/api/v1/admin/terminology/uploads",
        headers: OPERATOR_H,
        payload: { system: "icd10cm", fileName: "../../etc/passwd icd10cm.zip", sha256: sha },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sourceFileRef).toMatch(
        /^terminology\/uploads\/icd10cm\/[0-9a-f-]{36}-[A-Za-z0-9._-]+$/,
      );
      expect(res.json().sourceFileRef).not.toContain("..");
      expect(res.json().checksum).toBe(sha);
      expect(calls[0]?.sha256Hex).toBe(sha);
      await ok.app.close();

      const none = makeServer({});
      const refused = await none.app.inject({
        method: "POST",
        url: "/api/v1/admin/terminology/uploads",
        headers: OPERATOR_H,
        payload: { system: "icd10cm", fileName: "x.zip", sha256: sha },
      });
      expect(refused.statusCode).toBe(503);
      await none.app.close();
    });

    it("a tenant admin without platform_ops is refused on every new admin route", async () => {
      const { app } = makeServer({});
      for (const [method, url] of [
        ["POST", "/api/v1/admin/terminology/uploads"],
        ["GET", "/api/v1/admin/terminology/license-attestations"],
        ["POST", "/api/v1/admin/terminology/snomed/license-attestation"],
        [
          "POST",
          "/api/v1/admin/terminology/license-attestations/33333333-3333-4333-8333-333333333333/revoke",
        ],
      ] as const) {
        const res = await app.inject({ method, url, headers: TENANT_ADMIN_H, payload: {} });
        expect(res.statusCode).toBe(403);
      }
      await app.close();
    });
  });

  describe("GAP-108 — licence attribution is served with the data", () => {
    const provider = {
      validate: async () => ({ valid: true, status: "active" }),
      lookup: async () => null,
    };

    it("stamps X-Terminology-Attribution on /:system reads of an attested system, and not on others", async () => {
      const { app } = makeServer({
        provider,
        seed: {
          licensedSystems: ["snomed"],
          attestations: [
            {
              id: "a1",
              systemId: "snomed",
              licensee: "ChartWarden",
              licenseReference: "R",
              attestedBy: OPERATOR,
              attestedAt: "2026-01-01T00:00:00.000Z",
              effectiveFrom: "2020-01-01",
              effectiveTo: null,
              attributionText: "SNOMED CT\nis used under licence — © SNOMED International",
              revokedAt: null,
            },
          ],
        },
      });
      const snomed = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/snomed/validate?code=1",
        headers: RN_H,
      });
      expect(snomed.statusCode).toBe(200);
      expect(snomed.headers["x-terminology-attribution"]).toBe(
        "SNOMED CT is used under licence ? ? SNOMED International",
      );
      const icd = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/icd10cm/validate?code=I10",
        headers: RN_H,
      });
      expect(icd.headers["x-terminology-attribution"]).toBeUndefined();
      await app.close();
    });

    it("lists the attributions in force for a UI footer, to any terminology.read caller", async () => {
      const { app } = makeServer({
        seed: {
          licensedSystems: ["loinc"],
          attestations: [
            {
              id: "a2",
              systemId: "loinc",
              licensee: "ChartWarden",
              licenseReference: "R",
              attestedBy: OPERATOR,
              attestedAt: "2026-01-01T00:00:00.000Z",
              effectiveFrom: "2020-01-01",
              effectiveTo: null,
              attributionText: "LOINC is copyright Regenstrief Institute.",
              revokedAt: null,
            },
            {
              id: "a3",
              systemId: "snomed",
              licensee: "ChartWarden",
              licenseReference: "R",
              attestedBy: OPERATOR,
              attestedAt: "2026-01-01T00:00:00.000Z",
              effectiveFrom: "2020-01-01",
              effectiveTo: null,
              attributionText: "revoked one",
              revokedAt: "2026-02-01T00:00:00.000Z",
            },
          ],
        },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/terminology/attributions",
        headers: RN_H,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([
        {
          systemId: "loinc",
          licensee: "ChartWarden",
          attributionText: "LOINC is copyright Regenstrief Institute.",
        },
      ]);
      await app.close();
    });
  });
});
