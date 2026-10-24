// apps/backend/__tests__/care-plan-conformance.live.test.ts — TASK-050B (TEST-003) shared conformance
// spec, piloted on M7 Care Plan.
//
// TEST-003's risk: the whole `*-inject.test.ts` corpus (TASK-050A, ~950 route defs) proves routing/
// RBAC/ABAC wiring exclusively against `createInMemory*Backend`s, while production mounts the Drizzle-
// backed `*-route-service-db.ts` — so in-memory-vs-Drizzle BEHAVIORAL drift (a stale-version 412, a
// duplicate-resource 409, a pagination cursor) is invisible to that corpus by construction: nothing
// ever drives the SAME HTTP scenario against both backends and diffs the outcome.
//
// This file is that diff, piloted on ONE module chosen because both dimensions are concretely, cheaply
// provable here without a live DB round-trip per scenario variant:
//   - 412 STALE_VERSION: `patchProblem`'s optimistic-concurrency check (`checkOptimisticConcurrency`,
//     care-plan-routes.ts's own header: "the service raises 412 STALE_VERSION on skew (§7.7)").
//   - 409 ONE_ACTIVE_PLAN_PER_ADMISSION: `bootstrapCarePlan`'s duplicate-plan guard
//     (`CarePlanAlreadyExistsError`, service.ts: "409 TENANT_PLAN_EXISTS — one-per-admission, §2.2.1").
// Both checks are independently implemented in `createInMemoryCarePlanBackend` (a `Map`-based scan) and
// `createDbCarePlanRouteService` (a `SELECT ... WHERE` + a partial unique index as a second line of
// defense) — genuinely separate code paths that could drift, unlike e.g. Idempotency-Key handling
// (`applyIdempotency`, a single M1 platform plugin shared by every route regardless of service backend).
//
// Deliberate scope cut, stated explicitly: a genuine PAGINATION-cursor conformance dimension needs a
// module whose list route actually paginates — M7's `getCarePlanForPatient`/`listVersions` do not
// (`nextCursor` is hardcoded `null` in both backends today). M5 Patient census DOES paginate for real
// (see the `M5 Patient census` case in `auth.live.test.ts`) and is the natural next pilot for that
// third dimension — not done here; this file proves the shared-spec PATTERN (401→403→409/412 against
// two backends via one assertion function) on the two dimensions that are real on this module today.
//
// Skipped without CHARTWARDEN_TEST_DATABASE_URL, same convention as every other *.live.test.ts.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LIVE_DROP_ROLES } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = LIVE_DROP_ROLES;

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
}

/** Runs the same 401→403→409(bootstrap)→412(patch) sequence against whatever service backend is mounted. */
async function runConformanceSuite(
  label: string,
  buildApp: () => Promise<{
    app: FastifyInstance;
    patientId: string;
    admissionId: string;
    /** Pre-built `x-test-user`/`x-test-org` headers for the seeded `care_plan.author` actor. */
    authHeaders: Record<string, string>;
  }>,
) {
  describe(`${label} backend`, () => {
    it("401 without auth headers", async () => {
      const { app } = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/v1/patients/x/care-plan" });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("403 for an authenticated actor with no care_plan.* grant", async () => {
      const { app, patientId, authHeaders } = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${patientId}/care-plan`,
        headers: { "x-test-user": "no_grants", "x-test-org": authHeaders["x-test-org"] as string },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("409 ONE_ACTIVE_PLAN_PER_ADMISSION: bootstrapping the same admission twice", async () => {
      const { app, patientId, admissionId, authHeaders } = await buildApp();
      const first = await app.inject({
        method: "POST",
        url: `/api/v1/patients/${patientId}/care-plan`,
        headers: authHeaders,
        payload: { admissionId },
      });
      expect(first.statusCode).toBe(201);
      const second = await app.inject({
        method: "POST",
        url: `/api/v1/patients/${patientId}/care-plan`,
        headers: authHeaders,
        payload: { admissionId },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe("ONE_ACTIVE_PLAN_PER_ADMISSION");
      await app.close();
    });

    it("412 STALE_VERSION: patching a problem with a stale If-Match version", async () => {
      const { app, patientId, admissionId, authHeaders } = await buildApp();
      const bootstrap = await app.inject({
        method: "POST",
        url: `/api/v1/patients/${patientId}/care-plan`,
        headers: authHeaders,
        payload: { admissionId },
      });
      const planId = bootstrap.json().id as string;

      const addProblem = await app.inject({
        method: "POST",
        url: `/api/v1/care-plans/${planId}/problems`,
        headers: authHeaders,
        payload: { description: "Pain", kind: "terminal", source: "clinical", sudRelated: false },
      });
      expect(addProblem.statusCode).toBe(201);
      const problemId = addProblem.json().id as string;
      const staleVersion = String(addProblem.json().version ?? 1);

      // First PATCH at the version we read → succeeds, bumps the row's version.
      const firstPatch = await app.inject({
        method: "PATCH",
        url: `/api/v1/care-plans/${planId}/problems/${problemId}`,
        headers: {
          ...authHeaders,
          "idempotency-key": crypto.randomUUID(),
          "if-match": staleVersion,
        },
        payload: { description: "Pain — updated" },
      });
      expect(firstPatch.statusCode).toBe(200);

      // Second PATCH replaying the SAME (now-stale) version → 412 on BOTH backends.
      const stalePatch = await app.inject({
        method: "PATCH",
        url: `/api/v1/care-plans/${planId}/problems/${problemId}`,
        headers: {
          ...authHeaders,
          "idempotency-key": crypto.randomUUID(),
          "if-match": staleVersion,
        },
        payload: { description: "Pain — stale write" },
      });
      expect(stalePatch.statusCode).toBe(412);
      expect(stalePatch.json().error.code).toBe("STALE_VERSION");

      await app.close();
    });
  });
}

// ── In-memory backend ────────────────────────────────────────────────────────────────────────────
describe("M7 Care Plan conformance (TASK-050B)", () => {
  runConformanceSuite("in-memory", async () => {
    const { buildCarePlanAbacPredicates, createInMemoryCarePlanBackend, registerCarePlanRoutes } =
      await import("../src/modules/07-care-plan/index");
    const { buildServer } = await import("../src/bootstrap/index");

    resetAuthorizationContract();
    resetRbacEngine();
    const grantStore = createInMemoryEffectivePermissionStore([
      {
        orgId: "org_a",
        userId: "author_1",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["care_plan.author", "care_plan.bootstrap", "care_plan.read"],
          },
        ],
      },
    ]);
    registerEffectivePermissionResolver(grantStore.store);

    const { service, resolver } = createInMemoryCarePlanBackend();
    // GAP-012: this file tests concurrency/duplicate-guard conformance, not caseload semantics — a
    // FRESH registry with `isInCaseload` stubbed permissive (no caseload rows are seeded here) so the
    // new `caseload_or_scope` route guards don't block these scenarios. See admission-routes.test.ts /
    // care-plan-routes.test.ts for the pattern; a shared-registry reuse across this file's TWO backends
    // would hit the same GAP-011 same-source-reboot contamination this pattern avoids.
    const registry = createPredicateRegistry();
    const predicates = buildCarePlanAbacPredicates({ resolver, isInCaseload: async () => true });
    for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
    registerAbacRegistry(registry);

    const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    registerCarePlanRoutes(app, { service });
    return {
      app,
      patientId: crypto.randomUUID(),
      admissionId: crypto.randomUUID(),
      authHeaders: { "x-test-user": "author_1", "x-test-org": "org_a" },
    };
  });

  // ── Drizzle-backed backend, live Postgres ──────────────────────────────────────────────────────
  describe.skipIf(!DB_URL)("live Drizzle", () => {
    let admin: Client;

    async function resetAndMigrate() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const r of ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
      }
      const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        let migSql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (stripVector) {
          migSql = migSql.replace(
            /^.*EXTENSION IF NOT EXISTS "vector".*$/m,
            "-- (vector stripped)",
          );
        }
        await admin.query(migSql);
      }
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetAndMigrate();
    }, 120_000);

    afterAll(async () => {
      await admin?.end();
    });

    afterEach(() => {
      resetAuthorizationContract();
      resetRbacEngine();
    });

    runConformanceSuite("live Drizzle", async () => {
      const { createDbClient } = await import("@chartwarden/db");
      const {
        buildCarePlanAbacPredicates,
        createDbCarePlanAbacResolver,
        createDbCarePlanRouteService,
        registerCarePlanRoutes,
      } = await import("../src/modules/07-care-plan/index");
      const { buildServer } = await import("../src/bootstrap/index");

      resetAuthorizationContract();
      resetRbacEngine();

      const org = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'CP','CP') RETURNING id",
          [`cp-${Date.now()}-${Math.random().toString(36).slice(2)}`],
        )
      ).rows[0].id as string;
      const patientId = (
        await admin.query(
          "INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status) VALUES ($1,$2,'Con','Form','1990-01-01','M','active') RETURNING id",
          [org, `MRN-CP-${Date.now()}-${Math.random().toString(36).slice(2)}`],
        )
      ).rows[0].id as string;
      const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const providerEntityId = (
        await admin.query(
          "INSERT INTO provider_entity (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end) VALUES ($1,$2,'CP PE',$3,'enc','12-31') RETURNING id",
          [org, `12-${uniqueSuffix}`, `NPI${uniqueSuffix}`],
        )
      ).rows[0].id as string;
      const locationId = (
        await admin.query(
          "INSERT INTO location (provider_entity_id,name,address_line1,city,state,postal_code,timezone) VALUES ($1,'CP Loc','1 Main St','Town','NY','10001','America/New_York') RETURNING id",
          [providerEntityId],
        )
      ).rows[0].id as string;
      const admissionId = (
        await admin.query(
          "INSERT INTO admission (organization_id,provider_entity_id,location_id,patient_id) VALUES ($1,$2,$3,$4) RETURNING id",
          [org, providerEntityId, locationId, patientId],
        )
      ).rows[0].id as string;

      const grantStore = createInMemoryEffectivePermissionStore([
        {
          orgId: org,
          userId: "author_1",
          grants: [
            {
              roleKey: "seed",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["care_plan.author", "care_plan.bootstrap", "care_plan.read"],
            },
          ],
        },
      ]);
      registerEffectivePermissionResolver(grantStore.store);

      const handle = createDbClient({ connectionString: DB_URL as string });
      const service = createDbCarePlanRouteService(handle.db as never);
      // GAP-012: see the in-memory backend's comment above — same fresh-registry, permissive-caseload
      // pattern, over the REAL Drizzle resolver this time (no caseload rows are seeded for `author_1`).
      const registry = createPredicateRegistry();
      const predicates = buildCarePlanAbacPredicates({
        resolver: createDbCarePlanAbacResolver(handle.db as never),
        isInCaseload: async () => true,
      });
      for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
      registerAbacRegistry(registry);
      const app = buildServer({
        db: handle.db as never,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      registerCarePlanRoutes(app, { service });
      return {
        app,
        patientId,
        admissionId,
        authHeaders: { "x-test-user": "author_1", "x-test-org": org },
      };
    });
  });
});
