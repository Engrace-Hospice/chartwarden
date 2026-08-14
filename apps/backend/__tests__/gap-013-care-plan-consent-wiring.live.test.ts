/**
 * GAP-013 — production `mountCarePlanRoutes` never supplied `dpoaConsentActive`/`sudDisclosureAllowed`,
 * so both hard-defaulted to `async () => false`: every agent-stated (DPOA) goal was permanently refused
 * and every SUD-flagged problem was permanently redacted for every caller, including the assigned RN
 * Case Manager the spec explicitly carves out (§7.6). Fixed in
 * apps/backend/src/modules/07-care-plan/index.ts by wiring the two closures over the REAL M39
 * `ConsentEvaluator` seam + the RN-Case-Manager role check (`defaultConsentActiveChecker`/
 * `sudDisclosureAllowedForPatient`, abac-predicates.ts).
 *
 * Proves it end-to-end through the REAL Fastify routes (`mountCarePlanRoutes`, not the in-memory slice)
 * against real Postgres, registering a real (in-memory-backed) M39 `ConsentEvaluator` seam — this is
 * the seam boundary GAP-013's fix crosses, so the test must cross it too, not stub past it.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/gap-013-care-plan-consent-wiring.live.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createPredicateRegistry,
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { type StoredConsent, createInMemoryConsentStore } from "@wardenx/consent";
import { createDbClient } from "@wardenx/db";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  buildCarePlanAbacPredicates,
  createDbCarePlanAbacResolver,
  mountCarePlanRoutes,
} from "../src/modules/07-care-plan/index";
import { registerConsentSeams } from "../src/modules/39-consent/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

describe.skipIf(!DB_URL)("GAP-013 — M7 care-plan consent wiring — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let org: string;
  let patientId: string;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  afterEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
  });

  /** Fresh org + patient per test — isolates each scenario's consent/redaction state. */
  async function seedTenant(): Promise<void> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    org = (
      await admin.query(
        "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'CP13','CP13') RETURNING id",
        [`cp13-${suffix}`],
      )
    ).rows[0].id as string;
    patientId = (
      await admin.query(
        "INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status) VALUES ($1,$2,'Con','Sent','1990-01-01','F','active') RETURNING id",
        [org, `MRN-CP13-${suffix}`],
      )
    ).rows[0].id as string;
  }

  /** Boots a real server over `mountCarePlanRoutes` with the given RBAC grants + M39 consent dataset. */
  function bootApp(opts: { grants: Record<string, string[]>; consents?: StoredConsent[] }) {
    resetAuthorizationContract();
    resetRbacEngine();

    const grantStore = createInMemoryEffectivePermissionStore(
      Object.entries(opts.grants).map(([userId, permissionKeys]) => ({
        orgId: org,
        userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
      })),
    );
    registerEffectivePermissionResolver(grantStore.store);

    // GAP-011/012 pattern: a FRESH registry, `isInCaseload` stubbed permissive (no caseload rows are
    // seeded here — this test is about consent wiring, not caseload scoping).
    const registry = createPredicateRegistry();
    const predicates = buildCarePlanAbacPredicates({
      resolver: createDbCarePlanAbacResolver(handle.db),
      isInCaseload: async () => true,
    });
    for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
    registerAbacRegistry(registry);

    // The seam boundary GAP-013's fix crosses: a real (in-memory-backed) M39 ConsentEvaluator, not a
    // deny-stub — `mountCarePlanRoutes`'s closures resolve through `getSeam("ConsentEvaluator")`.
    const { store } = createInMemoryConsentStore({
      consents: opts.consents ?? [],
      deceasedPatientIds: new Set(),
    });
    registerConsentSeams({ store });

    const app = buildServer({
      db: handle.db as never,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    mountCarePlanRoutes(app, handle.db);
    return app;
  }

  function activeConsent(typeKey: StoredConsent["typeKey"]): StoredConsent {
    return {
      id: randomUUID(),
      organizationId: org,
      patientId,
      typeKey,
      status: "active",
      version: 1,
      effectiveAtMs: Date.parse("2020-01-01T00:00:00Z"),
      expiresAtMs: null,
      survivesDeath: false,
      scopeDescriptor: null,
      recipients: [{ removedAtMs: null, expiresAtMs: null }],
    };
  }

  describe("dpoa_active — agent-stated goal authoring", () => {
    it("422 DPOA_CONSENT_REQUIRED without an active dpoa_healthcare consent", async () => {
      await seedTenant();
      const app = bootApp({ grants: { author_1: ["care_plan.bootstrap", "care_plan.author"] } });
      const AUTH = { "x-test-user": "author_1", "x-test-org": org };

      const boot = await app.inject({
        method: "POST",
        url: `/api/v1/patients/${patientId}/care-plan`,
        headers: AUTH,
        payload: { admissionId: randomUUID() },
      });
      const planId = boot.json().id as string;
      const problem = await app.inject({
        method: "POST",
        url: `/api/v1/care-plans/${planId}/problems`,
        headers: AUTH,
        payload: { description: "Anxiety", kind: "related", source: "clinical" },
      });
      const problemId = problem.json().id as string;

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/care-plans/${planId}/goals`,
        headers: AUTH,
        payload: { problemId, originalText: "Family wants comfort focus", source: "agent_stated" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("DPOA_CONSENT_REQUIRED");
      await app.close();
    });

    it("201 with an active dpoa_healthcare consent on file", async () => {
      await seedTenant();
      const app = bootApp({
        grants: { author_1: ["care_plan.bootstrap", "care_plan.author"] },
        consents: [activeConsent("dpoa_healthcare")],
      });
      const AUTH = { "x-test-user": "author_1", "x-test-org": org };

      const boot = await app.inject({
        method: "POST",
        url: `/api/v1/patients/${patientId}/care-plan`,
        headers: AUTH,
        payload: { admissionId: randomUUID() },
      });
      const planId = boot.json().id as string;
      const problem = await app.inject({
        method: "POST",
        url: `/api/v1/care-plans/${planId}/problems`,
        headers: AUTH,
        payload: { description: "Anxiety", kind: "related", source: "clinical" },
      });
      const problemId = problem.json().id as string;

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/care-plans/${planId}/goals`,
        headers: AUTH,
        payload: { problemId, originalText: "Family wants comfort focus", source: "agent_stated" },
      });
      expect(res.statusCode).toBe(201);
      await app.close();
    });
  });

  describe("sud_disclosure_allowed — §7.6 SUD-problem redaction", () => {
    async function seedPlanWithSudProblem(app: ReturnType<typeof bootApp>, auth: Record<string, string>) {
      const boot = await app.inject({
        method: "POST",
        url: `/api/v1/patients/${patientId}/care-plan`,
        headers: auth,
        payload: { admissionId: randomUUID() },
      });
      const planId = boot.json().id as string;
      await app.inject({
        method: "POST",
        url: `/api/v1/care-plans/${planId}/problems`,
        headers: auth,
        payload: { description: "Opioid use disorder", kind: "related", source: "clinical", sudRelated: true },
      });
      await app.inject({
        method: "POST",
        url: `/api/v1/care-plans/${planId}/problems`,
        headers: auth,
        payload: { description: "Dyspnea", kind: "related", source: "clinical", sudRelated: false },
      });
      return planId;
    }

    it("redacts the SUD problem for a caller with neither the RN Case Manager role nor a Part 2 release", async () => {
      await seedTenant();
      const app = bootApp({
        grants: { author_1: ["care_plan.bootstrap", "care_plan.author", "care_plan.read"] },
      });
      const AUTH = { "x-test-user": "author_1", "x-test-org": org };
      await seedPlanWithSudProblem(app, AUTH);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${patientId}/care-plan`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.redacted).toBe(true);
      expect(body.problems.map((p: { description: string }) => p.description)).toEqual(["Dyspnea"]);
      await app.close();
    });

    it("does NOT redact the SUD problem for the assigned RN Case Manager (§7.6 carve-out)", async () => {
      await seedTenant();
      const app = bootApp({
        grants: { rn_1: ["care_plan.bootstrap", "care_plan.author", "care_plan.read"] },
      });
      const RN = { "x-test-user": "rn_1", "x-test-org": org, "x-test-roles": "rn_case_manager" };
      await seedPlanWithSudProblem(app, RN);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${patientId}/care-plan`,
        headers: RN,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.redacted).toBe(false);
      expect(body.problems.map((p: { description: string }) => p.description).sort()).toEqual([
        "Dyspnea",
        "Opioid use disorder",
      ]);
      await app.close();
    });

    it("does NOT redact the SUD problem for a non-RN caller with an active 42 CFR Part 2 release", async () => {
      await seedTenant();
      const app = bootApp({
        grants: { author_1: ["care_plan.bootstrap", "care_plan.author", "care_plan.read"] },
        consents: [activeConsent("42_cfr_part_2_release")],
      });
      const AUTH = { "x-test-user": "author_1", "x-test-org": org };
      await seedPlanWithSudProblem(app, AUTH);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${patientId}/care-plan`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.redacted).toBe(false);
      expect(body.problems.map((p: { description: string }) => p.description).sort()).toEqual([
        "Dyspnea",
        "Opioid use disorder",
      ]);
      await app.close();
    });
  });
});
