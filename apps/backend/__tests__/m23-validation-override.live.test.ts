/**
 * M23 validation OVERRIDE — LIVE Postgres proof (the `ports.audit` deny-stub 503 fix).
 *
 * `POST /api/v1/claims/:id/validation-runs/:runId/results/:resultId/override` answered 503 "the override audit port is
 * not bound" because the composition root never passed `ports.audit`. This drives the REAL route (real guards) over the
 * real write service on the NOBYPASSRLS `wardenx_app` role, with the audit port built by the same factory the composition
 * root uses. The M23 `provider_entity_billing_scope` and `override_role_eligible` predicates are the REAL ones (resolving
 * facts from the database as `wardenx_app`); only the M3 `step_up_recent` predicate is a documented stand-in (it reads the
 * test header's step-up flag), because a real step-up needs an authenticated session this suite does not have. It proves:
 *   - 201 for an eligible actor with step-up; one prominent `m23.validation.override_applied` audit_event is written in the
 *     same transaction, its id is the override's NOT-NULL `m4_audit_event_id`, and it carries ids, the rule key, the role
 *     and the reason LENGTH only;
 *   - the free-text reason reaches NO audit_event at all (event type 'validation_override.insert' written by the row-level
 *     trigger is scrubbed by migration 1062), nor the outbox payload; it exists only on `validation_override.reason`;
 *   - the app event and the trigger event share the request's correlation id; the source IP is recorded;
 *   - 403 without the permission, 403 without step-up, 404 for an actor without the rule's override role, 404 for an unknown
 *     result or a result of another claim, 409 for a second override and for a passing result, a 4xx for a short reason,
 *     and in every failure NOTHING is written; a replay of the same Idempotency-Key returns the stored answer without a
 *     second write, and the same key from a different user is refused (409), not replayed;
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
} from "@chartwarden/auth";
import { type DbClient, createDbClient } from "@chartwarden/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildM23OverrideAuditPort } from "../src/m23-override-audit";
import { buildM23AbacPredicates } from "../src/modules/23-billing-medicare/abac-predicates";
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
  request.context.roles = user === "ineligible" ? ["scheduler"] : ["billing_manager"];
  request.context.providerEntityIds = [PE];
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
    // The REAL M23 predicates (facts resolved from the database as wardenx_app); only step_up_recent is a stand-in.
    for (const [name, predicate] of Object.entries(
      buildM23AbacPredicates({ db: handle.db as never }),
    )) {
      reg.register(name, predicate);
    }
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

  async function seed(state = "READY", outcome = "fail", ruleKey = "admission_codes_present") {
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
       VALUES ($1,$2,$3,$5,1,'error',$4)`,
      [resultId, ORG, runId, outcome, ruleKey],
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
      "SELECT id, resource_kind, resource_id, actor_user_id, severity, correlation_id, source_ip, before, after, context FROM audit_event WHERE event_type=$1 AND resource_id=$2",
      [EVENT, s.resultId],
    );
    expect(rows).toHaveLength(1);
    const ev = rows[0];
    expect(ev.resource_kind).toBe("validation_result");
    expect(ev.actor_user_id).toBe(USER);
    expect(ev.context).toEqual({
      claimId: s.claimId,
      validationRunId: s.runId,
      ruleKey: "admission_codes_present",
      overrideRole: "billing_manager",
      reasonLength: REASON.length,
    });
    expect(JSON.stringify(ev)).not.toContain("Payer confirmed");
    // The free-text reason reaches NO audit_event of ANY type (before / after / context), including the row-level trigger's.
    const leaks = await admin.query(
      `SELECT count(*)::int AS n FROM audit_event
        WHERE after::text LIKE $1 OR before::text LIKE $1 OR context::text LIKE $1`,
      [`%Payer confirmed%`],
    );
    expect(leaks.rows[0].n).toBe(0);
    // ... yet the trigger event exists and shows THAT the column was set, scrubbed.
    const trig = (
      await admin.query(
        "SELECT correlation_id, after FROM audit_event WHERE event_type='validation_override.insert' AND after->>'result_id'=$1",
        [s.resultId],
      )
    ).rows;
    expect(trig).toHaveLength(1);
    expect(trig[0].after.reason).toBe("<changed>");
    // Both events carry the request's correlation id (not 'system'), and the app event recorded the source IP.
    expect(trig[0].correlation_id).toBe(ev.correlation_id);
    expect(ev.correlation_id).not.toBe("system");
    expect(ev.source_ip).toBeTruthy();
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

  it("404s an actor who lacks the override role the rule demands (REAL override_role_eligible), writing nothing", async () => {
    const s = await seed();
    const before = await written();
    const res = await post(server(true), s, {}, { "x-test-user": "ineligible" });
    expect(res.statusCode).toBe(404);
    expect(await written()).toEqual(before);
    // the same actor with the right role is let through
    expect((await post(server(true), s)).statusCode).toBe(201);
  });

  it("replays the stored answer for the same Idempotency-Key without a second write, and refuses the same key from another user", async () => {
    const s = await seed();
    const app = server(true);
    const key = { "idempotency-key": `replay-${uuid()}` };
    const first = await post(app, s, {}, key);
    expect(first.statusCode).toBe(201);
    const afterFirst = await written();
    const again = await post(app, s, {}, key);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());
    expect(await written()).toEqual(afterFirst);
    // another user in the same org reusing the key (and the identical body) must NOT be handed the first user's answer
    const stolen = await post(app, s, {}, { ...key, "x-test-user": "plain" });
    expect(stolen.statusCode).toBe(409);
    expect(stolen.body).not.toContain(first.json().overrideId);
    expect(await written()).toEqual(afterFirst);
  });
  it("override-audit list filters a rule by BOTH spellings and projects the canonical key for legacy-keyed result rows", async () => {
    // validation_result is append-only, so the legacy key is seeded at insert time (as pre-1069 history would be).
    const legacy = await seed("READY", "fail", "hipps_coding_correct");
    const current = await seed("READY", "fail", "per_diem_class_coding_correct");
    for (const r of [legacy.resultId, current.resultId]) {
      await admin.query(
        `INSERT INTO validation_override (organization_id, result_id, override_membership_id, override_role_applied,
           reason, m4_audit_event_id) VALUES ($1,$2,$3,'billing_manager',$4,$5)`,
        [ORG, r, MEMBERSHIP, REASON, ANY],
      );
    }
    const actor = { organizationId: ORG, userId: USER, roles: ["billing_manager"] };
    const readService = buildDrizzleM23ReadService(handle.db);
    const wanted = new Set([legacy.claimId, current.claimId]);
    for (const filterKey of ["per_diem_class_coding_correct", "hipps_coding_correct"]) {
      const page = await readService.listValidationOverrides(
        actor,
        { providerEntityId: PE, ruleKey: filterKey },
        undefined,
        undefined,
      );
      const hits = page.items.filter((i) => wanted.has(i.claimId));
      expect(hits.map((i) => i.claimId).sort()).toEqual([legacy.claimId, current.claimId].sort());
      expect(hits.every((i) => i.ruleKey === "per_diem_class_coding_correct")).toBe(true);
    }
  });
});
