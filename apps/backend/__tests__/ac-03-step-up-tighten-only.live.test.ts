/**
 * AC-03 — the step-up tighten-only invariant, LIVE Postgres (M2 §4.3.2 / D9).
 *
 * `trg_tenant_step_up_tighten_only` was asserted by name in
 * `02-identity/policy/step-up-resolver.ts` ("the DB trigger is the at-rest guard; this is its
 * app-layer twin") and appeared in NONE of the 210 migrations. Migration 0006, which created
 * `tenant_step_up_policy_override`, recorded the deferral — "adds a tighten-only trigger (§3.7, D9);
 * those are authorization concerns that wire in with Module 3". Module 3 landed; the trigger did not.
 *
 * The app-layer half was equally absent: `tightenStepUpPolicy` had ZERO production callers, no
 * Drizzle reader for the table existed, and M3's `step_up_recent` evaluated the raw floor. So the
 * live exposure ran OPPOSITE to the obvious reading — not "a tenant can loosen the floor" but "a
 * tenant who TIGHTENS is silently ignored".
 *
 * This suite proves both halves against a real database, as the NOBYPASSRLS `chartwarden_app` role:
 * the trigger refuses a loosening row at WRITE time, and the Drizzle store + seam make a tightening
 * row bind at EVALUATION time.
 *
 * THE FLOOR-DRIFT GUARD. The platform floor now exists twice — `STEP_UP_POLICY` in TypeScript and
 * the constants inside the trigger function. Every boundary case below is DERIVED from
 * `STEP_UP_POLICY`, so raising the TS floor without touching the SQL (or the reverse) fails here.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m2:step-up-override:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInMemorySessionContextStore, createSessionContextResolver } from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { STEP_UP_POLICY } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDrizzleStepUpOverrideStore } from "../src/modules/02-identity/step-up-override-store";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-111111ac0301";
const ORG_B = "11111111-1111-4111-8111-111111ac0302";
const USER = "22222222-2222-4222-8222-222222ac0301";
const OP = "erx.sign";
const NOW = new Date("2026-08-14T12:00:00Z");

/** The floor, read from the ONE TypeScript definition the SQL trigger must agree with. */
const FLOOR_FACTORS = STEP_UP_POLICY.qualifyingFactors;
const FLOOR_MAX_AGE = STEP_UP_POLICY.defaultMaxAgeSec;
/** Every enum label the floor does NOT admit — `sms` today, whatever is added tomorrow. */
const NON_FLOOR_FACTORS = (["webauthn", "totp", "sms"] as const).filter(
  (f) => !FLOOR_FACTORS.includes(f),
);

describe.skipIf(!DB_URL)("AC-03 step-up tighten-only — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const memberOf: Record<string, string> = {};

  const insertOverride = (
    org: string,
    factors: readonly string[],
    maxAgeSec: number,
    operationKey = OP,
  ) =>
    admin.query(
      `INSERT INTO tenant_step_up_policy_override
         (organization_id, operation_key, qualifying_factors, max_age_sec, rationale, configured_by_membership_id)
       VALUES ($1,$2,$3::step_up_factor[],$4,'board-mandated hardening for controlled-substance signing',$5)`,
      [org, operationKey, factors, maxAgeSec, memberOf[org]],
    );

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

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
    await applyMigrations();

    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'ac03-a','A','A','active'),($2,'ac03-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'u@ac03.test')`, [USER]);
    for (const org of [ORG_A, ORG_B]) {
      const m = await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [USER, org],
      );
      memberOf[org] = m.rows[0].id;
    }

    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM tenant_step_up_policy_override");
  });

  // ── the at-rest half: trg_tenant_step_up_tighten_only ───────────────────────────────────────
  it("the trigger EXISTS on the table (it was asserted in code and never built)", async () => {
    const rows = await admin.query(
      `SELECT tgname FROM pg_trigger
       WHERE tgrelid = 'tenant_step_up_policy_override'::regclass AND NOT tgisinternal`,
    );
    expect(rows.rows.map((r) => r.tgname)).toContain("trg_tenant_step_up_tighten_only");
  });

  it("REFUSES a factor outside the platform floor (the SMS case)", async () => {
    expect(NON_FLOOR_FACTORS.length).toBeGreaterThan(0); // the floor must exclude something
    for (const bad of NON_FLOOR_FACTORS) {
      await expect(insertOverride(ORG_A, [...FLOOR_FACTORS, bad], FLOOR_MAX_AGE)).rejects.toThrow(
        /may only TIGHTEN/,
      );
    }
    const rows = await admin.query("SELECT count(*)::int AS n FROM tenant_step_up_policy_override");
    expect(rows.rows[0].n).toBe(0);
  });

  it("REFUSES a freshness window longer than the floor, ACCEPTS one equal or shorter", async () => {
    await expect(insertOverride(ORG_A, FLOOR_FACTORS, FLOOR_MAX_AGE + 1)).rejects.toThrow(
      /may only TIGHTEN/,
    );
    // Exactly the floor is not a loosening — it is the default restated.
    await insertOverride(ORG_A, FLOOR_FACTORS, FLOOR_MAX_AGE);
    await admin.query("DELETE FROM tenant_step_up_policy_override");
    await insertOverride(ORG_A, FLOOR_FACTORS, Math.floor(FLOOR_MAX_AGE / 5));
  });

  it("REFUSES a non-positive window and an EMPTY qualifying set (lockouts, not tightenings)", async () => {
    await expect(insertOverride(ORG_A, FLOOR_FACTORS, 0)).rejects.toThrow(/must be positive/);
    await expect(insertOverride(ORG_A, [], FLOOR_MAX_AGE)).rejects.toThrow(/at least one factor/);
  });

  it("fires on UPDATE too — a row cannot be loosened after it is written", async () => {
    await insertOverride(ORG_A, FLOOR_FACTORS, 60);
    await expect(
      admin.query("UPDATE tenant_step_up_policy_override SET max_age_sec = $1", [
        FLOOR_MAX_AGE + 1,
      ]),
    ).rejects.toThrow(/may only TIGHTEN/);
    const rows = await admin.query("SELECT max_age_sec FROM tenant_step_up_policy_override");
    expect(rows.rows[0].max_age_sec).toBe(60);
  });

  it("allows at most ONE override per (organization, operation)", async () => {
    await insertOverride(ORG_A, FLOOR_FACTORS, 60);
    await expect(insertOverride(ORG_A, FLOOR_FACTORS, 30)).rejects.toMatchObject({
      constraint: "tenant_step_up_override_org_operation_uq",
    });
    // ...but the SAME operation in another tenant is a different policy, not a conflict.
    await insertOverride(ORG_B, FLOOR_FACTORS, 30);
  });

  // ── the app-layer half: the Drizzle store + the resolved policy ──────────────────────────────
  it("the store reads the tenant's row and the seam TIGHTENS with it", async () => {
    await insertOverride(ORG_A, ["webauthn"], 60);
    const resolver = createSessionContextResolver(
      createInMemorySessionContextStore().store,
      createDrizzleStepUpOverrideStore(handle.db),
    );
    expect(await resolver.resolveStepUpPolicy({ orgId: ORG_A }, OP)).toEqual({
      qualifyingFactors: ["webauthn"],
      maxAgeSec: 60,
    });
    // An operation the tenant did not configure resolves the floor, not the other operation's row.
    expect(await resolver.resolveStepUpPolicy({ orgId: ORG_A }, "chart.export")).toEqual({
      qualifyingFactors: FLOOR_FACTORS,
      maxAgeSec: FLOOR_MAX_AGE,
    });
  });

  it("RLS scopes the override — one tenant's tightening never binds another", async () => {
    await insertOverride(ORG_A, ["webauthn"], 60);
    const resolver = createSessionContextResolver(
      createInMemorySessionContextStore().store,
      createDrizzleStepUpOverrideStore(handle.db),
    );
    // Same operation key, different org: ORG_B has configured nothing, so it gets the floor...
    expect(await resolver.resolveStepUpPolicy({ orgId: ORG_B }, OP)).toEqual({
      qualifyingFactors: FLOOR_FACTORS,
      maxAgeSec: FLOOR_MAX_AGE,
    });
    // ...asserted as a PAIR, because "ORG_B gets the floor" is also what a store that reads nothing
    // at all would say. Only the contrast proves this is scoping rather than deadness.
    expect(await resolver.resolveStepUpPolicy({ orgId: ORG_A }, OP)).toEqual({
      qualifyingFactors: ["webauthn"],
      maxAgeSec: 60,
    });
  });

  it("a tightened policy actually denies a session the floor would have allowed", async () => {
    await insertOverride(ORG_A, ["webauthn"], 60);
    const sessions = createInMemorySessionContextStore([
      {
        sessionClass: "staff",
        portalAccountId: null,
        sessionPatientId: null,
        sessionId: "sess_1",
        userId: USER,
        membershipId: memberOf[ORG_A] ?? null,
        organizationId: ORG_A,
        roles: [],
        providerEntityIds: [],
        locationIds: [],
        // TOTP, 2 minutes ago: inside the floor's window, on a floor-qualifying factor.
        lastStepUpAt: new Date(NOW.getTime() - 120_000),
        lastStepUpFactor: "totp",
      },
    ]).store;
    const resolver = createSessionContextResolver(
      sessions,
      createDrizzleStepUpOverrideStore(handle.db),
    );
    const state = await resolver.resolveStepUpState({ orgId: ORG_A }, "sess_1");
    const policy = await resolver.resolveStepUpPolicy({ orgId: ORG_A }, OP);
    expect(state?.lastStepUpFactor).toBe("totp");
    // Both knobs bite: the factor is no longer qualifying AND 120s exceeds the 60s window.
    expect(policy.qualifyingFactors).not.toContain("totp");
    expect(policy.maxAgeSec).toBe(60);
  });
});
