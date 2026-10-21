/**
 * M23 DRAFT-claim delete / re-assembly — LIVE Postgres proof (migration 1061).
 *
 * `DELETE /billing/claims/:id` used to die with 42501 `permission denied for table claim_line` because the app role had
 * no DELETE grant on `claim_line` (0077). This proves, as the real NOBYPASSRLS `wardenx_app` role (`_live-app-role.ts`):
 *   - a draft claim with lines and every append-only child (HIPPS, SIA, validation run/result/override, state history)
 *     is deleted through the real `deleteDraftClaim`, children included, and the deletes land in `audit_event`;
 *   - a non-draft claim (every other state) can neither be deleted by the service nor by raw SQL on claim / claim_line,
 *     and its append-only children stay undeletable and unupdatable;
 *   - cross-tenant: org B can neither delete org A's draft through the service (404) nor by raw SQL (0 rows);
 *   - re-assembly's line rewrite (`updateDraftClaim` deletes then inserts lines) works on a draft and not on a submitted claim.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m23:draft-claim-delete:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repositories } from "@chartwarden/billing";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { M23WriteActor } from "../src/modules/23-billing-medicare/routes/actor";
import { buildDrizzleM23WriteService } from "../src/modules/23-billing-medicare/routes/write-service-drizzle";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEMBERSHIP_A = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const MEMBERSHIP_B = "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1";
const PE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PE2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ANY = "99999999-9999-4999-8999-999999999999";

const actor = (organizationId: string, userId: string, membershipId: string): M23WriteActor => ({
  organizationId,
  userId,
  roles: ["org_admin"],
  membershipId,
  stepUpRecent: false,
  actorKind: "user",
});
const actorA = actor(ORG_A, USER_A, MEMBERSHIP_A);
const actorB = actor(ORG_B, USER_B, MEMBERSHIP_B);

let seq = 0;
const uuid = (): string => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
};

describe.skipIf(!DB_URL)("M23 draft claim delete — LIVE Postgres (migration 1061)", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let appUrl: string;

  /** Seed one claim plus every child a real assembly writes, as the superuser. Returns the ids. */
  async function seedClaim(org: string, state: string, opts: { pricing?: boolean } = {}) {
    const claimId = uuid();
    const runId = uuid();
    const resultId = uuid();
    await admin.query(
      `INSERT INTO claim (id, organization_id, provider_entity_id, patient_id, admission_id, election_period_id_from,
         election_period_id_to, patient_payer_id, tob, service_from, service_to, state, claim_control_number,
         mac_jurisdiction, sequestration_applied_pct, sequestration_policy_id, created_by_membership_id,
         latest_validation_run_id)
       VALUES ($1,$2,$3,$9,$4,$4,$4,$4,'811','2026-09-01','2026-09-30',$5,$6,'cgs_j15','2.00',$4,$7,$8)`,
      [
        claimId,
        org,
        PE,
        ANY,
        state,
        `CCN-${claimId}`,
        org === ORG_A ? MEMBERSHIP_A : MEMBERSHIP_B,
        runId,
        uuid(),
      ],
    );
    await admin.query(
      `INSERT INTO claim_line (organization_id, claim_id, line_number, revenue_code, q_code, level_of_care,
         service_date_from, service_date_to, unit_count, unit_rate_cents, line_charge_cents, level_of_care_period_id)
       VALUES ($1,$2,1,'0651','Q5001','RHC','2026-09-01','2026-09-15',15,100,1500,$3),
              ($1,$2,2,'0651','Q5001','RHC','2026-09-16','2026-09-30',15,100,1500,$3)`,
      [org, claimId, ANY],
    );
    if (opts.pricing !== false) {
      await admin.query(
        `INSERT INTO per_diem_rate_calculation (organization_id, claim_id, per_diem_class_code, per_diem_rate_cents, wage_index_ccn,
           wage_index_fiscal_year, wage_index_factor, segments) VALUES ($1,$2,'RHC',100,'111111',2026,'1.0','[]')`,
        [org, claimId],
      );
    }
    await admin.query(
      `INSERT INTO sia_calculation (organization_id, claim_id, patient_deceased_date, window_start,
         qualifying_visits, total_qualifying_minutes, sia_add_on_cents) VALUES ($1,$2,'2026-09-30','2026-09-24','[]',30,500)`,
      [org, claimId],
    );
    await admin.query(
      `INSERT INTO validation_run (id, organization_id, claim_id, trigger, outcome, run_input_hash, rules_executed,
         rules_passed, rules_failed, rules_warn, rules_info, completed_at, duration_ms)
       VALUES ($1,$2,$3,'initial_assembly','all_pass',$4,1,1,0,0,0,now(),1)`,
      [runId, org, claimId, `h-${runId}`],
    );
    await admin.query(
      `INSERT INTO validation_result (id, organization_id, validation_run_id, rule_key, rule_version, severity, outcome)
       VALUES ($1,$2,$3,'r1',1,'error','fail')`,
      [resultId, org, runId],
    );
    await admin.query(
      `INSERT INTO validation_override (organization_id, result_id, override_membership_id, override_role_applied,
         reason, m4_audit_event_id) VALUES ($1,$2,$3,'billing_manager',$4,$5)`,
      [org, resultId, MEMBERSHIP_A, "x".repeat(60), ANY],
    );
    await admin.query(
      `INSERT INTO claim_state_history (organization_id, claim_id, from_state, to_state, actor_kind, validation_run_id)
       VALUES ($1,$2,NULL,'DRAFT','user',$3)`,
      [org, claimId, runId],
    );
    return { claimId, runId, resultId };
  }

  async function count(table: string, where: string, args: unknown[]): Promise<number> {
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      args,
    );
    return rows[0].n as number;
  }

  /** Run `fn` on a fresh wardenx_app connection scoped to `org`; always rolls back. */
  async function asApp<T>(org: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.org_id', $1, true)", [org]);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK");
      await c.end();
    }
  }

  const svc = () => buildDrizzleM23WriteService(handle.db);

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
    for (const [id, slug] of [
      [ORG_A, "org-a"],
      [ORG_B, "org-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
        [id, slug, slug],
      );
    }
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'dc-a@x.test'),($2,'dc-b@x.test')`,
      [USER_A, USER_B],
    );
    appUrl = await appRoleConnectionString(admin, DB_URL as string);
    handle = createDbClient({ connectionString: appUrl });
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  it("deletes a draft claim with its lines and every append-only child, and audits the deletes", async () => {
    const { claimId, runId, resultId } = await seedClaim(ORG_A, "DRAFT");
    await svc().deleteDraftClaim(actorA, claimId);
    expect(await count("claim", "id=$1", [claimId])).toBe(0);
    expect(await count("claim_line", "claim_id=$1", [claimId])).toBe(0);
    expect(await count("per_diem_rate_calculation", "claim_id=$1", [claimId])).toBe(0);
    expect(await count("sia_calculation", "claim_id=$1", [claimId])).toBe(0);
    expect(await count("validation_run", "id=$1", [runId])).toBe(0);
    expect(await count("validation_result", "id=$1", [resultId])).toBe(0);
    expect(await count("validation_override", "result_id=$1", [resultId])).toBe(0);
    expect(await count("claim_state_history", "claim_id=$1", [claimId])).toBe(0);
    expect(
      await count("audit_event", "event_type='claim.delete' AND resource_id=$1", [claimId]),
    ).toBe(1);
    expect(
      await count("audit_event", "event_type='claim_line.delete' AND organization_id=$1", [ORG_A]),
    ).toBeGreaterThanOrEqual(2);
  });

  it("deletes a draft claim that has no pricing row (seeded without one; no trigger is disabled)", async () => {
    const { claimId } = await seedClaim(ORG_A, "DRAFT", { pricing: false });
    expect(await count("per_diem_rate_calculation", "claim_id=$1", [claimId])).toBe(0);
    await svc().deleteDraftClaim(actorA, claimId);
    expect(await count("claim", "id=$1", [claimId])).toBe(0);
  });

  it.each([
    "VALIDATING",
    "READY",
    "SUBMITTED",
    "ACK_PENDING",
    "ACK_ACCEPTED",
    "PAID",
    "DENIED",
    "VOIDED",
  ])("refuses to delete a %s claim and leaves every row in place", async (state) => {
    const { claimId, runId } = await seedClaim(ORG_A, state);
    await expect(svc().deleteDraftClaim(actorA, claimId)).rejects.toThrow(/draft/i);
    // The handler check is not the only barrier: the database refuses the raw statements too.
    await asApp(ORG_A, (c) =>
      expect(c.query("DELETE FROM claim_line WHERE claim_id=$1", [claimId])).rejects.toThrow(
        /M23_CLAIM_NOT_DRAFT/,
      ),
    );
    await asApp(ORG_A, (c) =>
      expect(c.query("DELETE FROM claim WHERE id=$1", [claimId])).rejects.toThrow(
        /M23_CLAIM_NOT_DRAFT/,
      ),
    );
    for (const sql of [
      "DELETE FROM per_diem_rate_calculation WHERE claim_id=$1",
      "DELETE FROM sia_calculation WHERE claim_id=$1",
      "DELETE FROM validation_run WHERE claim_id=$1",
      "DELETE FROM claim_state_history WHERE claim_id=$1",
      "DELETE FROM validation_result WHERE validation_run_id IN (SELECT id FROM validation_run WHERE claim_id=$1)",
      "DELETE FROM validation_override WHERE organization_id IS NOT NULL AND result_id IN (SELECT id FROM validation_result WHERE validation_run_id IN (SELECT id FROM validation_run WHERE claim_id=$1))",
    ]) {
      await asApp(ORG_A, (c) =>
        expect(c.query(sql, [claimId])).rejects.toThrow(/M23_TABLE_APPEND_ONLY/),
      );
    }
    expect(await count("claim", "id=$1", [claimId])).toBe(1);
    expect(await count("claim_line", "claim_id=$1", [claimId])).toBe(2);
    expect(await count("validation_run", "id=$1", [runId])).toBe(1);
  });

  it("never lets the app role UPDATE an append-only child, even of a draft", async () => {
    const { claimId } = await seedClaim(ORG_A, "DRAFT");
    await asApp(ORG_A, (c) =>
      expect(
        c.query("UPDATE per_diem_rate_calculation SET per_diem_rate_cents=1 WHERE claim_id=$1", [
          claimId,
        ]),
      ).rejects.toThrow(/M23_TABLE_APPEND_ONLY/),
    );
  });

  it("is tenant-safe: org B cannot delete org A's draft through the service or raw SQL", async () => {
    const { claimId } = await seedClaim(ORG_A, "DRAFT");
    await expect(svc().deleteDraftClaim(actorB, claimId)).rejects.toThrow(/not found/i);
    const raw = await asApp(ORG_B, async (c) => {
      const lines = await c.query("DELETE FROM claim_line WHERE claim_id=$1", [claimId]);
      const claim = await c.query("DELETE FROM claim WHERE id=$1", [claimId]);
      const runs = await c.query("DELETE FROM validation_run WHERE claim_id=$1", [claimId]);
      return [lines.rowCount, claim.rowCount, runs.rowCount];
    });
    expect(raw).toEqual([0, 0, 0]);
    expect(await count("claim", "id=$1", [claimId])).toBe(1);
    expect(await count("claim_line", "claim_id=$1", [claimId])).toBe(2);
  });

  it("cannot forge a delete across tenants by passing the other org's id in the predicate", async () => {
    const { claimId } = await seedClaim(ORG_A, "DRAFT");
    const n = await asApp(ORG_B, async (c) => {
      const r = await c.query("DELETE FROM claim_line WHERE claim_id=$1 AND organization_id=$2", [
        claimId,
        ORG_A,
      ]);
      return r.rowCount;
    });
    expect(n).toBe(0);
  });

  it("re-assembly line rewrite: the app role can delete and re-insert a draft's lines, not a submitted claim's", async () => {
    const draft = await seedClaim(ORG_A, "DRAFT");
    const rewritten = await asApp(ORG_A, async (c) => {
      const del = await c.query("DELETE FROM claim_line WHERE claim_id=$1", [draft.claimId]);
      await c.query(
        `INSERT INTO claim_line (organization_id, claim_id, line_number, revenue_code, q_code, level_of_care,
           service_date_from, service_date_to, unit_count, unit_rate_cents, line_charge_cents, level_of_care_period_id)
         VALUES ($1,$2,1,'0651','Q5001','RHC','2026-09-01','2026-09-30',30,100,3000,$3)`,
        [ORG_A, draft.claimId, ANY],
      );
      return del.rowCount;
    });
    expect(rewritten).toBe(2);
    const sent = await seedClaim(ORG_A, "SUBMITTED");
    await asApp(ORG_A, (c) =>
      expect(c.query("DELETE FROM claim_line WHERE claim_id=$1", [sent.claimId])).rejects.toThrow(
        /M23_CLAIM_NOT_DRAFT/,
      ),
    );
  });

  it("keeps the destruction role able to erase a non-draft claim's lines and claim (per-patient eraser)", async () => {
    const { claimId } = await seedClaim(ORG_A, "PAID");
    await admin.query("DROP ROLE IF EXISTS m23_destroyer");
    await admin.query("CREATE ROLE m23_destroyer LOGIN PASSWORD 'x' IN ROLE wardenx_destruction");
    const url = new URL(DB_URL as string);
    url.username = "m23_destroyer";
    url.password = "x";
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      const lines = await c.query("DELETE FROM claim_line WHERE claim_id=$1", [claimId]);
      const claim = await c.query("DELETE FROM claim WHERE id=$1", [claimId]);
      expect([lines.rowCount, claim.rowCount]).toEqual([2, 1]);
    } finally {
      await c.query("ROLLBACK");
      await c.end();
    }
  });

  describe("the draft-only guard cannot be defeated from the app role (H1)", () => {
    it.each(["SUBMITTED", "PAID", "VALIDATING", "READY"])(
      "refuses to flip a %s claim back to DRAFT, so flip-then-delete fails and nothing is lost",
      async (state) => {
        const { claimId } = await seedClaim(ORG_A, state);
        // Attempt 1 (its own transaction): the flip itself must be refused...
        await asApp(ORG_A, (c) =>
          expect(c.query("UPDATE claim SET state='DRAFT' WHERE id=$1", [claimId])).rejects.toThrow(
            /M23_CLAIM_STATE_REVERT/,
          ),
        );
        // ...and the claim is verifiably still in its original state afterwards.
        expect(await count("claim", "id=$1 AND state=$2", [claimId, state])).toBe(1);
        // Attempt 2 (separate): the delete of the subtree is refused too.
        await asApp(ORG_A, (c) =>
          expect(c.query("DELETE FROM claim_line WHERE claim_id=$1", [claimId])).rejects.toThrow(
            /M23_CLAIM_NOT_DRAFT/,
          ),
        );
        expect(await count("claim", "id=$1 AND state=$2", [claimId, state])).toBe(1);
        expect(await count("claim_line", "claim_id=$1", [claimId])).toBe(2);
      },
    );

    const decoyInsert = (c: Client, id: string, pe: string, state = "DRAFT") =>
      c.query(
        `INSERT INTO claim (id, organization_id, provider_entity_id, patient_id, admission_id, election_period_id_from,
           election_period_id_to, patient_payer_id, tob, service_from, service_to, state, claim_control_number,
           mac_jurisdiction, sequestration_applied_pct, sequestration_policy_id, created_by_membership_id)
         VALUES ($1,$2,$3,$4,$4,$4,$4,$4,'811','2026-09-01','2026-09-30',$5,$6,'cgs_j15','2.00',$4,$7)`,
        [id, ORG_A, pe, uuid(), state, `CCN-DECOY-${uuid()}`, MEMBERSHIP_A],
      );
    const CHILD_DELETES = [
      "DELETE FROM claim_line WHERE claim_id=$1",
      "DELETE FROM per_diem_rate_calculation WHERE claim_id=$1",
      "DELETE FROM sia_calculation WHERE claim_id=$1",
      "DELETE FROM claim_state_history WHERE claim_id=$1",
      "DELETE FROM validation_result WHERE validation_run_id IN (SELECT id FROM validation_run WHERE claim_id=$1)",
      "DELETE FROM validation_run WHERE claim_id=$1",
      "DELETE FROM claim WHERE id=$1 AND provider_entity_id=$2",
    ];

    it("refuses a second claim row with the same id under another provider entity (decoy insert)", async () => {
      const real = await seedClaim(ORG_A, "READY");
      await asApp(ORG_A, (c) =>
        expect(decoyInsert(c, real.claimId, PE2)).rejects.toThrow(/M23_CLAIM_DUPLICATE_ID/),
      );
      expect(await count("claim", "id=$1", [real.claimId])).toBe(1);
    });

    it("is not fooled by a decoy DRAFT row even if one got in (the deletable check demands no non-DRAFT row)", async () => {
      const real = await seedClaim(ORG_A, "READY");
      // Superuser plants the decoy with the insert guard off, standing in for any future path around it.
      await admin.query("ALTER TABLE claim DISABLE TRIGGER USER");
      try {
        await decoyInsert(admin, real.claimId, PE2);
      } finally {
        await admin.query("ALTER TABLE claim ENABLE TRIGGER USER");
      }
      for (const sql of CHILD_DELETES) {
        await asApp(ORG_A, (c) =>
          expect(
            c.query(sql, sql.includes("$2") ? [real.claimId, PE] : [real.claimId]),
          ).rejects.toThrow(/M23_CLAIM_NOT_DRAFT|M23_TABLE_APPEND_ONLY/),
        );
      }
      expect(await count("claim_line", "claim_id=$1", [real.claimId])).toBe(2);
      expect(await count("per_diem_rate_calculation", "claim_id=$1", [real.claimId])).toBe(1);
      expect(await count("validation_run", "claim_id=$1", [real.claimId])).toBe(1);
      expect(await count("claim", "id=$1", [real.claimId])).toBe(2);
    });

    it("refuses to move a claim to another provider entity (cross-partition move)", async () => {
      const real = await seedClaim(ORG_A, "DRAFT");
      await asApp(ORG_A, (c) =>
        expect(
          c.query("UPDATE claim SET provider_entity_id=$2 WHERE id=$1", [real.claimId, PE2]),
        ).rejects.toThrow(/M23_CLAIM_IDENTITY/),
      );
      expect(await count("claim", "id=$1 AND provider_entity_id=$2", [real.claimId, PE])).toBe(1);
    });

    it("refuses a multi-row UPDATE to DRAFT that would sweep in non-draft claims, changing nothing", async () => {
      const a = await seedClaim(ORG_A, "SUBMITTED");
      const b = await seedClaim(ORG_A, "PAID");
      await asApp(ORG_A, (c) =>
        expect(
          c.query("UPDATE claim SET state='DRAFT' WHERE id = ANY($1)", [[a.claimId, b.claimId]]),
        ).rejects.toThrow(/M23_CLAIM_STATE_REVERT/),
      );
      expect(await count("claim", "id = ANY($1) AND state='DRAFT'", [[a.claimId, b.claimId]])).toBe(
        0,
      );
    });

    it("refuses INSERT ... ON CONFLICT DO UPDATE that flips a claim's state to DRAFT", async () => {
      const real = await seedClaim(ORG_A, "SUBMITTED");
      await asApp(ORG_A, (c) =>
        expect(
          c.query(
            `INSERT INTO claim (id, organization_id, provider_entity_id, patient_id, admission_id, election_period_id_from,
               election_period_id_to, patient_payer_id, tob, service_from, service_to, state, claim_control_number,
               mac_jurisdiction, sequestration_applied_pct, sequestration_policy_id, created_by_membership_id)
             VALUES ($1,$2,$3,$4,$4,$4,$4,$4,'811','2026-09-01','2026-09-30','DRAFT','x','cgs_j15','2.00',$4,$5)
             ON CONFLICT (id, provider_entity_id) DO UPDATE SET state='DRAFT'`,
            [real.claimId, ORG_A, PE, uuid(), MEMBERSHIP_A],
          ),
        ).rejects.toThrow(/M23_CLAIM_STATE_REVERT/),
      );
      expect(await count("claim", "id=$1 AND state='SUBMITTED'", [real.claimId])).toBe(1);
    });

    describe("a concurrent state change cannot slip past the guard (READ COMMITTED)", () => {
      const open = async (): Promise<Client> => {
        const c = new Client({ connectionString: appUrl });
        await c.connect();
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
        return c;
      };
      /**
       * True once a backend is observed WAITING ON A LOCK (pg_stat_activity, optionally with a query fragment) while `p`
       * is still unsettled; false if `p` settles first or nothing blocks within the timeout. No fixed sleeps.
       */
      const waitUntilBlocked = async (p: Promise<unknown>, fragment = ""): Promise<boolean> => {
        let settled = false;
        p.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && !settled) {
          const { rows } = await admin.query(
            `SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'
                AND query ILIKE $1`,
            [`%${fragment}%`],
          );
          if (rows.length > 0) return !settled;
          await new Promise((r) => setTimeout(r, 50));
        }
        return false;
      };

      const waitForLockWaiters = async (n: number): Promise<void> => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const { rows } = await admin.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`,
          );
          if (rows[0].n >= n) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`fewer than ${n} backends ever waited on a lock`);
      };

      it("a line delete that raced a move to VALIDATING blocks, then fails; nothing is deleted", async () => {
        const { claimId } = await seedClaim(ORG_A, "DRAFT");
        const mover = await open();
        const deleter = await open();
        try {
          await mover.query("UPDATE claim SET state='VALIDATING' WHERE id=$1", [claimId]);
          const outcome = deleter.query("DELETE FROM claim_line WHERE claim_id=$1", [claimId]).then(
            () => "deleted",
            (e: Error) => e.message,
          );
          expect(await waitUntilBlocked(outcome)).toBe(true);
          await mover.query("COMMIT");
          expect(await outcome).toMatch(/M23_CLAIM_NOT_DRAFT/);
        } finally {
          await deleter.query("ROLLBACK").catch(() => undefined);
          await mover.end();
          await deleter.end();
        }
        expect(await count("claim_line", "claim_id=$1", [claimId])).toBe(2);
      });

      it("deleteDraftClaim waits for the in-flight state change and then refuses", async () => {
        const { claimId } = await seedClaim(ORG_A, "DRAFT");
        const mover = await open();
        try {
          await mover.query("UPDATE claim SET state='VALIDATING' WHERE id=$1", [claimId]);
          const outcome = svc()
            .deleteDraftClaim(actorA, claimId)
            .then(
              () => "deleted",
              (e: Error) => e.message,
            );
          // The handler's own lockClaim (SELECT ... FOR UPDATE) is what blocks, before any delete is issued: this proves
          // the handler lock independently of the database guard.
          expect(await waitUntilBlocked(outcome, "FOR UPDATE")).toBe(true);
          await mover.query("COMMIT");
          expect(await outcome).toMatch(/draft/i);
        } finally {
          await mover.end();
        }
        expect(await count("claim", "id=$1", [claimId])).toBe(1);
        expect(await count("claim_line", "claim_id=$1", [claimId])).toBe(2);
      });

      it("updateDraftClaim's line rewrite waits for the in-flight state change and then refuses", async () => {
        const { claimId } = await seedClaim(ORG_A, "DRAFT");
        const mover = await open();
        try {
          await mover.query("UPDATE claim SET state='VALIDATING' WHERE id=$1", [claimId]);
          const outcome = svc()
            .updateDraftClaim(actorA, claimId, { expectedVersion: 0, lines: [] })
            .then(
              () => "rewritten",
              (e: Error) => e.message,
            );
          expect(await waitUntilBlocked(outcome, "FOR UPDATE")).toBe(true);
          await mover.query("COMMIT");
          expect(await outcome).not.toBe("rewritten");
        } finally {
          await mover.end();
        }
        expect(await count("claim_line", "claim_id=$1", [claimId])).toBe(2);
      });

      it("two concurrent inserts of one id under different provider entities: the second blocks, then is refused", async () => {
        const id = uuid();
        const t1 = await open();
        const t2 = await open();
        try {
          await decoyInsert(t1, id, PE);
          const second = decoyInsert(t2, id, PE2).then(
            () => "inserted",
            (e: Error) => e.message,
          );
          expect(await waitUntilBlocked(second, "INSERT INTO claim")).toBe(true);
          await t1.query("COMMIT");
          expect(await second).toMatch(/M23_CLAIM_DUPLICATE_ID/);
        } finally {
          await t2.query("ROLLBACK").catch(() => undefined);
          await t1.end();
          await t2.end();
        }
        expect(await count("claim", "id=$1", [id])).toBe(1);
      });

      it("a multi-row INSERT ... SELECT carrying one id under two provider entities is refused as a whole", async () => {
        const id = uuid();
        await asApp(ORG_A, (c) =>
          expect(
            c.query(
              `INSERT INTO claim (id, organization_id, provider_entity_id, patient_id, admission_id, election_period_id_from,
                 election_period_id_to, patient_payer_id, tob, service_from, service_to, state, claim_control_number,
                 mac_jurisdiction, sequestration_applied_pct, sequestration_policy_id, created_by_membership_id)
               SELECT $1::uuid, $2::uuid, pe, gen_random_uuid(), $4::uuid, $4::uuid, $4::uuid, $4::uuid, '811', DATE '2026-09-01',
                 DATE '2026-09-30', 'DRAFT', 'CCN-MULTI-' || pe::text, 'cgs_j15', '2.00', $4::uuid, $5::uuid
                 FROM unnest(ARRAY[$3::uuid, $6::uuid]) AS pe`,
              [id, ORG_A, PE, ANY, MEMBERSHIP_A, PE2],
            ),
          ).rejects.toThrow(/M23_CLAIM_DUPLICATE_ID/),
        );
        expect(await count("claim", "id=$1", [id])).toBe(0);
      });

      it("two concurrent raw DELETEs of one draft claim do not deadlock: one wins, the other is a clean no-op", async () => {
        const { claimId } = await seedClaim(ORG_A, "DRAFT");
        // t0 holds the row so BOTH deleters reach the guard at the same moment and are released together. This
        // documents (and pins) that no 40P01 occurs: Postgres locks the target tuple EXCLUSIVELY (GetTupleForTrigger)
        // before any BEFORE ROW trigger runs, so the guard's FOR SHARE is taken on a row the deleter already owns and
        // the two deleters simply serialise. Hence no FOR UPDATE is needed in the claim delete guard.
        const t0 = await open();
        const t1 = await open();
        const t2 = await open();
        const settle = (c: Client) =>
          c.query("DELETE FROM claim WHERE id=$1", [claimId]).then(
            (r) => ({ c, ok: true as const, rows: r.rowCount, code: undefined }),
            (e: { code?: string }) => ({ c, ok: false as const, rows: 0, code: e.code }),
          );
        try {
          await t0.query("SELECT 1 FROM claim WHERE id=$1 FOR UPDATE", [claimId]);
          const p1 = settle(t1);
          const p2 = settle(t2);
          await waitForLockWaiters(2);
          await t0.query("ROLLBACK");
          const first = await Promise.race([p1, p2]);
          // the winner commits, which releases the other deleter
          if (first.ok) await first.c.query("COMMIT");
          const [r1, r2] = await Promise.all([p1, p2]);
          const results = [r1, r2];
          expect(results.filter((r) => !r.ok && r.code === "40P01")).toEqual([]);
          expect(results.filter((r) => r.ok && r.rows === 1)).toHaveLength(1);
        } finally {
          for (const c of [t0, t1, t2]) {
            await c.query("COMMIT").catch(() => undefined);
            await c.end();
          }
        }
        expect(await count("claim", "id=$1", [claimId])).toBe(0);
        expect(
          await count("audit_event", "event_type='claim.delete' AND resource_id=$1", [claimId]),
        ).toBe(1);
      });
    });

    it("still lets a DRAFT claim move forward and a same-state aggregate patch through", async () => {
      const { claimId } = await seedClaim(ORG_A, "DRAFT");
      await asApp(ORG_A, async (c) => {
        await c.query("UPDATE claim SET total_charge_cents=5 WHERE id=$1", [claimId]);
        await c.query("UPDATE claim SET state='VALIDATING' WHERE id=$1", [claimId]);
      });
    });

    it("refuses to re-parent a claim_line onto a draft claim, so re-parent-then-delete fails", async () => {
      const sent = await seedClaim(ORG_A, "SUBMITTED");
      const draft = await seedClaim(ORG_A, "DRAFT");
      await asApp(ORG_A, (c) =>
        expect(
          c.query("UPDATE claim_line SET claim_id=$1 WHERE claim_id=$2", [
            draft.claimId,
            sent.claimId,
          ]),
        ).rejects.toThrow(/M23_CLAIM_LINE_REPARENT/),
      );
      await asApp(ORG_A, (c) =>
        expect(
          c.query("UPDATE claim_line SET organization_id=$1 WHERE claim_id=$2", [
            ORG_B,
            sent.claimId,
          ]),
        ).rejects.toThrow(),
      );
      expect(await count("claim_line", "claim_id=$1", [sent.claimId])).toBe(2);
    });

    it("closes the same re-parenting hole on every other table in the allow-list", async () => {
      const sent = await seedClaim(ORG_A, "SUBMITTED");
      const draft = await seedClaim(ORG_A, "DRAFT");
      const cases: Array<[string, unknown[]]> = [
        [
          "UPDATE per_diem_rate_calculation SET claim_id=$2 WHERE claim_id=$1",
          [sent.claimId, draft.claimId],
        ],
        ["UPDATE sia_calculation SET claim_id=$2 WHERE claim_id=$1", [sent.claimId, draft.claimId]],
        ["UPDATE validation_run SET claim_id=$2 WHERE claim_id=$1", [sent.claimId, draft.claimId]],
        [
          "UPDATE claim_state_history SET claim_id=$2 WHERE claim_id=$1",
          [sent.claimId, draft.claimId],
        ],
        [
          "UPDATE validation_result SET validation_run_id=$2 WHERE validation_run_id=$1",
          [sent.runId, draft.runId],
        ],
        [
          "UPDATE validation_override SET result_id=$2 WHERE result_id=$1",
          [sent.resultId, draft.resultId],
        ],
      ];
      for (const [sql, args] of cases) {
        await asApp(ORG_A, (c) =>
          expect(c.query(sql, args)).rejects.toThrow(/M23_TABLE_APPEND_ONLY/),
        );
      }
    });

    it("refuses to delete a DRAFT claim that already has a submission or acknowledgment row", async () => {
      const { claimId } = await seedClaim(ORG_A, "DRAFT");
      const sub = uuid();
      await admin.query(
        `INSERT INTO claim_submission (id, organization_id, provider_entity_id, kind, claim_id, claim_control_number, attempt_index)
         VALUES ($1,$2,$3,'claim_837i',$4,$5,0)`,
        [sub, ORG_A, PE, claimId, `CCN-SUB-${claimId}`],
      );
      await expect(svc().deleteDraftClaim(actorA, claimId)).rejects.toThrow(/transmitted/i);
      await asApp(ORG_A, (c) =>
        expect(c.query("DELETE FROM claim WHERE id=$1", [claimId])).rejects.toThrow(
          /M23_CLAIM_NOT_DRAFT/,
        ),
      );
      expect(await count("claim", "id=$1", [claimId])).toBe(1);
      expect(await count("claim_line", "claim_id=$1", [claimId])).toBe(2);
    });

    it("cannot be fooled by a TEMP table named claim shadowing the real one (M1)", async () => {
      const sent = await seedClaim(ORG_A, "SUBMITTED");
      await asApp(ORG_A, async (c) => {
        await c.query(
          "CREATE TEMP TABLE claim (id uuid, organization_id uuid, state text) ON COMMIT DROP",
        );
        await c.query("INSERT INTO pg_temp.claim VALUES ($1,$2,'DRAFT')", [sent.claimId, ORG_A]);
        await expect(
          c.query("DELETE FROM claim_line WHERE claim_id=$1", [sent.claimId]),
        ).rejects.toThrow(/M23_CLAIM_NOT_DRAFT/);
        await c.query("ROLLBACK").catch(() => undefined);
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
        await c.query(
          "CREATE TEMP TABLE validation_run (id uuid, organization_id uuid, claim_id uuid) ON COMMIT DROP",
        );
        await expect(
          c.query("DELETE FROM per_diem_rate_calculation WHERE claim_id=$1", [sent.claimId]),
        ).rejects.toThrow(/M23_TABLE_APPEND_ONLY/);
      });
      expect(await count("claim_line", "claim_id=$1", [sent.claimId])).toBe(2);
    });

    it("pins every guard function's search_path with pg_temp last", async () => {
      const { rows } = await admin.query(
        `SELECT proname, proconfig FROM pg_proc WHERE proname = ANY($1)`,
        [
          [
            "m23_is_destruction_role",
            "m23_claim_delete_guard",
            "m23_claim_line_delete_guard",
            "m23_enforce_append_only_unless_draft_claim",
            "m23_claim_is_deletable",
            "m23_claim_no_revert_to_draft",
            "m23_claim_line_no_reparent",
          ],
        ],
      );
      expect(rows).toHaveLength(7);
      for (const r of rows) expect(r.proconfig).toContain("search_path=pg_catalog, pg_temp");
    });
  });
  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // Migration 1068 — the physician-name + diagnosis snapshot is writable only while the claim is DRAFT.
  // ───────────────────────────────────────────────────────────────────────────────────────────────
  describe("physician / diagnosis snapshot (migration 1068)", () => {
    const SNAP_A = {
      attendingPhysicianFirstName: "Ada",
      attendingPhysicianLastName: "Lovelace",
      certifyingPhysicianFirstName: null,
      certifyingPhysicianLastName: null,
      diagnosisSnapshot: [{ icd10Code: "C3490", sequence: 1, qualifier: "ABK" as const }],
    };
    const SNAP_B = {
      attendingPhysicianFirstName: "Grace",
      attendingPhysicianLastName: "Hopper",
      certifyingPhysicianFirstName: "Ada",
      certifyingPhysicianLastName: "Lovelace",
      diagnosisSnapshot: [
        { icd10Code: "C787", sequence: 1, qualifier: "ABK" as const },
        { icd10Code: "J449", sequence: 2, qualifier: "ABF" as const },
      ],
    };
    const NO_NPIS = { attendingPhysicianNpi: null, certifyingPhysicianNpi: null } as const;
    const inCtx = <T>(
      org: string,
      user: string,
      fn: (r: repositories.ClaimRepository) => Promise<T>,
    ) =>
      withOrgContext(handle.db, { organizationId: org, userId: user }, (tx) =>
        fn(new repositories.ClaimRepository(tx as never)),
      );
    const snapshotRow = async (claimId: string) =>
      (
        await admin.query(
          `SELECT attending_physician_last_name AS al, diagnosis_snapshot AS dx FROM claim WHERE id=$1`,
          [claimId],
        )
      ).rows[0];

    it("a new claim defaults to an empty snapshot; a DRAFT's snapshot is refreshed and read back", async () => {
      const { claimId } = await seedClaim(ORG_A, "DRAFT");
      expect(await inCtx(ORG_A, USER_A, (r) => r.snapshotFor(claimId))).toMatchObject({
        attendingPhysicianLastName: null,
        diagnosisSnapshot: [],
      });
      expect(await inCtx(ORG_A, USER_A, (r) => r.refreshSnapshot(claimId, NO_NPIS, SNAP_A))).toBe(
        true,
      );
      expect(await inCtx(ORG_A, USER_A, (r) => r.snapshotFor(claimId))).toEqual(SNAP_A);
      // Re-assembly replaces, it does not append.
      await inCtx(ORG_A, USER_A, (r) => r.refreshSnapshot(claimId, NO_NPIS, SNAP_B));
      expect(await inCtx(ORG_A, USER_A, (r) => r.snapshotFor(claimId))).toEqual(SNAP_B);
    });

    it("every state from SUBMITTED onward refuses a snapshot change (service guard and database trigger)", async () => {
      for (const state of ["SUBMITTED", "ACK_ACCEPTED", "PAID", "VOIDED"]) {
        const { claimId } = await seedClaim(ORG_A, "DRAFT");
        await inCtx(ORG_A, USER_A, (r) => r.refreshSnapshot(claimId, NO_NPIS, SNAP_A));
        await admin.query("UPDATE claim SET state=$2 WHERE id=$1", [claimId, state]);
        await expect(
          inCtx(ORG_A, USER_A, (r) => r.refreshSnapshot(claimId, NO_NPIS, SNAP_B)),
        ).rejects.toMatchObject({ code: "CLAIM_SNAPSHOT_IMMUTABLE" });
        // The trigger holds even for a raw statement as the app role (the service guard is not the only guard).
        await asApp(ORG_A, async (c) => {
          await expect(
            c.query("UPDATE claim SET diagnosis_snapshot='[]'::jsonb WHERE id=$1", [claimId]),
          ).rejects.toThrow(/M23_CLAIM_SNAPSHOT_IMMUTABLE/);
        });
        await asApp(ORG_A, async (c) => {
          await expect(
            c.query(
              "UPDATE claim SET attending_physician_first_name='X', attending_physician_last_name='Y' WHERE id=$1",
              [claimId],
            ),
          ).rejects.toThrow(/M23_CLAIM_SNAPSHOT_IMMUTABLE/);
        });
        expect((await snapshotRow(claimId)).dx).toEqual(SNAP_A.diagnosisSnapshot);
      }
    });

    it("VALIDATING and READY claims still follow the NPIs: NPI, names and diagnoses change together", async () => {
      for (const state of ["VALIDATING", "READY"]) {
        const { claimId } = await seedClaim(ORG_A, "DRAFT");
        await inCtx(ORG_A, USER_A, (r) =>
          r.refreshSnapshot(
            claimId,
            { attendingPhysicianNpi: "1234567893", certifyingPhysicianNpi: null },
            SNAP_A,
          ),
        );
        await admin.query("UPDATE claim SET state=$2 WHERE id=$1", [claimId, state]);
        const next = { attendingPhysicianNpi: "1982736455", certifyingPhysicianNpi: "1245319599" };
        expect(await inCtx(ORG_A, USER_A, (r) => r.refreshSnapshot(claimId, next, SNAP_B))).toBe(
          true,
        );
        const row = (
          await admin.query(
            `SELECT attending_physician_npi AS an, attending_physician_last_name AS al,
                    certifying_physician_npi AS cn, certifying_physician_last_name AS cl, diagnosis_snapshot AS dx
               FROM claim WHERE id=$1`,
            [claimId],
          )
        ).rows[0];
        expect(row).toEqual({
          an: "1982736455",
          al: "Hopper",
          cn: "1245319599",
          cl: "Lovelace",
          dx: SNAP_B.diagnosisSnapshot,
        });
        // Unchanged inputs are a no-op, not an error.
        expect(await inCtx(ORG_A, USER_A, (r) => r.refreshSnapshot(claimId, next, SNAP_B))).toBe(
          false,
        );
        // As the app role the trigger also allows it in these states.
        await asApp(ORG_A, async (c) => {
          const r = await c.query("UPDATE claim SET diagnosis_snapshot='[]'::jsonb WHERE id=$1", [
            claimId,
          ]);
          expect(r.rowCount).toBe(1);
        });
      }
    });

    it("moving to SUBMITTED freezes the snapshot: unchanged is fine, rewriting it in the same hop is not", async () => {
      const { claimId } = await seedClaim(ORG_A, "DRAFT");
      await inCtx(ORG_A, USER_A, (r) => r.refreshSnapshot(claimId, NO_NPIS, SNAP_A));
      await admin.query("UPDATE claim SET state='READY' WHERE id=$1", [claimId]);
      await asApp(ORG_A, async (c) => {
        await expect(
          c.query(
            "UPDATE claim SET state='SUBMITTED', diagnosis_snapshot='[]'::jsonb WHERE id=$1",
            [claimId],
          ),
        ).rejects.toThrow(/M23_CLAIM_SNAPSHOT_IMMUTABLE/);
      });
      await asApp(ORG_A, async (c) => {
        const r = await c.query("UPDATE claim SET state='SUBMITTED' WHERE id=$1", [claimId]);
        expect(r.rowCount).toBe(1);
      });
      expect((await snapshotRow(claimId)).dx).toEqual(SNAP_A.diagnosisSnapshot);
    });

    it("keeps the diagnosis codes and physician names out of the write-audit trail", async () => {
      const { claimId } = await seedClaim(ORG_A, "DRAFT");
      await inCtx(ORG_A, USER_A, (r) => r.refreshSnapshot(claimId, NO_NPIS, SNAP_A));
      const events = (
        await admin.query(
          `SELECT before::text AS b, after::text AS a FROM audit_event
            WHERE resource_kind='claim' AND resource_id=$1 AND event_type IN ('claim.insert','claim.update')`,
          [claimId],
        )
      ).rows;
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        for (const text of [e.b, e.a].filter((t): t is string => typeof t === "string")) {
          expect(text).not.toContain("C3490");
          expect(text).not.toContain("Lovelace");
          expect(text).toContain("<changed>");
        }
      }
    });

    it("is tenant-isolated: org B can neither read nor replace org A's snapshot", async () => {
      const { claimId } = await seedClaim(ORG_A, "DRAFT");
      await inCtx(ORG_A, USER_A, (r) => r.refreshSnapshot(claimId, NO_NPIS, SNAP_A));
      expect(await inCtx(ORG_B, USER_B, (r) => r.snapshotFor(claimId))).toBeNull();
      expect(await inCtx(ORG_B, USER_B, (r) => r.refreshSnapshot(claimId, NO_NPIS, SNAP_B))).toBe(
        false,
      );
      await asApp(ORG_B, async (c) => {
        const r = await c.query("UPDATE claim SET diagnosis_snapshot='[]'::jsonb WHERE id=$1", [
          claimId,
        ]);
        expect(r.rowCount).toBe(0);
      });
      expect((await snapshotRow(claimId)).dx).toEqual(SNAP_A.diagnosisSnapshot);
    });

    it("rejects half a name and a non-array / oversized diagnosis snapshot", async () => {
      const { claimId } = await seedClaim(ORG_A, "DRAFT");
      await expect(
        admin.query("UPDATE claim SET certifying_physician_first_name='Ada' WHERE id=$1", [
          claimId,
        ]),
      ).rejects.toThrow(/claim_certifying_physician_name_chk/);
      await expect(
        admin.query("UPDATE claim SET diagnosis_snapshot='{}'::jsonb WHERE id=$1", [claimId]),
      ).rejects.toThrow(/claim_diagnosis_snapshot_shape_chk/);
      await expect(
        admin.query(
          "UPDATE claim SET diagnosis_snapshot=(SELECT jsonb_agg(i) FROM generate_series(1,26) i) WHERE id=$1",
          [claimId],
        ),
      ).rejects.toThrow(/claim_diagnosis_snapshot_shape_chk/);
    });

    it("a DRAFT claim with a snapshot is still deletable (the snapshot lives on the claim row)", async () => {
      const { claimId } = await seedClaim(ORG_A, "DRAFT");
      await inCtx(ORG_A, USER_A, (r) => r.refreshSnapshot(claimId, NO_NPIS, SNAP_A));
      await svc().deleteDraftClaim(actorA, claimId);
      expect(await count("claim", "id=$1", [claimId])).toBe(0);
    });
  });
});
