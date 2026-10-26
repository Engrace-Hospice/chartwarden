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
import { DEFAULT_MEDICAID_RULES } from "@chartwarden/medicaid-adapters";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMedicaidRevalidate } from "../src/modules/24-billing-medicaid/jobs/revalidate-jobs";
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
  // Real default rules whose override role is billing_manager (the applied role is derived from the rule).
  const RULE_KEYS = DEFAULT_MEDICAID_RULES.filter(
    (r) => r.overrideRoleRequired === "billing_manager",
  ).map((r) => r.key);
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
  async function seedResult(runId: string, outcome: string, ruleKey: string): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO medicaid_validation_result (organization_id, medicaid_validation_run_id, rule_key, rule_version, outcome)
       VALUES ($1,$2,$4,1,$3) RETURNING id`,
      [ORG_A, runId, outcome, ruleKey],
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
    await admin.query("UPDATE medicaid_claim SET validation_run_id_latest=$2 WHERE id=$1", [
      claimId,
      latestRun,
    ]);
    return {
      claimId,
      oldFail: await seedResult(oldRun, "fail", RULE_KEYS[0] as string),
      latestFail: await seedResult(latestRun, "fail", RULE_KEYS[0] as string),
      latestPass: await seedResult(latestRun, "pass", RULE_KEYS[1] as string),
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

  it("rejects a spoofed role (claimed but not held, or not the rule's required role) with 403 and writes nothing", async () => {
    const f = await fixture();
    const notHeld = { ...ACTOR, roles: ["compliance_officer"] };
    await expect(svc().applyOverride(notHeld, f.latestFail, INPUT)).rejects.toMatchObject({
      statusCode: 403,
    });
    const wrongRole = { ...ACTOR, roles: ["billing_manager", "org_admin"] };
    await expect(
      svc().applyOverride(wrongRole, f.latestFail, {
        ...INPUT,
        overrideRoleClaimed: "org_admin",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await overrideCount(f.latestFail)).toBe(0);
  });

  it("stores the server-derived role on the override row", async () => {
    const f = await fixture();
    await svc().applyOverride(ACTOR, f.latestFail, INPUT);
    const { rows } = await admin.query(
      "SELECT override_role_applied FROM medicaid_validation_override WHERE medicaid_validation_result_id=$1",
      [f.latestFail],
    );
    expect(rows[0].override_role_applied).toBe("billing_manager");
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

  it("returns 404 for a missing result id", async () => {
    await expect(svc().applyOverride(ACTOR, randomUUID(), INPUT)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("returns a distinct 422 (not 403) when the result's rule is not in the registry", async () => {
    const claimId = await seedClaim();
    const run = await seedRun(claimId, "2026-03-01T00:00:00Z");
    await admin.query("UPDATE medicaid_claim SET validation_run_id_latest=$2 WHERE id=$1", [
      claimId,
      run,
    ]);
    const resultId = await seedResult(run, "fail", "custom.not_in_registry");
    await expect(svc().applyOverride(ACTOR, resultId, INPUT)).rejects.toMatchObject({
      code: "OVERRIDE_RULE_UNKNOWN",
      statusCode: 422,
    });
  });

  const settledWithin = (p: Promise<unknown>, ms: number) =>
    Promise.race([
      p.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
    ]);

  it("validateClaim takes the claim lock first: it waits behind a concurrent claim lock holder", async () => {
    const f = await fixture();
    await admin.query("BEGIN");
    try {
      await admin.query("SELECT id FROM medicaid_claim WHERE id=$1 FOR UPDATE", [f.claimId]);
      const validating = svc().validateClaim(ACTOR, f.claimId);
      expect(await settledWithin(validating, 800)).toBe(false);
      await admin.query("COMMIT");
      await validating;
    } catch (e) {
      await admin.query("ROLLBACK");
      throw e;
    }
  });

  /** Starts an override from INSIDE a revalidating tx (the claim lock is held and the new run is not yet visible):
   *  it must block, then lose with a 409 once the revalidate commits. Deterministic, no timing luck. */
  function overrideStartedMidRevalidate(resultId: string) {
    const state: { override?: Promise<string | undefined>; blocked?: boolean } = {};
    const outbox = {
      async publish() {
        if (state.override) return; // the first publish only
        state.override = svc()
          .applyOverride(ACTOR, resultId, INPUT)
          .then(
            () => "applied",
            (e: { code?: string }) => e.code,
          );
        state.blocked = !(await settledWithin(state.override, 800));
      },
    };
    return { state, outbox };
  }

  it("an override racing the real validateClaim blocks on its claim lock, then is rejected as superseded", async () => {
    const f = await fixture();
    const { state, outbox: raceOutbox } = overrideStartedMidRevalidate(f.latestFail);
    await buildDrizzleM24WriteService(handle.db, raceOutbox).validateClaim(ACTOR, f.claimId);
    expect(state.blocked).toBe(true);
    expect(await state.override).toBe("OVERRIDE_RESULT_SUPERSEDED");
    expect(await overrideCount(f.latestFail)).toBe(0);
  });

  it("an override racing the revalidate WORKER (runMedicaidRevalidate) blocks, then is rejected as superseded", async () => {
    const f = await fixture();
    const { rows } = await admin.query("SELECT patient_id FROM medicaid_claim WHERE id=$1", [
      f.claimId,
    ]);
    const { state, outbox: raceOutbox } = overrideStartedMidRevalidate(f.latestFail);
    await withOrgContext(handle.db, { organizationId: ORG_A, userId: USER }, (tx) =>
      runMedicaidRevalidate(
        tx as never,
        { connection: {} as never, db: handle.db, outbox: raceOutbox as never },
        {
          organizationId: ORG_A,
          eventId: randomUUID(),
          eventName: "m5.patient.updated",
          patientId: rows[0].patient_id,
        },
      ),
    );
    expect(state.blocked).toBe(true);
    expect(await state.override).toBe("OVERRIDE_RESULT_SUPERSEDED");
    expect(await overrideCount(f.latestFail)).toBe(0);
  });

  it("an override racing a revalidate that commits first is rejected as superseded", async () => {
    const f = await fixture();
    await admin.query("BEGIN");
    let racing: Promise<unknown>;
    try {
      await admin.query("SELECT id FROM medicaid_claim WHERE id=$1 FOR UPDATE", [f.claimId]);
      racing = svc().applyOverride(ACTOR, f.latestFail, INPUT);
      const outcome = racing.then(
        () => "applied",
        (e: { code?: string }) => e.code,
      );
      expect(await settledWithin(racing, 800)).toBe(false);
      // the "revalidate" commits a newer run + pointer while the override waits on the claim lock
      const newer = await seedRun(f.claimId, "2026-02-03T00:00:00Z");
      await admin.query("UPDATE medicaid_claim SET validation_run_id_latest=$2 WHERE id=$1", [
        f.claimId,
        newer,
      ]);
      await admin.query("COMMIT");
      expect(await outcome).toBe("OVERRIDE_RESULT_SUPERSEDED");
    } catch (e) {
      await admin.query("ROLLBACK");
      throw e;
    }
    expect(await overrideCount(f.latestFail)).toBe(0);
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
