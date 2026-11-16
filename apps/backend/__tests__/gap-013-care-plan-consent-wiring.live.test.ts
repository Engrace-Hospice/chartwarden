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
import { runWithRequestContext } from "@chartwarden/tenancy";
import type { CarePlanElementsAudience } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  buildCarePlanAbacPredicates,
  createCarePlanReader,
  createDbCarePlanAbacResolver,
  createDrizzleCarePlanReaderStore,
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

  const SUD_PROBLEM = "SYNTHETIC-SUD-PROBLEM";
  const PLAIN_PROBLEM = "SYNTHETIC-PLAIN-PROBLEM";
  const releaseNaming = (membershipId: string): StoredConsent => ({
    ...activeConsent("42_cfr_part_2_release"),
    recipients: [
      {
        removedAtMs: null,
        expiresAtMs: null,
        recipientResolvedKind: "workforce_member",
        recipientResolvedId: membershipId,
      },
    ],
  });

  // The workforce member the release names, and one it does not.
  const NAMED = "member-b";
  const OTHER = "member-a";

  // A real uuid: the read-audit row casts the acting user to uuid, and the best-effort emitter swallows a failure,
  // so a non-uuid reader would leave no trail and the audit assertion below would be vacuous.
  const READER = "55555555-5555-4555-8555-555555555555";

  /**
   * Seeds a fresh tenant with one plan carrying a SUD problem and a plain problem, each served by an `rn` intervention
   * and a goal, authored through the real M7 routes. `evaluator: "unbound"` unregisters the M39 evaluator after the
   * plan is seeded (and re-registers only the CarePlanReader), so the read itself meets the outage. Returns the live
   * app (the caller closes it) and the two problem ids.
   */
  async function seedSudPlan(
    release: ((membershipId: string) => StoredConsent) | null,
    opts: { evaluator?: "bound" | "unbound" } = {},
  ) {
    await seedTenant();
    // The audit row's actor is a foreign key to `user`: without this row the insert fails and is swallowed.
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'reader@gap013.test') ON CONFLICT DO NOTHING`,
      [READER],
    );
    const app = bootApp({
      grants: {
        author_1: ["care_plan.bootstrap", "care_plan.author", "care_plan.read"],
        [READER]: ["care_plan.read"],
      },
      consents: release ? [release(NAMED)] : [],
    });
    registerSeam(
      "CarePlanReader",
      createCarePlanReader(createDrizzleCarePlanReaderStore(handle.db)),
    );
    const AUTHOR = { "x-test-user": "author_1", "x-test-org": org, "x-test-roles": "rn" };
    const boot = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${patientId}/care-plan`,
      headers: AUTHOR,
      payload: { admissionId: randomUUID() },
    });
    const planId = boot.json().id as string;
    for (const [description, sudRelated] of [
      [SUD_PROBLEM, true],
      [PLAIN_PROBLEM, false],
    ] as const) {
      await app.inject({
        method: "POST",
        url: `/api/v1/care-plans/${planId}/problems`,
        headers: AUTHOR,
        payload: { description, kind: "related", source: "clinical", sudRelated },
      });
    }
    const { rows } = await admin.query(
      "SELECT id, description FROM problem WHERE care_plan_id = $1",
      [planId],
    );
    const problemRows = rows as { id: string; description: string }[];
    for (const row of problemRows) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/care-plans/${planId}/interventions`,
        headers: AUTHOR,
        payload: {
          problemId: row.id,
          scopeText: `visit for ${row.description}`,
          frequencyText: "weekly",
          frequencyValue: "1/week",
          discipline: "rn",
        },
      });
      expect(res.statusCode, row.description).toBe(201);
      const goal = await app.inject({
        method: "POST",
        url: `/api/v1/care-plans/${planId}/goals`,
        headers: AUTHOR,
        payload: {
          problemId: row.id,
          originalText: `goal for ${row.description}`,
          source: "clinical",
        },
      });
      expect(goal.statusCode, `goal for ${row.description}`).toBe(201);
    }
    if (opts.evaluator === "unbound") {
      __resetSeamsForTest();
      registerSeam(
        "CarePlanReader",
        createCarePlanReader(createDrizzleCarePlanReaderStore(handle.db)),
      );
    }
    const idOf = (description: string) =>
      problemRows.find((r) => r.description === description)?.id as string;
    return { app, planId, sudProblemId: idOf(SUD_PROBLEM), plainProblemId: idOf(PLAIN_PROBLEM) };
  }

  // Compliance review of D-2 (HIGH). The internal relevant-elements read asked the PATIENT-level question ("does the
  // release have any active recipient?"), so a nurse the release does not name still received the SUD problem and the
  // interventions that serve it. It now takes the caller's per-ACTOR verdict, the one every other M7 read redacts by.
  // Real routes, real evaluator (in-memory consent store), real CarePlanReader over the Drizzle store.
  describe("relevant-elements — per-ACTOR Part 2 redaction", () => {
    /**
     * A plan with one SUD problem and one plain problem, each served by an `rn` intervention, read as `caller`.
     * `membership: null` sends no membership id; `evaluator: "unbound"` unregisters the M39 evaluator after the
     * plan is seeded, so the read itself meets the outage.
     */
    async function readAs(
      caller: { membership: string | null; roles: string },
      release: ((membershipId: string) => StoredConsent) | null,
      opts: { evaluator?: "bound" | "unbound" } = {},
    ) {
      const { app } = await seedSudPlan(release, opts);
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/internal/care-plan/relevant-elements?patientId=${patientId}&encounterType=routine&discipline=rn`,
        headers: {
          "x-test-user": READER,
          "x-test-org": org,
          "x-test-roles": caller.roles,
          ...(caller.membership ? { "x-test-membership": caller.membership } : {}),
        },
      });
      await app.close();
      expect(res.statusCode).toBe(200);
      // The read is accounted against the patient (§164.528): `resource_id` falls back to the patient id.
      const { rows: audit } = await admin.query(
        `SELECT event_type, resource_id, actor_user_id, organization_id, context FROM audit_event WHERE resource_kind = 'care_plan_element' AND resource_id = $1`,
        [patientId],
      );
      return {
        ...(res.json() as {
          redacted: boolean;
          problems: { description: string }[];
          goals: { text: string }[];
          interventions: { scopeText: string }[];
        }),
        audit: audit as {
          event_type: string;
          resource_id: string;
          actor_user_id: string;
          organization_id: string;
          context: unknown;
        }[],
      };
    }

    it("withholds the SUD problem, its goal and its intervention from a nurse the release does NOT name, and the read leaves its audit event", async () => {
      const body = await readAs({ membership: OTHER, roles: "rn" }, releaseNaming);
      expect(body.redacted).toBe(true);
      expect(body.problems.map((p) => p.description)).toEqual([PLAIN_PROBLEM]);
      expect(body.goals.map((g) => g.text)).toEqual([`goal for ${PLAIN_PROBLEM}`]);
      expect(body.interventions.map((i) => i.scopeText)).toEqual([`visit for ${PLAIN_PROBLEM}`]);
      // A read-audit config's resource id falls back to the patient id and the emitter swallows a failed insert, so a
      // live suite must assert the read event actually lands (CLAUDE.md "Standing verification habits").
      expect(body.audit).toHaveLength(1);
      expect(body.audit[0]?.event_type).toBe("care_plan_element.viewed");
      expect(body.audit[0]?.actor_user_id).toBe(READER);
      expect(body.audit[0]?.organization_id).toBe(org);
      expect(body.audit[0]?.context).toMatchObject({ patientId });
    });

    it("fails closed with no membership id against a release that names staff (actor_unidentified), even for the RN case manager", async () => {
      // A plain `rn` is redacted whatever the restriction flag says; the case manager is the one the carve-out would
      // let through, so this is the caller that proves an unidentified actor counts as "restricted to named staff".
      const body = await readAs({ membership: null, roles: "rn,rn_case_manager" }, releaseNaming);
      expect(body.redacted).toBe(true);
      expect(body.problems.map((p) => p.description)).toEqual([PLAIN_PROBLEM]);
    });

    it("fails closed when the M39 evaluator is unbound: the outage narrows the read, never widens it", async () => {
      // The RN case manager is the caller the §7.6 carve-out would let through if the evaluator's catch block stopped
      // marking the verdict restricted, so it is the caller that proves the outage narrows rather than widens.
      const body = await readAs({ membership: NAMED, roles: "rn,rn_case_manager" }, releaseNaming, {
        evaluator: "unbound",
      });
      expect(body.redacted).toBe(true);
      expect(body.problems.map((p) => p.description)).toEqual([PLAIN_PROBLEM]);
      expect(body.interventions.map((i) => i.scopeText)).toEqual([`visit for ${PLAIN_PROBLEM}`]);
    });

    it("shows them to the workforce member the release names", async () => {
      const body = await readAs({ membership: NAMED, roles: "rn" }, releaseNaming);
      expect(body.redacted).toBe(false);
      expect(body.problems.map((p) => p.description).sort()).toEqual([PLAIN_PROBLEM, SUD_PROBLEM]);
      expect(body.goals.map((g) => g.text).sort()).toEqual([
        `goal for ${PLAIN_PROBLEM}`,
        `goal for ${SUD_PROBLEM}`,
      ]);
      expect(body.interventions).toHaveLength(2);
    });

    it("withholds them from a plain nurse when there is no release at all", async () => {
      const body = await readAs({ membership: OTHER, roles: "rn" }, null);
      expect(body.redacted).toBe(true);
      expect(body.problems.map((p) => p.description)).toEqual([PLAIN_PROBLEM]);
    });

    it("treats the RN case manager as every other M7 read does: §7.6 carve-out only where no release names others", async () => {
      const noRelease = await readAs({ membership: OTHER, roles: "rn,rn_case_manager" }, null);
      expect(noRelease.redacted).toBe(false);
      expect(noRelease.problems).toHaveLength(2);
      const namesOthers = await readAs(
        { membership: OTHER, roles: "rn,rn_case_manager" },
        releaseNaming,
      );
      expect(namesOthers.redacted).toBe(true);
      expect(namesOthers.problems.map((p) => p.description)).toEqual([PLAIN_PROBLEM]);
    });
  });

  // R-80/R-82. M8's visit-to-problem link check and M15's parent-element check validate the ids the picker offered,
  // so they must apply the picker's rule. They pass the SESSION identity (`{ actor: { roles, membershipId } }`) and
  // the store resolves the per-actor verdict itself (M39 `evaluateForInternalAccess` + the §7.6 carve-out). Here the
  // REAL reader over the Drizzle store is called directly, with the real evaluator, exactly as those callers do; the
  // `"patient_level"` control in each looser/stricter case proves the assertion can fail.
  describe("link validation — the actor audience resolves per ACTOR", () => {
    async function seedAndAsk(
      release: ((membershipId: string) => StoredConsent) | null,
      opts: { evaluator?: "bound" | "unbound" } = {},
    ) {
      const { app, sudProblemId, plainProblemId } = await seedSudPlan(release, opts);
      await app.close();
      const reader = createCarePlanReader(createDrizzleCarePlanReaderStore(handle.db));
      const ask = async (viewer: CarePlanElementsAudience): Promise<string[]> => {
        const elements = await runWithRequestContext(
          { organizationId: org, userId: READER } as never,
          () =>
            reader.relevantElementsForEncounter(
              patientId as never,
              "routine",
              "rn",
              undefined,
              viewer,
            ),
        );
        return (elements?.problems ?? []).map((p) => p.problemId).sort();
      };
      return { ask, both: [sudProblemId, plainProblemId].sort(), plainOnly: [plainProblemId] };
    }

    it("a nurse the release does NOT name cannot validate the Part 2 problem (patient-level would have allowed it)", async () => {
      const { ask, both, plainOnly } = await seedAndAsk(releaseNaming);
      expect(await ask({ actor: { roles: ["rn"], membershipId: OTHER } })).toEqual(plainOnly);
      // Control: the looser patient-level rule says "a release with an active recipient exists", so it admits her.
      expect(await ask("patient_level")).toEqual(both);
    });

    it("the workforce member the release names validates both problems", async () => {
      const { ask, both } = await seedAndAsk(releaseNaming);
      expect(await ask({ actor: { roles: ["rn"], membershipId: NAMED } })).toEqual(both);
    });

    it("the RN case manager validates the Part 2 problem when no release is on file (patient-level used to drop it)", async () => {
      const { ask, both, plainOnly } = await seedAndAsk(null);
      expect(
        await ask({ actor: { roles: ["rn", "rn_case_manager"], membershipId: OTHER } }),
      ).toEqual(both);
      // Control: the stricter patient-level rule finds no release and drops it, which is the 422 the picker disagreed with.
      expect(await ask("patient_level")).toEqual(plainOnly);
    });

    it("the RN case manager with no membership id is refused against a release that names staff (actor_unidentified)", async () => {
      const { ask, plainOnly } = await seedAndAsk(releaseNaming);
      expect(
        await ask({ actor: { roles: ["rn", "rn_case_manager"], membershipId: null } }),
      ).toEqual(plainOnly);
    });

    it("fails closed when the M39 evaluator is unbound, even for a named member who is also the case manager", async () => {
      const { ask, plainOnly } = await seedAndAsk(releaseNaming, { evaluator: "unbound" });
      expect(
        await ask({ actor: { roles: ["rn", "rn_case_manager"], membershipId: NAMED } }),
      ).toEqual(plainOnly);
    });

    it("a plain nurse cannot validate the Part 2 problem when there is no release at all", async () => {
      const { ask, plainOnly } = await seedAndAsk(null);
      expect(await ask({ actor: { roles: ["rn"], membershipId: OTHER } })).toEqual(plainOnly);
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
      return { planId, plainGoalId, sudGoalId, pe, loc, carePlanId };
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

    // R-80/R-82 through the REAL M15 route: the parent-element check asks M7's reader under the actor's own rule, the
    // one the picker used. The reader is the real one over the Drizzle store, the evaluator the real in-memory M39.
    describe("goal parent check — per-ACTOR Part 2 (route `POST /discipline-plans/:planId/goals`)", () => {
      async function seedPlanWithPart2Problem() {
        await seedTenant();
        const seeded = await seedDisciplinePlan();
        const sudProblemId = (
          await admin.query(
            `INSERT INTO problem (organization_id, provider_entity_id, location_id, care_plan_id, description, kind, sud_related)
             VALUES ($1,$2,$3,$4,'SYNTHETIC-PART2-PROBLEM','related',true) RETURNING id`,
            [org, seeded.pe, seeded.loc, seeded.carePlanId],
          )
        ).rows[0].id as string;
        return { planId: seeded.planId, sudProblemId };
      }

      const NAMED_MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
      const OTHER_MEMBERSHIP = "77777777-7777-4777-8777-777777777777";

      function postGoal(
        app: ReturnType<typeof bootM15>,
        planId: string,
        parentProblemId: string,
        actor: { membership: string; roles: string },
      ) {
        return app.inject({
          method: "POST",
          url: `/api/v1/discipline-plans/${planId}/goals`,
          headers: {
            ...MSW_AUTH(),
            "x-test-membership": actor.membership,
            "x-test-roles": actor.roles,
          },
          payload: {
            parentProblemId,
            // `patient_stated`: the one source value both the route schema and the DB enum accept for a human-authored goal
            // (the schema's `clinician_authored` is not a `discipline_goal_source` value, so it would 500 on insert).
            source: "patient_stated",
            originalText: "SYNTHETIC-GOAL-UNDER-PART2",
            addedByDiscipline: "msw",
          },
        });
      }

      async function bootWithRealReader(release: StoredConsent | null) {
        const app = bootM15({
          grants: { [MSW_USER]: AUTHOR },
          consents: release ? [release] : [],
        });
        registerSeam(
          "CarePlanReader",
          createCarePlanReader(createDrizzleCarePlanReaderStore(handle.db)),
        );
        return app;
      }

      it("422 PARENT_ELEMENT_NOT_FOUND for a nurse the release does not name, 201 for the member it names", async () => {
        const { planId, sudProblemId } = await seedPlanWithPart2Problem();
        const app = await bootWithRealReader(releaseNaming(NAMED_MEMBERSHIP));

        const other = await postGoal(app, planId, sudProblemId, {
          membership: OTHER_MEMBERSHIP,
          roles: "msw",
        });
        expect(other.statusCode).toBe(422);
        expect(JSON.stringify(other.json())).toContain("PARENT_ELEMENT_NOT_FOUND");

        const named = await postGoal(app, planId, sudProblemId, {
          membership: NAMED_MEMBERSHIP,
          roles: "msw",
        });
        expect(named.statusCode).toBe(201);
        expect(named.json().parentProblemId).toBe(sudProblemId);
        await app.close();
      });

      it("201 for the RN case manager with no release on file (the picker shows it), 422 for a plain clinician", async () => {
        const { planId, sudProblemId } = await seedPlanWithPart2Problem();
        const app = await bootWithRealReader(null);

        const plain = await postGoal(app, planId, sudProblemId, {
          membership: OTHER_MEMBERSHIP,
          roles: "msw",
        });
        expect(plain.statusCode).toBe(422);
        expect(JSON.stringify(plain.json())).toContain("PARENT_ELEMENT_NOT_FOUND");

        const caseManager = await postGoal(app, planId, sudProblemId, {
          membership: OTHER_MEMBERSHIP,
          roles: "msw,rn_case_manager",
        });
        expect(caseManager.statusCode).toBe(201);
        await app.close();
      });
    });

    it("the version detail and list routes withhold a sealed Part 2 goal without a release and show it with one (real evaluator)", async () => {
      await seedTenant();
      const { planId, pe, loc } = await seedDisciplinePlan();
      const versionId = (
        await admin.query(
          `INSERT INTO discipline_care_plan_version (organization_id, provider_entity_id, location_id, plan_id,
             sequence, status, kind, state_snapshot, required_signer_set, finalized_at, signed_at)
           VALUES ($1,$2,$3,$4,1,'signed','initial',$5::jsonb,'[]'::jsonb, now(), now()) RETURNING id`,
          [
            org,
            pe,
            loc,
            planId,
            JSON.stringify({
              goals: [
                { goalId: randomUUID(), sudRelated: true, originalText: SUD_GOAL_TEXT },
                { goalId: randomUUID(), sudRelated: false, originalText: "Plain sealed goal" },
              ],
              interventions: [],
            }),
          ],
        )
      ).rows[0].id as string;
      const urls = [
        `/api/v1/discipline-plans/${planId}/versions/${versionId}`,
        `/api/v1/discipline-plans/${planId}/versions`,
      ];
      const without = bootM15({ grants: { [MSW_USER]: AUTHOR } });
      for (const url of urls) {
        const res = await without.inject({
          method: "GET",
          url,
          headers: { ...MSW_AUTH(), "x-test-roles": "msw" },
        });
        expect(res.statusCode).toBe(200);
        // Only the detail carries the sealed snapshot; the list is metadata and must not leak either way.
        if (url.endsWith(versionId)) expect(res.body).toContain("Plain sealed goal");
        expect(res.body).not.toContain(SUD_GOAL_TEXT);
      }
      await without.close();
      const withRelease = bootM15({
        grants: { [MSW_USER]: AUTHOR },
        consents: [activeConsent("42_cfr_part_2_release")],
      });
      for (const url of urls) {
        const res = await withRelease.inject({
          method: "GET",
          url,
          headers: { ...MSW_AUTH(), "x-test-roles": "msw" },
        });
        expect(res.statusCode).toBe(200);
        if (url.endsWith(versionId)) expect(res.body).toContain(SUD_GOAL_TEXT);
      }
      await withRelease.close();
    });

    it("the ops outbox detail read withholds a decision's text, names the patient in the read audit, and the audit event lands", async () => {
      await seedTenant();
      await admin.query(
        `INSERT INTO "user" (id,email) VALUES ($1,'m15-chain@x.test') ON CONFLICT DO NOTHING`,
        [MSW_USER],
      );
      const eventId = (
        await admin.query(
          `INSERT INTO outbox_event (organization_id, event_type, aggregate_kind, aggregate_id, payload)
           VALUES ($1,'idg.decision_recorded','idg_decision',$2,$3::jsonb) RETURNING id`,
          [
            org,
            randomUUID(),
            JSON.stringify({
              decisionId: randomUUID(),
              patientId,
              payload: {
                kind: "care_plan_update",
                mutations: [
                  {
                    op: "problem_add",
                    description: "SYNTHETIC-PART2-TEXT",
                    icd10Code: "F10.20",
                    problemKind: "related",
                    sudRelated: true,
                  },
                ],
              },
            }),
          ],
        )
      ).rows[0].id as string;
      const app = bootM15({ grants: { [MSW_USER]: ["member.manage"] } });
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/ops/outbox/${eventId}`,
        headers: MSW_AUTH(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("SYNTHETIC-PART2-TEXT");
      expect(res.body).not.toContain("F10.20");
      expect(res.body).toContain("problem_add");
      const audit = await admin.query(
        `SELECT event_type, context FROM audit_event WHERE resource_kind='outbox_event' AND resource_id=$1`,
        [eventId],
      );
      expect(audit.rows.length).toBeGreaterThan(0);
      expect(audit.rows[0].event_type).toBe("outbox_event.viewed");
      expect(JSON.stringify(audit.rows[0].context)).toContain(patientId);
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
