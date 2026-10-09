/**
 * M23 validation OVERRIDE — LIVE Postgres proof (the `ports.audit` deny-stub 503 fix).
 *
 * `POST /api/v1/claims/:id/validation-runs/:runId/results/:resultId/override` answered 503 "the override audit port is
 * not bound" because the composition root never passed `ports.audit`. This drives the REAL route (real guards, a stand-in
 * only for the M3 override-eligibility / step-up predicates) over the real write service on the NOBYPASSRLS `wardenx_app`
 * role, with the audit port built by the same factory the composition root uses, and proves:
 *   - 201 for an eligible actor with step-up; one prominent `m23.validation.override_applied` audit_event is written in the
 *     same transaction, its id is the override's NOT-NULL `m4_audit_event_id`, and it carries ids, the rule key, the role
 *     and the reason LENGTH only: never the free-text reason;
 *   - 403 without the permission, 403 without step-up, 404 for an unknown result or a result of another claim, 409 for a
 *     second override and for a passing result, 422 for a short reason, and in every failure NOTHING is written;
 *   - the override does not move the claim (still not a DRAFT) and the draft-delete guard (migration 1061) still refuses it;
 *   - an unbound audit port stays a fail-closed 503 that writes nothing.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m23:validation-override:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { type DbClient, createDbClient } from "@wardenx/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildM23OverrideAuditPort } from "../src/m23-override-audit";
import { buildDrizzleM23ReadService } from "../src/modules/23-billing-medicare/routes/read-service-drizzle";
import { registerValidationRoutes } from "../src/modules/23-billing-medicare/routes/validation.routes";
import { buildDrizzleM23WriteService } from "../src/modules/23-billing-medicare/routes/write-service-drizzle";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEMBERSHIP = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const PE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ANY = "99999999-9999-4999-8999-999999999999";
const REASON =
  "Payer confirmed by phone on 2026-09-30 that the missing modifier is not required for this level of care.";
const EVENT = "m23.validation.override_applied";

let seq = 0;
const uuid = (): string => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string") return;
  request.context.userId = user === "plain" ? OTHER_USER : USER;
  request.context.organizationId = ORG;
  request.context.roles = ["billing_manager"];
  request.context.attributes.membershipId = MEMBERSHIP;
  request.context.attributes.stepUpRecent = request.headers["x-test-stepup"] === "yes";
}

describe.skipIf(!DB_URL)("M23 validation override — LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  const servers: FastifyInstance[] = [];
  let idem = 0;
  const emitted: unknown[] = [];

  function server(bindAudit: boolean): FastifyInstance {
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: ORG,
          userId: USER,
          grants: [
            {
              roleKey: "seed",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["billing.validation.override", "billing.validation.read"],
            },
          ],
        },
        { orgId: ORG, userId: OTHER_USER, grants: [] },
      ]).store,
    );
    const reg = createPredicateRegistry();
    reg.register("provider_entity_billing_scope", async () => true);
    reg.register("override_role_eligible", async () => true);
    reg.register("step_up_recent", async (ctx) => ctx.attributes.stepUpRecent === true);
    registerAbacRegistry(reg);
    const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    registerValidationRoutes(app, {
      readService: buildDrizzleM23ReadService(handle.db),
      writeService: buildDrizzleM23WriteService(handle.db, {
        outbox: { publish: async (_tx, input) => void emitted.push(input) },
        ...(bindAudit ? { audit: buildM23OverrideAuditPort() } : {}),
      }),
    });
    servers.push(app);
    return app;
  }

  async function seed(state = "READY", outcome = "fail") {
    const claimId = uuid();
    const runId = uuid();
    const resultId = uuid();
    await admin.query(
      `INSERT INTO claim (id, organization_id, provider_entity_id, patient_id, admission_id, election_period_id_from,
         election_period_id_to, patient_payer_id, tob, service_from, service_to, state, claim_control_number,
         mac_jurisdiction, sequestration_applied_pct, sequestration_policy_id, created_by_membership_id)
       VALUES ($1,$2,$3,$4,$4,$4,$4,$4,'811','2026-09-01','2026-09-30',$5,$6,'cgs_j15','2.00',$4,$7)`,
      [claimId, ORG, PE, uuid(), state, `CCN-${claimId}`, MEMBERSHIP],
    );
    await admin.query(
      `INSERT INTO validation_run (id, organization_id, claim_id, trigger, outcome, run_input_hash, rules_executed,
         rules_passed, rules_failed, rules_warn, rules_info, completed_at, duration_ms)
       VALUES ($1,$2,$3,'initial_assembly','failures_present',$4,1,0,1,0,0,now(),1)`,
      [runId, ORG, claimId, `h-${runId}`],
    );
    await admin.query(
      `INSERT INTO validation_result (id, organization_id, validation_run_id, rule_key, rule_version, severity, outcome)
       VALUES ($1,$2,$3,'modifier_required',1,'error',$4)`,
      [resultId, ORG, runId, outcome],
    );
    return { claimId, runId, resultId };
  }

  const url = (s: { claimId: string; runId: string; resultId: string }) =>
    `/api/v1/claims/${s.claimId}/validation-runs/${s.runId}/results/${s.resultId}/override`;
  const post = (
    app: FastifyInstance,
    s: Parameters<typeof url>[0],
    over: Record<string, unknown> = {},
    h: Record<string, string> = {},
  ) =>
    app.inject({
      method: "POST",
      url: url(s),
      headers: {
        "x-test-user": "admin",
        "x-test-stepup": "yes",
        "idempotency-key": `ov-${++idem}`,
        ...h,
      },
      payload: { reason: REASON, overrideRole: "billing_manager", ...over },
    });
  const written = async () => ({
    overrides: (await admin.query("SELECT count(*)::int AS n FROM validation_override")).rows[0]
      .n as number,
    events: (
      await admin.query("SELECT count(*)::int AS n FROM audit_event WHERE event_type=$1", [EVENT])
    ).rows[0].n as number,
    outbox: (
      await admin.query(
        "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m23.claim.override_applied'",
      )
    ).rows[0].n as number,
  });

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','org-a','org-a')",
      [ORG],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'ov-a@x.test'),($2,'ov-b@x.test')`,
      [USER, OTHER_USER],
    );
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
  }, 240_000);

  beforeEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
  });
  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  it("503s fail-closed and writes nothing when no audit port is bound", async () => {
    const s = await seed();
    const before = await written();
    const res = await post(server(false), s);
    expect(res.statusCode).toBe(503);
    expect(await written()).toEqual(before);
  });

  it("201s for an eligible actor with step-up, auditing ids and the rule only, and never the reason text", async () => {
    const s = await seed();
    const res = await post(server(true), s);
    expect(res.statusCode).toBe(201);
    const view = res.json();
    const { rows } = await admin.query(
      "SELECT id, resource_kind, resource_id, actor_user_id, severity, before, after, context FROM audit_event WHERE event_type=$1 AND resource_id=$2",
      [EVENT, s.resultId],
    );
    expect(rows).toHaveLength(1);
    const ev = rows[0];
    expect(ev.resource_kind).toBe("validation_result");
    expect(ev.actor_user_id).toBe(USER);
    expect(ev.context).toEqual({
      claimId: s.claimId,
      validationRunId: s.runId,
      ruleKey: "modifier_required",
      overrideRole: "billing_manager",
      reasonLength: REASON.length,
    });
    expect(JSON.stringify(ev)).not.toContain("Payer confirmed");
    const ov = (
      await admin.query(
        "SELECT m4_audit_event_id, reason FROM validation_override WHERE result_id=$1",
        [s.resultId],
      )
    ).rows[0];
    expect(ov.m4_audit_event_id).toBe(ev.id);
    expect(ov.reason).toBe(REASON);
    // the response is the override record returned to its own (step-up) author; it is the one place the reason echoes
    expect(view.overrideId).toBe(
      (await admin.query("SELECT id FROM validation_override WHERE result_id=$1", [s.resultId]))
        .rows[0].id,
    );
    // the emitted outbox event carries ids and the rule only
    const overrideEvents = emitted.filter((e) =>
      JSON.stringify(e).includes("m23.claim.override_applied"),
    );
    expect(overrideEvents.length).toBe(1);
    expect(JSON.stringify(overrideEvents)).not.toContain("Payer confirmed");
  });

  it("does not move the claim, and a non-DRAFT claim with an override stays undeletable (migration 1061)", async () => {
    const s = await seed("READY");
    expect((await post(server(true), s)).statusCode).toBe(201);
    expect(
      (await admin.query("SELECT state FROM claim WHERE id=$1", [s.claimId])).rows[0].state,
    ).toBe("READY");
    const app = new Client({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.org_id', $1, true)", [ORG]);
      await expect(
        app.query("DELETE FROM validation_override WHERE result_id=$1", [s.resultId]),
      ).rejects.toThrow(/M23_TABLE_APPEND_ONLY/);
      await app.query("ROLLBACK");
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.org_id', $1, true)", [ORG]);
      await expect(app.query("DELETE FROM claim WHERE id=$1", [s.claimId])).rejects.toThrow(
        /M23_CLAIM_NOT_DRAFT/,
      );
    } finally {
      await app.query("ROLLBACK").catch(() => undefined);
      await app.end();
    }
  });

  it("403s without the permission and without step-up, writing nothing", async () => {
    const s = await seed();
    const app = server(true);
    const before = await written();
    expect((await post(app, s, {}, { "x-test-user": "plain" })).statusCode).toBe(403);
    expect((await post(app, s, {}, { "x-test-stepup": "no" })).statusCode).toBe(403);
    expect(await written()).toEqual(before);
  });

  it("404s for an unknown result or a result of another claim; 409s for a repeat or a passing result; 422s a short reason", async () => {
    const s = await seed();
    const other = await seed();
    const pass = await seed("READY", "pass");
    const app = server(true);
    const before = await written();
    expect((await post(app, { ...s, resultId: uuid() })).statusCode).toBe(404);
    expect((await post(app, { ...s, resultId: other.resultId })).statusCode).toBe(404);
    expect((await post(app, pass)).statusCode).toBe(409);
    expect((await post(app, s, { reason: "too short" })).statusCode).toBeGreaterThanOrEqual(400);
    expect(await written()).toEqual(before);
    expect((await post(app, s)).statusCode).toBe(201);
    const afterFirst = await written();
    expect((await post(app, s)).statusCode).toBe(409);
    expect(await written()).toEqual(afterFirst);
  });
});
