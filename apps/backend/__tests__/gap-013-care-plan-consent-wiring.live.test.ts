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
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/gap-013-care-plan-consent-wiring.live.test.ts
 */
import { randomUUID } from "node:crypto";
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
import { type StoredConsent, createInMemoryConsentStore } from "@chartwarden/consent";
import { createDbClient } from "@chartwarden/db";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  buildCarePlanAbacPredicates,
  createDbCarePlanAbacResolver,
  mountCarePlanRoutes,
} from "../src/modules/07-care-plan/index";
import {
  buildDisciplinePlanAbacPredicates,
  buildDrizzleDisciplinePlanAbacResolver,
  buildDrizzleM15ReadService,
  buildDrizzleM15WriteService,
  mountM15Routes,
} from "../src/modules/15-discipline-care-plans/index";
import { registerConsentSeams } from "../src/modules/39-consent/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  // M15 stamps the acting membership off the context attributes; the M7 routes under test here do not, and
  // behave differently with one, so it is opt-in.
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes = {
      ...request.context.attributes,
      membershipId: membership,
      sessionClass: "staff",
    };
  }
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
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
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
    __resetSeamsForTest();
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
    // Bootstrap checks the body's admissionId against M6's AdmissionStatusReader (the admission must
    // belong to the URL patient and be active). This suite is about consent wiring, so any admission id
    // resolves to this tenant's patient.
    registerSeam("AdmissionStatusReader", {
      async getAdmissionPatientCare(_org: string, admissionId: string) {
        return { admissionId, patientId, status: "active", otherAdmissionUnderCare: false };
      },
    } as never);

    const app = buildServer({
      db: handle.db as never,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    // Every M7 write route requires an Idempotency-Key: a POST that sent none gets a fresh one.
    app.addHook("onRequest", async (request) => {
      if (request.method === "POST" && !request.headers["idempotency-key"]) {
        request.headers["idempotency-key"] = randomUUID();
      }
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
    async function seedPlanWithSudProblem(
      app: ReturnType<typeof bootApp>,
      auth: Record<string, string>,
    ) {
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
        payload: {
          description: "Opioid use disorder",
          kind: "related",
          source: "clinical",
          sudRelated: true,
        },
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

    /**
     * A plan whose initial version holds a SUD problem and a plain one, finalized and read back through the REAL
     * routes: route → `sudDisclosureAllowed` (plan to patient through the resolver) → M39's consent evaluator.
     * The version snapshot freezes every problem, so it is the surface the redaction has to hold on.
     */
    async function finalizedWorld(opts: { partTwoRelease?: boolean } = {}) {
      await seedTenant();
      const app = bootApp({
        grants: {
          author_1: [
            "care_plan.bootstrap",
            "care_plan.author",
            "care_plan.read",
            "care_plan.finalize",
          ],
        },
        // Built AFTER `seedTenant()`: a consent names the org and patient that call just minted.
        ...(opts.partTwoRelease ? { consents: [activeConsent("42_cfr_part_2_release")] } : {}),
      });
      const AUTH = { "x-test-user": "author_1", "x-test-org": org };
      const planId = await seedPlanWithSudProblem(app, AUTH);
      await app.inject({
        method: "POST",
        url: `/api/v1/care-plans/${planId}/problems`,
        headers: AUTH,
        payload: {
          description: "Terminal cancer",
          kind: "terminal",
          source: "clinical",
          sudRelated: false,
        },
      });
      const versionsUrl = `/api/v1/care-plans/${planId}/versions`;
      const draft = (await app.inject({ method: "GET", url: versionsUrl, headers: AUTH })).json()
        .items[0] as { id: string; version: number };
      const finalized = await app.inject({
        method: "POST",
        url: `${versionsUrl}/${draft.id}/finalize`,
        headers: AUTH,
        payload: { ifVersion: draft.version },
      });
      const one = await app.inject({
        method: "GET",
        url: `${versionsUrl}/${draft.id}`,
        headers: AUTH,
      });
      const all = await app.inject({ method: "GET", url: versionsUrl, headers: AUTH });
      await app.close();
      return { finalized, one, all };
    }

    it("withholds the SUD problem from the finalize result and the version reads for a caller with no Part 2 release", async () => {
      const { finalized, one, all } = await finalizedWorld();
      for (const res of [finalized, one, all]) {
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain("Opioid use disorder");
      }
      // The redaction is a filter, not a blanket null: what the caller may see is still there.
      expect(one.body).toContain("Dyspnea");
      expect(one.body).toContain("Terminal cancer");
    });

    it("shows the SUD problem on the same version reads for a caller with an active 42 CFR Part 2 release", async () => {
      const { finalized, one, all } = await finalizedWorld({ partTwoRelease: true });
      for (const res of [finalized, one, all]) {
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain("Opioid use disorder");
      }
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

  // The audit's CW-AC-43 gap 4: M15's own live tests drive the services with an INJECTED disclosure port, so
  // nothing proved that the real M15 routes resolve a caller's Part 2 verdict through the seam registry's M39
  // ConsentEvaluator (`seamDisclosurePort`) and carry it into the read filter and the write gate. This does:
  // real Fastify routes, real services over Postgres, the real evaluator over an in-memory consent store, and
  // NO port handed to `mountM15Routes`.
  describe("M15 discipline plans — route to M39 ConsentEvaluator chain", () => {
    const SUD_GOAL_TEXT = "SYNTHETIC-SUD-GOAL-TEXT";
    const SUD_IV_TEXT = "SYNTHETIC-SUD-INTERVENTION-TEXT";

    function bootM15(opts: { grants: Record<string, string[]>; consents?: StoredConsent[] }) {
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
      const registry = createPredicateRegistry();
      const predicates = {
        // `caseload_or_scope` lives in the care-plan set; no caseload rows are seeded, so it is permissive.
        ...buildCarePlanAbacPredicates({
          resolver: createDbCarePlanAbacResolver(handle.db),
          isInCaseload: async () => true,
        }),
        ...buildDisciplinePlanAbacPredicates({
          resolver: buildDrizzleDisciplinePlanAbacResolver(handle.db),
        }),
      };
      for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
      registerAbacRegistry(registry);
      const { store } = createInMemoryConsentStore({
        consents: opts.consents ?? [],
        deceasedPatientIds: new Set(),
      });
      registerConsentSeams({ store });
      registerSeam("CaseloadProvider", { isInCaseload: async () => true } as never);
      const app = buildServer({
        db: handle.db as never,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      app.addHook("onRequest", async (request) => {
        if (request.method !== "GET" && !request.headers["idempotency-key"]) {
          request.headers["idempotency-key"] = randomUUID();
        }
      });
      // No `disclosure` dependency: the routes must reach M39 through the seam registry, as in production.
      mountM15Routes(app, {
        readService: buildDrizzleM15ReadService(handle.db),
        writeService: buildDrizzleM15WriteService(handle.db),
      });
      return app;
    }

    async function seedDisciplinePlan() {
      // The audit rows (read audit, write-audit trigger) reference the acting user.
      await admin.query(
        `INSERT INTO "user" (id,email) VALUES ($1,'m15-chain@x.test') ON CONFLICT DO NOTHING`,
        [MSW_USER],
      );
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,'PE',$3,'enc','12-31') RETURNING id`,
          [org, `CCN-${randomUUID().slice(0, 8)}`, `NPI-${randomUUID().slice(0, 8)}`],
        )
      ).rows[0].id as string;
      const loc = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
             VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
      const planId = (
        await admin.query(
          `INSERT INTO discipline_care_plan (organization_id, patient_id, admission_id, provider_entity_id,
             location_id, kind, status) VALUES ($1,$2,$3,$4,$5,'msw_plan','active') RETURNING id`,
          [org, patientId, randomUUID(), pe, loc],
        )
      ).rows[0].id as string;
      const carePlanId = (
        await admin.query(
          `INSERT INTO care_plan (organization_id, provider_entity_id, location_id, patient_id, admission_id,
             status, initial_due_at) VALUES ($1,$2,$3,$4,$5,'active', now() + interval '5 days') RETURNING id`,
          [org, pe, loc, patientId, randomUUID()],
        )
      ).rows[0].id as string;
      const problemId = (
        await admin.query(
          `INSERT INTO problem (organization_id, provider_entity_id, location_id, care_plan_id, description, kind)
             VALUES ($1,$2,$3,$4,'Anticipatory grief','related') RETURNING id`,
          [org, pe, loc, carePlanId],
        )
      ).rows[0].id as string;
      const goal = async (text: string, sud: boolean) =>
        (
          await admin.query(
            `INSERT INTO discipline_goal (organization_id, provider_entity_id, location_id, plan_id,
               parent_problem_id, source, status, original_text, sud_related, added_by_membership_id,
               added_by_discipline) VALUES ($1,$2,$3,$4,$5,'clinical','in_progress',$6,$7,$8,'msw') RETURNING id`,
            [org, pe, loc, planId, problemId, text, sud, randomUUID()],
          )
        ).rows[0].id as string;
      const plainGoalId = await goal("Family will report reduced distress", false);
      const sudGoalId = await goal(SUD_GOAL_TEXT, true);
      await admin.query(
        `INSERT INTO discipline_intervention (organization_id, provider_entity_id, location_id, plan_id,
           goal_refs, scope_text, frequency_text, frequency_value, discipline, added_by_membership_id,
           added_by_discipline) VALUES ($1,$2,$3,$4,$5::jsonb,$6,'Weekly','1:visit:week','msw',$7,'msw')`,
        [org, pe, loc, planId, JSON.stringify([sudGoalId]), SUD_IV_TEXT, randomUUID()],
      );
      return { planId, plainGoalId, sudGoalId };
    }

    const AUTHOR = ["discipline_plan.read", "discipline_plan.author"];
    // A real uuid: the M4 write-audit trigger and the read-audit row cast the acting user to uuid.
    const MSW_USER = "44444444-4444-4444-8444-444444444444";
    const MSW_AUTH = () => ({
      "x-test-user": MSW_USER,
      "x-test-org": org,
      "x-test-membership": "33333333-3333-4333-8333-333333333333",
    });

    it("withholds Part 2 goals and the interventions that serve them from the read, and answers a write NOT FOUND, for a caller with no release", async () => {
      await seedTenant();
      const { planId, plainGoalId, sudGoalId } = await seedDisciplinePlan();
      const app = bootM15({ grants: { [MSW_USER]: AUTHOR } });
      const AUTH = { ...MSW_AUTH(), "x-test-roles": "msw" };

      const read = await app.inject({
        method: "GET",
        url: `/api/v1/discipline-plans/${planId}`,
        headers: AUTH,
      });
      expect(read.statusCode).toBe(200);
      expect(read.body).toContain("Family will report reduced distress");
      expect(read.body).not.toContain(SUD_GOAL_TEXT);
      expect(read.body).not.toContain(SUD_IV_TEXT);
      expect(read.body.toLowerCase()).not.toContain(sudGoalId.toLowerCase());
      expect(read.json().redacted_categories).toContain("sud");

      // A write is NOT FOUND whatever the If-Match says (a wrong one must not confirm the row exists).
      const patch = (goalId: string, version: number) =>
        app.inject({
          method: "PATCH",
          url: `/api/v1/discipline-plans/${planId}/goals/${goalId}`,
          headers: { ...AUTH, "if-match": `"${version}"` },
          payload: { measurableOutcome: "Engages in two sessions" },
        });
      const hidden = await patch(sudGoalId, 99);
      const missing = await patch(randomUUID(), 99);
      expect(hidden.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(hidden.json().error?.message ?? hidden.json().message).toBe(
        missing.json().error?.message ?? missing.json().message,
      );
      // A plain goal is unaffected.
      expect((await patch(plainGoalId, 0)).statusCode).toBe(200);
      await app.close();
    });

    it("shows them, and lets the write through, for a caller M39 clears with an active 42 CFR Part 2 release", async () => {
      await seedTenant();
      const { planId, sudGoalId } = await seedDisciplinePlan();
      const app = bootM15({
        grants: { [MSW_USER]: AUTHOR },
        consents: [activeConsent("42_cfr_part_2_release")],
      });
      const AUTH = { ...MSW_AUTH(), "x-test-roles": "msw" };

      const read = await app.inject({
        method: "GET",
        url: `/api/v1/discipline-plans/${planId}`,
        headers: AUTH,
      });
      expect(read.statusCode).toBe(200);
      expect(read.body).toContain(SUD_GOAL_TEXT);
      expect(read.body).toContain(SUD_IV_TEXT);
      expect(read.json().redacted_categories).not.toContain("sud");

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/v1/discipline-plans/${planId}/goals/${sudGoalId}`,
        headers: { ...AUTH, "if-match": '"0"' },
        payload: { measurableOutcome: "Engages in two sessions" },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.body).toContain(SUD_GOAL_TEXT);
      await app.close();
    });

    it("an unbound M39 evaluator REDACTS (fail closed): the seam outage never widens a read", async () => {
      await seedTenant();
      const { planId } = await seedDisciplinePlan();
      const app = bootM15({
        grants: { [MSW_USER]: AUTHOR },
        consents: [activeConsent("42_cfr_part_2_release")],
      });
      __resetSeamsForTest(); // the evaluator the routes resolve at call time is gone
      registerSeam("CaseloadProvider", { isInCaseload: async () => true } as never);
      const AUTH = { ...MSW_AUTH(), "x-test-roles": "msw" };
      const read = await app.inject({
        method: "GET",
        url: `/api/v1/discipline-plans/${planId}`,
        headers: AUTH,
      });
      expect(read.statusCode).toBe(200);
      expect(read.body).not.toContain(SUD_GOAL_TEXT);
      await app.close();
    });
  });
});
