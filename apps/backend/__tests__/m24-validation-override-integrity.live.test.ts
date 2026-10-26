/**
 * M24 Billing - Medicaid - validation override integrity (#809), against real Postgres as the NOBYPASSRLS
 * `chartwarden_app` role: the production `buildDrizzleM24WriteService(...).applyOverride` must reject a non-fail
 * result (422), a result outside the claim's latest run (409), and a second override of one result (409, from the
 * unique index via ON CONFLICT DO NOTHING - also under a concurrent race), and emit exactly one event.
 *
 * Gated on a live DB: CHARTWARDEN_TEST_DATABASE_URL=postgres://... bunx vitest run <this file>
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDrizzleM24WriteService } from "../src/modules/24-billing-medicaid/routes/write-service-drizzle";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");

const ORG_A = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";

describe.skipIf(!DB_URL)("M24 validation override integrity - LIVE Postgres (#809)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let peA: string;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  async function seedOrg(): Promise<string> {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','org-a','org-a')",
      [ORG_A],
    );
    const pe = await admin.query(
      `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,'111111','PE','1234567890','enc','0930') RETURNING id`,
      [ORG_A],
    );
    return pe.rows[0].id;
  }

  async function seedClaim(): Promise<string> {
    const claimId = randomUUID();
    await admin.query(
      `INSERT INTO medicaid_claim
         (id, organization_id, provider_entity_id, patient_id, patient_payer_id, admission_id,
          service_state, kind, tob, service_from, service_to, state_plan_code_id,
          state_plan_code_snapshot, medicaid_claim_control_number, state, version,
          created_by_membership_id, updated_by_membership_id)
       VALUES
         ($1,$2,$3,$4,$5,$6,'OR','hospice_only','811','2026-01-01','2026-01-31',$7,
          'OHP-STD',$8,'FAILED_VALIDATION',1,$9,$9)`,
      [
        claimId,
        ORG_A,
        peA,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        `CN-${claimId.slice(0, 8)}`,
        USER,
      ],
    );
    return claimId;
  }

  const ACTOR = {
    organizationId: ORG_A,
    userId: USER,
    roles: ["billing_manager"],
    stepUpRecent: true,
  };
  const INPUT = {
    reason: "Payer confirmed the diagnosis code is acceptable for this admission by phone.",
    overrideRoleClaimed: "billing_manager" as const,
  };
  const published: string[] = [];
  const outbox = {
    async publish(_tx: unknown, e: { eventName: string }) {
      published.push(e.eventName);
    },
  };

  async function seedRun(claimId: string, at: string): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO medicaid_validation_run
         (organization_id, medicaid_claim_id, rule_registry_version, triggered_by, claim_state_at_trigger, idempotency_key, at)
       VALUES ($1,$2,'1','manual','DRAFT',$3,$4) RETURNING id`,
      [ORG_A, claimId, randomUUID(), at],
    );
    return rows[0].id;
  }
  async function seedResult(runId: string, outcome: string): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO medicaid_validation_result (organization_id, medicaid_validation_run_id, rule_key, rule_version, outcome)
       VALUES ($1,$2,'rule.' || $4::text,1,$3) RETURNING id`,
      [ORG_A, runId, outcome, randomUUID()],
    );
    return rows[0].id;
  }
  async function overrideCount(resultId: string): Promise<number> {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM medicaid_validation_override WHERE medicaid_validation_result_id=$1",
      [resultId],
    );
    return rows[0].n;
  }
  async function fixture() {
    const claimId = await seedClaim();
    const oldRun = await seedRun(claimId, "2026-02-01T00:00:00Z");
    const latestRun = await seedRun(claimId, "2026-02-02T00:00:00Z");
    return {
      claimId,
      oldFail: await seedResult(oldRun, "fail"),
      latestFail: await seedResult(latestRun, "fail"),
      latestPass: await seedResult(latestRun, "pass"),
    };
  }
  const svc = () => buildDrizzleM24WriteService(handle.db, outbox);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m24override@x.test')`, [USER]);
    peA = await seedOrg();
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("overrides a failed result in the latest run once, emitting one event", async () => {
    const f = await fixture();
    published.length = 0;
    const { overrideId } = await svc().applyOverride(ACTOR, f.latestFail, INPUT);
    expect(overrideId).toBeTruthy();
    expect(await overrideCount(f.latestFail)).toBe(1);
    expect(published).toEqual(["m24.medicaid_claim.override_applied"]);
  });

  it("rejects a pass result with 422 and writes nothing", async () => {
    const f = await fixture();
    await expect(svc().applyOverride(ACTOR, f.latestPass, INPUT)).rejects.toMatchObject({
      code: "OVERRIDE_RESULT_NOT_FAILED",
      statusCode: 422,
    });
    expect(await overrideCount(f.latestPass)).toBe(0);
  });

  it("rejects a result from a superseded run with 409", async () => {
    const f = await fixture();
    await expect(svc().applyOverride(ACTOR, f.oldFail, INPUT)).rejects.toMatchObject({
      code: "OVERRIDE_RESULT_SUPERSEDED",
      statusCode: 409,
    });
    expect(await overrideCount(f.oldFail)).toBe(0);
  });

  it("rejects a second override of the same result with 409 and no second event", async () => {
    const f = await fixture();
    await svc().applyOverride(ACTOR, f.latestFail, INPUT);
    published.length = 0;
    await expect(svc().applyOverride(ACTOR, f.latestFail, INPUT)).rejects.toMatchObject({
      code: "OVERRIDE_ALREADY_APPLIED",
      statusCode: 409,
    });
    expect(await overrideCount(f.latestFail)).toBe(1);
    expect(published).toEqual([]);
  });

  it("a concurrent race yields exactly one override, the losers a 409 (not a 500)", async () => {
    const f = await fixture();
    const settled = await Promise.allSettled([
      svc().applyOverride(ACTOR, f.latestFail, INPUT),
      svc().applyOverride(ACTOR, f.latestFail, INPUT),
      svc().applyOverride(ACTOR, f.latestFail, INPUT),
    ]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    for (const s of settled)
      if (s.status === "rejected") expect(s.reason).toMatchObject({ statusCode: 409 });
    expect(await overrideCount(f.latestFail)).toBe(1);
  });

  it("the DB itself refuses a duplicate override row (unique index)", async () => {
    const f = await fixture();
    await svc().applyOverride(ACTOR, f.latestFail, INPUT);
    await expect(
      admin.query(
        `INSERT INTO medicaid_validation_override
           (organization_id, medicaid_validation_result_id, medicaid_claim_id, rule_key, override_role_applied, reason, step_up_auth_token_at, actor_membership_id)
         VALUES ($1,$2,$3,'rule.x','billing_manager',$4,now(),$5)`,
        [ORG_A, f.latestFail, f.claimId, INPUT.reason, USER],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
