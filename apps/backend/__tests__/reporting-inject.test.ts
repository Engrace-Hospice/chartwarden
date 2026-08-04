// apps/backend/__tests__/reporting-inject.test.ts — M33 (Reporting & Dashboards) §4.1 route-inventory
// HTTP-layer smoke test (TASK-050A / TEST-001). Before this file, M33 had zero `app.inject()` coverage.
//
// M33 is structurally different from every other module in this effort: it has THREE separate top-level
// mount functions instead of one aggregator — `mountM33ReadRoutes` (dashboards/tiles/catalog reads +
// platform/compliance admin + the internal MetricsProvider seam, §4.1 #1-#7/#37-#42),
// `mountM33WriteRoutes` (report-definition/view/schedule MUTATIONS, §4.1 #8-#31), and
// `mountM33ExportDrilldownRoutes` (CSV/PDF/XLSX export + drilldown emit/bulk-export, §4.1 #32-#36). All
// three are mounted here over the module's own matching in-memory backend factories
// (`createInMemoryM33ReadBackend` / `createInMemoryM33WriteBackend` / `createInMemoryM33ExportDrilldownBackend`,
// exported from `./routes/index` — NOT re-exported by the module's top-level `index.ts`, unlike the mount
// functions and the §4.7 ABAC builder) — the M11-T06 / M28 precedent this file clones: `buildServer()`
// mounts the host, a header-auth shim populates `request.context`, and a FRESH `createPredicateRegistry()`
// is seeded with M33's two §4.7 predicates (`buildM33AbacPredicates`, built over a small hand-rolled
// resolver that reads saved-view owner facts off the SAME in-memory write backend) plus a permissive
// `step_up_recent` stand-in (M3's predicate, composed-but-not-owned by M33's step-up-gated routes — the
// M28/M34 precedent for stubbing a foreign predicate locally).
//
// TWO REAL, NOT-FABRICATED GAPS SURFACED PURELY BY DRIVING THE ROUTE LAYER FOR THE FIRST TIME (exactly
// what TEST-001 predicted a pure-function test can't catch — documented here, not papered over):
//
//   1. UNIVERSAL-DENY ABAC TARGET-MAPPER BUG on `GET /api/v1/reporting/dashboards/:dashboardId` (#2).
//      `dashboards-tiles.routes.ts`'s `DASH_READ_VIS` binds `requireAbac("report.dashboard.read",
//      "dashboard_visibility")` with NO `getTarget` override, so the predicate evaluates against the
//      DEFAULT target (`request.params`, which carries `{ dashboardId }`). But `dashboard_visibility`
//      (abac-predicates.ts) reads `target.viewId`, which is never present on this route's params — so
//      `targetStr(target, "viewId")` is always `null` and the predicate returns `false` UNCONDITIONALLY,
//      for every actor, including the dashboard's own org_admin/owner. Contrast with
//      `views-shares.routes.ts`'s `VIS` helper, which DOES map `{ viewId: params.id }` explicitly — the
//      fix pattern already exists two files over. This route is asserted at its real 403 below, not
//      faked to 2xx (the M14/M17 TASK-050 precedent for an honestly-documented defect).
//
//   2. `GET /api/v1/reporting/schedules/runs/:runId` (#31) can never return 2xx against this in-memory
//      backend: no route in the MUTATING surface ever creates a `ScheduleRunView` (the `runs` map inside
//      `createInMemoryM33WriteBackend` is populated only by the §4.8 worker, which this backend does not
//      simulate), and `M33WriteRouteSeed` carries no `runs` seed field to pre-populate one either. So
//      `getScheduleRun` always throws `NotFoundError` for any id. Asserted at its real 404 below.
//
// ALSO DOCUMENTED, NOT A BUG: `POST /api/v1/reporting/drilldown/bulk_export` (#36) is closed to every
// caller by design today — its own file header says so verbatim: `device_attestation_valid` (the shared
// M3-intrinsic predicate seeded by `createPredicateRegistry()`'s default) denies unconditionally because
// nothing in the platform yet produces a device-attestation attribute (ADR-0023/ADR-0035, unbuilt). This
// is asserted at its real 403 below.
import { randomUUID } from "node:crypto";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  buildM33AbacPredicates,
  denyStubReportingAbacResolver,
  M33_PERMISSION_KEYS,
  mountM33ExportDrilldownRoutes,
  mountM33ReadRoutes,
  mountM33WriteRoutes,
  type ReportingAbacResolver,
} from "../src/modules/33-reporting/index";
import {
  createInMemoryM33ExportDrilldownBackend,
  createInMemoryM33ReadBackend,
  createInMemoryM33WriteBackend,
  type M33ReadRouteSeed,
  type M33WriteRouteService,
} from "../src/modules/33-reporting/routes/index";

// ── header-auth shim (the M11/M14/M19/M28 precedent) ────────────────────────────────────────────────
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
const BASE_KEY = "census_daily"; // in the DEFAULT `activeBaseKeys` of `createInMemoryM33WriteBackend`
const MV_KEY = "mv_census_daily";
const DASHBOARD_ID = "20000000-0000-4000-8000-000000000001";
const MEMBER_SUPER = "10000000-0000-4000-8000-000000000001";
const MEMBER_NOPERM = "10000000-0000-4000-8000-000000000002";

const READ_SEED: M33ReadRouteSeed = {
  dashboards: [
    {
      dashboardId: DASHBOARD_ID,
      displayName: "Ops Dashboard",
      authorship: "tenant",
      tileCount: 2,
      shareScope: "org",
      isOrgDefault: true,
    },
  ],
  bases: [{ baseKey: BASE_KEY, status: "active" }],
  metrics: [{ metricKey: "census_count", status: "active" }],
  mvs: [{ mvKey: MV_KEY, status: "active" }],
  drilldownAudit: [{ id: "30000000-0000-4000-8000-000000000001", drilldownTargetModule: 8 }],
  lag: { lagSeconds: 12, breakerOpen: false },
  metricValues: { census_count: { value: 42, unit: "count" } },
};

// The full §4.6 set (thirty-three keys) for a fully-permissioned actor; a zero-permission actor for 403s.
const PERMISSION_SEED: ReadonlyArray<{ userId: string; permissions: readonly string[] }> = [
  { userId: "super_1", permissions: [...M33_PERMISSION_KEYS] },
  { userId: "noperm_1", permissions: [] },
];

/**
 * A small hand-rolled `ReportingAbacResolver` over the SAME in-memory write backend this file's
 * `makeServer()` builds (the M28 precedent: a resolver wrapping the SAME store the routes mutate, not a
 * second independent dataset). Only `loadReportView` is implemented for real — team/location resolution
 * stays on the deny-stub default (no M2/M5 seam under test here; every scope-predicate case below is
 * satisfied via the actor's `org_admin` role instead).
 */
function buildTestAbacResolver(writeService: M33WriteRouteService): ReportingAbacResolver {
  return {
    ...denyStubReportingAbacResolver,
    async loadReportView(organizationId, viewId) {
      try {
        const v = await writeService.getView(
          { organizationId, userId: "resolver", roles: [], membershipId: "resolver" },
          viewId,
        );
        return {
          viewId: v.id,
          organizationId: v.organizationId,
          ownerMembershipId: v.ownerMembershipId,
          shareScope: v.shareScope,
          shareRoleKeys: v.shareRoleKeys ?? [],
        };
      } catch {
        return null; // absent / cross-tenant → fail-closed (the predicate's own contract)
      }
    },
  };
}

function makeServer() {
  const read = createInMemoryM33ReadBackend(READ_SEED);
  const write = createInMemoryM33WriteBackend();
  const exportDrilldown = createInMemoryM33ExportDrilldownBackend();

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);

  // A FRESH predicate registry per server (the M11-T06 precedent — the shared registry would otherwise
  // persist a predicate closed over a prior test's backend across the file). `createPredicateRegistry()`
  // seeds M3's intrinsic predicates by default, INCLUDING `device_attestation_valid` — left at its
  // fail-closed default deliberately (see the file-header note on #36).
  const resolver = buildTestAbacResolver(write.service);
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(buildM33AbacPredicates({ resolver }))) {
    reg.register(name, predicate);
  }
  // `step_up_recent` is M3's predicate (composed by `requireStepUp`, not owned by M33); a fresh registry
  // starts without it, so a permissive test-local stand-in is registered here (the M28/M34 precedent).
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM33ReadRoutes(app, read.service);
  mountM33WriteRoutes(app, write.service);
  mountM33ExportDrilldownRoutes(app, exportDrilldown.service);
  return { app, read, write, exportDrilldown };
}

const SUPER: Record<string, string> = {
  "x-test-user": "super_1",
  "x-test-org": ORG,
  "x-test-roles": "org_admin",
  "x-test-membership": MEMBER_SUPER,
};
const NOPERM: Record<string, string> = {
  "x-test-user": "noperm_1",
  "x-test-org": ORG,
  "x-test-roles": "none",
  "x-test-membership": MEMBER_NOPERM,
};

/** Create a definition → publish-eligible version → saved view, over `app`, as `headers`. Returns the viewId. */
async function seedView(
  app: FastifyInstance,
  headers: Record<string, string>,
  idemPrefix: string,
): Promise<string> {
  const spec = {
    dimensions: [{ dimensionKey: "location_id" }],
    measures: [{ measureKey: "census_count" }],
    filters: [],
  };
  const create = await app.inject({
    method: "POST",
    url: "/api/v1/reporting/definitions",
    headers: { ...headers, "idempotency-key": `${idemPrefix}-def` },
    payload: { baseKey: BASE_KEY, displayName: "Seed Definition", spec },
  });
  const defId = create.json().id as string;
  const versions = await app.inject({
    method: "GET",
    url: `/api/v1/reporting/definitions/${defId}/versions`,
    headers,
  });
  const definitionVersionId = versions.json().items[0].id as string;
  const createView = await app.inject({
    method: "POST",
    url: "/api/v1/reporting/views",
    headers: { ...headers, "idempotency-key": `${idemPrefix}-view` },
    payload: { definitionVersionId, displayName: "Seed View" },
  });
  return createView.json().id as string;
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

// ── auth gating: 401 / 403 / 422 ────────────────────────────────────────────────────────────────────
describe("M33-reporting-inject — auth gating", () => {
  it("no auth headers at all → 401 (GET /api/v1/reporting/dashboards)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/reporting/dashboards" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("an authenticated actor holding NO permissions → 403 (POST /api/v1/reporting/definitions)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/reporting/definitions",
      headers: { ...NOPERM, "idempotency-key": "noperm-def-1" },
      payload: {
        baseKey: BASE_KEY,
        displayName: "x",
        spec: { dimensions: [], measures: [{ measureKey: "census_count" }], filters: [] },
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("a correctly-permissioned actor with an empty body → 422 VALIDATION_FAILED (POST /api/v1/reporting/definitions)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/reporting/definitions",
      headers: { ...SUPER, "idempotency-key": "empty-def-1" },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    await app.close();
  });
});

// ── #1-7 + #37-42 — simple catalog / admin / metric-seam reads (uniform GET → 200 shape) ──────────────
describe("M33-reporting-inject — catalog + admin + metric-seam reads", () => {
  const ROUTES: ReadonlyArray<{ readonly label: string; readonly url: string }> = [
    { label: "#1 dashboards list", url: "/api/v1/reporting/dashboards" },
    { label: "#3 tile read", url: `/api/v1/reporting/tiles/${BASE_KEY}` },
    { label: "#4 tile freshness", url: `/api/v1/reporting/tiles/${BASE_KEY}/freshness` },
    { label: "#5 bases list", url: "/api/v1/reporting/bases" },
    { label: "#6 base detail", url: `/api/v1/reporting/bases/${BASE_KEY}` },
    { label: "#7 metrics list", url: "/api/v1/reporting/metrics" },
    { label: "#37 admin mv list", url: "/api/v1/reporting/admin/mvs" },
    { label: "#40 admin replica lag", url: "/api/v1/reporting/admin/lag" },
    { label: "#41 admin drilldown audit", url: "/api/v1/reporting/admin/audit/drilldowns" },
    { label: "#42 metrics-seam dashboard metric", url: "/api/v1/reporting/metrics_seam/dashboard/census_count" },
  ];

  it.each(ROUTES)("$label → 200", async ({ url }) => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url, headers: SUPER });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// ── #38/#39 — admin MV commands (enqueue + 202) ─────────────────────────────────────────────────────
describe("M33-reporting-inject — admin MV commands (#38-39)", () => {
  it("POST mv refresh → 202 + enqueues report.mv_refresh:refresh", async () => {
    const { app, read } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/reporting/admin/mvs/${MV_KEY}/refresh`,
      headers: SUPER,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().jobId).toBeTypeOf("string");
    expect(read.inspect.enqueuedJobs()).toContainEqual({ queue: "report.mv_refresh", jobKey: `${MV_KEY}:refresh` });
    await app.close();
  });

  it("POST mv suspend → 202 + enqueues report.mv_refresh:suspend", async () => {
    const { app, read } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/reporting/admin/mvs/${MV_KEY}/suspend`,
      headers: SUPER,
    });
    expect(res.statusCode).toBe(202);
    expect(read.inspect.enqueuedJobs()).toContainEqual({ queue: "report.mv_refresh", jobKey: `${MV_KEY}:suspend` });
    await app.close();
  });
});

// ── #2 — KNOWN, DOCUMENTED BUG: dashboard-detail visibility target-mapper mismatch ─────────────────────
describe("M33-reporting-inject — #2 GET dashboard detail (KNOWN BUG, see file header)", () => {
  it("even the dashboard's own org_admin actor is denied — dashboard_visibility reads target.viewId but the route's default getTarget carries only {dashboardId}, so the predicate fails closed on EVERY call, not just a cross-tenant one", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reporting/dashboards/${DASHBOARD_ID}`,
      headers: SUPER,
    });
    expect(res.statusCode).toBe(403); // real, current behavior — not a fabricated pass
    await app.close();
  });
});

// ── #8-14 — report-definition lifecycle (immutable version chain, D9) ──────────────────────────────────
describe("M33-reporting-inject — definitions lifecycle (#8-14)", () => {
  it("create → list → read → list versions → append version → publish → archive", async () => {
    const { app } = makeServer();
    const spec = {
      dimensions: [{ dimensionKey: "location_id" }],
      measures: [{ measureKey: "census_count" }],
      filters: [],
    };

    // #8 create
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/reporting/definitions",
      headers: { ...SUPER, "idempotency-key": "def-create-1" },
      payload: { baseKey: BASE_KEY, displayName: "Daily Census by Location", spec },
    });
    expect(create.statusCode).toBe(201);
    const defId = create.json().id as string;

    // #9 list
    const list = await app.inject({ method: "GET", url: "/api/v1/reporting/definitions", headers: SUPER });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((d: { id: string }) => d.id)).toContain(defId);

    // #10 read
    const read = await app.inject({ method: "GET", url: `/api/v1/reporting/definitions/${defId}`, headers: SUPER });
    expect(read.statusCode).toBe(200);
    expect(read.json().baseKey).toBe(BASE_KEY);

    // #11 list versions
    const versions = await app.inject({
      method: "GET",
      url: `/api/v1/reporting/definitions/${defId}/versions`,
      headers: SUPER,
    });
    expect(versions.statusCode).toBe(200);
    expect(versions.json().items).toHaveLength(1);
    const v1Id = versions.json().items[0].id as string;

    // #12 append a new version (D9 — editing is never in-place)
    const newVersion = await app.inject({
      method: "POST",
      url: `/api/v1/reporting/definitions/${defId}/versions`,
      headers: { ...SUPER, "idempotency-key": "def-version-1" },
      payload: { spec },
    });
    expect(newVersion.statusCode).toBe(201);
    expect(newVersion.json().versionNumber).toBe(2);

    // #13 publish v1
    const publish = await app.inject({
      method: "POST",
      url: `/api/v1/reporting/definitions/${defId}/versions/${v1Id}/publish`,
      headers: { ...SUPER, "idempotency-key": "def-publish-1" },
    });
    expect(publish.statusCode).toBe(201);
    expect(publish.json().version.status).toBe("published");

    // #14 archive
    const archive = await app.inject({
      method: "POST",
      url: `/api/v1/reporting/definitions/${defId}/archive`,
      headers: { ...SUPER, "idempotency-key": "def-archive-1" },
    });
    expect(archive.statusCode).toBe(201);
    expect(archive.json().status).toBe("archived");

    await app.close();
  });
});

// ── #15-21 — saved views + sharing (D17) ────────────────────────────────────────────────────────────
describe("M33-reporting-inject — views + sharing lifecycle (#15-21)", () => {
  it("list → create → read → patch → share (role) → set-org-default → archive", async () => {
    const { app } = makeServer();

    // #15 list (empty is a legal 200 before any view exists)
    const list0 = await app.inject({ method: "GET", url: "/api/v1/reporting/views", headers: SUPER });
    expect(list0.statusCode).toBe(200);

    // #16 create (via the shared definition→version→view seed helper)
    const viewId = await seedView(app, SUPER, "views-lifecycle");

    // #17 read (dashboard_visibility: the actor owns the view it just created)
    const read = await app.inject({ method: "GET", url: `/api/v1/reporting/views/${viewId}`, headers: SUPER });
    expect(read.statusCode).toBe(200);

    // #18 edit
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/reporting/views/${viewId}`,
      headers: { ...SUPER, "idempotency-key": "view-patch-1" },
      payload: { displayName: "Renamed Census View" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().displayName).toBe("Renamed Census View");

    // #19 share to a role (not `org`, so the extra report.share.org guard is not exercised here)
    const share = await app.inject({
      method: "POST",
      url: `/api/v1/reporting/views/${viewId}/share`,
      headers: { ...SUPER, "idempotency-key": "view-share-1" },
      payload: { shareScope: "role", shareRoleKeys: ["clinical_supervisor"] },
    });
    expect(share.statusCode).toBe(201);
    expect(share.json().view.shareScope).toBe("role");

    // #20 set org default
    const setDefault = await app.inject({
      method: "POST",
      url: `/api/v1/reporting/views/${viewId}/set-org-default`,
      headers: { ...SUPER, "idempotency-key": "view-default-1" },
    });
    expect(setDefault.statusCode).toBe(201);
    expect(setDefault.json().isOrgDefault).toBe(true);

    // #21 archive
    const archive = await app.inject({
      method: "POST",
      url: `/api/v1/reporting/views/${viewId}/archive`,
      headers: { ...SUPER, "idempotency-key": "view-archive-1" },
    });
    expect(archive.statusCode).toBe(201);
    expect(archive.json().status).toBe("archived");

    await app.close();
  });
});

// ── #22-31 — scheduled-delivery pipeline (D7) ───────────────────────────────────────────────────────
describe("M33-reporting-inject — scheduled reports lifecycle (#22-31)", () => {
  it("list → create → read → patch → pause → resume → run-history reads → delete_all_runs → cancel", async () => {
    const { app } = makeServer();
    const viewId = await seedView(app, SUPER, "sched-lifecycle");

    // #22 list
    const list0 = await app.inject({ method: "GET", url: "/api/v1/reporting/schedules", headers: SUPER });
    expect(list0.statusCode).toBe(200);

    // #23 create
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/reporting/schedules",
      headers: { ...SUPER, "idempotency-key": "sched-create-1" },
      payload: {
        reportViewId: viewId,
        cronExpression: "0 6 * * *",
        tenantTimezone: "America/New_York",
        format: "csv",
        recipientMembershipIds: [MEMBER_SUPER],
      },
    });
    expect(create.statusCode).toBe(201);
    const scheduleId = create.json().id as string;

    // #24 read
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/reporting/schedules/${scheduleId}`,
      headers: SUPER,
    });
    expect(read.statusCode).toBe(200);

    // #25 edit
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/reporting/schedules/${scheduleId}`,
      headers: { ...SUPER, "idempotency-key": "sched-patch-1" },
      payload: { tenantTimezone: "America/Chicago" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().tenantTimezone).toBe("America/Chicago");

    // #26 pause
    const pause = await app.inject({
      method: "POST",
      url: `/api/v1/reporting/schedules/${scheduleId}/pause`,
      headers: { ...SUPER, "idempotency-key": "sched-pause-1" },
    });
    expect(pause.statusCode).toBe(201);
    expect(pause.json().status).toBe("paused");

    // #27 resume
    const resume = await app.inject({
      method: "POST",
      url: `/api/v1/reporting/schedules/${scheduleId}/resume`,
      headers: { ...SUPER, "idempotency-key": "sched-resume-1" },
    });
    expect(resume.statusCode).toBe(201);
    expect(resume.json().status).toBe("active");

    // #30 read the run ledger — legitimately empty (no worker ever ran in this slice), still a 200.
    const runsList = await app.inject({
      method: "GET",
      url: `/api/v1/reporting/schedules/${scheduleId}/runs`,
      headers: SUPER,
    });
    expect(runsList.statusCode).toBe(200);
    expect(runsList.json().items).toHaveLength(0);

    // #29 bulk-delete run history — step-up + org-admin-carried permission.
    const deleteRuns = await app.inject({
      method: "POST",
      url: `/api/v1/reporting/schedules/${scheduleId}/delete_all_runs`,
      headers: { ...SUPER, "x-step-up": "fresh", "idempotency-key": "sched-delete-runs-1" },
    });
    expect(deleteRuns.statusCode).toBe(200);
    expect(deleteRuns.json().deleted).toBe(0);

    // #28 cancel (terminal)
    const cancel = await app.inject({
      method: "POST",
      url: `/api/v1/reporting/schedules/${scheduleId}/cancel`,
      headers: { ...SUPER, "idempotency-key": "sched-cancel-1" },
    });
    expect(cancel.statusCode).toBe(201);
    expect(cancel.json().status).toBe("cancelled");

    // #31 GET a schedule run by id — DOCUMENTED GAP (see file header): no route in this in-memory
    // backend ever produces a ScheduleRunView, so this always 404s. Asserted as-is, not faked to 2xx.
    const getRun = await app.inject({
      method: "GET",
      url: `/api/v1/reporting/schedules/runs/${randomUUID()}`,
      headers: SUPER,
    });
    expect(getRun.statusCode).toBe(404);

    await app.close();
  });
});

// ── #32-36 — export (CSV/PDF/XLSX) + drilldown (emit/bulk_export) ──────────────────────────────────────
describe("M33-reporting-inject — export + drilldown (#32-36)", () => {
  // REAL, NOT-FABRICATED FINDING (surfaced only by driving this route through `.inject()` for the first
  // time — a third bug CLASS beyond the two documented in the file header): `csvSinkOf(reply).end()` in
  // `exports.routes.ts` calls `raw.end(resolve)` — passing the bare `resolve` function as the sole
  // argument, relying on Node's real `http.ServerResponse.end(callback)` overload (a lone function arg is
  // detected and treated as the completion callback, chunk stays `null`). Under REAL Node/Fastify this is
  // correct and harmless. But `light-my-request`'s own `Response.prototype.end` override (the engine
  // behind `.inject()`) does NOT reproduce that overload-detection: it treats the first argument
  // positionally as the response BODY unconditionally (`if (data) this.write(data, encoding)`), so it
  // hands `resolve` itself to `Buffer.from(fn, encoding)` and throws `TypeError: The "chunk" argument must
  // be of type string or an instance of Buffer or Uint8Array. Received function`. That throw happens
  // inside the `new Promise((resolve) => { raw.end(resolve) })` executor, so `sink.end()` REJECTS;
  // `streamCsvExport` propagates the rejection; the route's own catch calls `reply.raw.destroy(err)`,
  // which is what actually surfaces here as `app.inject()` itself rejecting with that TypeError. Net
  // effect: route #32 cannot be smoke-tested via `.inject()` today (a `.inject()`/light-my-request
  // incompatibility with the Node-callback overload of `res.end()`, not a defect reachable over a real
  // socket) — asserted as its real, current rejection below, not faked to a 200.
  it("#32 CSV export — `.inject()` cannot drive this route: it REJECTS with the TypeError above (see comment), not a fabricated 200", async () => {
    const { app } = makeServer();
    await expect(
      app.inject({
        method: "POST",
        url: `/api/v1/reporting/views/${randomUUID()}/export.csv`,
        headers: SUPER,
        payload: {},
      }),
    ).rejects.toThrow(/chunk.*must be of type string/i);
    await app.close();
  });

  it("#33 PDF export requests a render (§1.1 M22 handshake) → 202", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/reporting/views/${randomUUID()}/export.pdf`,
      headers: { ...SUPER, "idempotency-key": "export-pdf-1" },
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("render_requested");
    await app.close();
  });

  it("#34 XLSX export requests a render → 202", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/reporting/views/${randomUUID()}/export.xlsx`,
      headers: { ...SUPER, "idempotency-key": "export-xlsx-1" },
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    await app.close();
  });

  it("#35 drilldown emit resolves + audits a consent-narrowed URL → 201", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/reporting/drilldown/emit",
      headers: { ...SUPER, "idempotency-key": "drilldown-emit-1" },
      payload: { tileKey: BASE_KEY, dimensionContext: { location_id: "loc-1" } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().outcome).toBe("emitted");
    await app.close();
  });

  it("#36 bulk drilldown export is CLOSED TO EVERYONE TODAY, BY DESIGN (see the route file's own header comment) — device_attestation_valid always denies, even for a step-up'd, fully-permissioned actor", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/reporting/drilldown/bulk_export",
      headers: { ...SUPER, "x-step-up": "fresh" },
      payload: {},
    });
    expect(res.statusCode).toBe(403); // real, current behavior — not a fabricated pass
    await app.close();
  });
});
