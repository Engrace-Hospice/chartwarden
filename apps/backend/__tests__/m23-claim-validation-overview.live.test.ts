/**
 * M23 claim validation OVERVIEW - LIVE Postgres proof (`GET /api/v1/billing/claim-validation-summary`).
 *
 * Drives the real read service on the NOBYPASSRLS `chartwarden_app` role. Proves:
 *   - claims are counted by the outcome of their NEWEST run (an older run never counts), claims with no run are
 *     `neverValidated`, and `oldestLatestRunAt` is the stalest of the newest runs;
 *   - org isolation: another tenant's claims are never counted (RLS + the explicit org predicate);
 *   - the provider scope narrows exactly like the claim list: a scoped actor counts only their ProviderEntities,
 *     an EMPTY scope counts nothing;
 *   - the lateral lookup is served by the (claim_id, started_at) index (per-partition name on the partitioned table).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m23:claim-validation-overview:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDrizzleM23ReadService } from "../src/modules/23-billing-medicare/routes/read-service-drizzle";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBERSHIP = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const PE_1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PE_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let seq = 0;
const uuid = (): string => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
};

describe.skipIf(!DB_URL)("M23 claim validation overview - LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  const actor = (org: string) =>
    ({ organizationId: org, userId: USER, roles: [], providerEntityIds: [] }) as never;

  async function claim(org: string, pe: string): Promise<string> {
    const id = uuid();
    await admin.query(
      `INSERT INTO claim (id, organization_id, provider_entity_id, patient_id, admission_id, election_period_id_from,
         election_period_id_to, patient_payer_id, tob, service_from, service_to, state, claim_control_number,
         mac_jurisdiction, sequestration_applied_pct, sequestration_policy_id, created_by_membership_id)
       VALUES ($1,$2,$3,$4,$4,$4,$4,$4,'811','2026-09-01','2026-09-30','READY',$5,'cgs_j15','2.00',$4,$6)`,
      [id, org, pe, uuid(), `CCN-${id}`, MEMBERSHIP],
    );
    return id;
  }
  async function run(org: string, claimId: string, outcome: string, startedAt: string) {
    await admin.query(
      `INSERT INTO validation_run (id, organization_id, claim_id, trigger, outcome, run_input_hash, rules_executed,
         rules_passed, rules_failed, rules_warn, rules_info, started_at, completed_at, duration_ms)
       VALUES ($1,$2,$3,'initial_assembly',$4,$5,1,0,0,0,0,$6,$6,1)`,
      [uuid(), org, claimId, outcome, `h-${seq}`, startedAt],
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','org-a','org-a'),($2,'org-b','org-b','org-b')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'ov-a@x.test')`, [USER]);

    // Org A: c1 (PE_1) older fail then newer all_pass -> all_pass; c2 (PE_1) failures_present; c3 (PE_2) never validated.
    const c1 = await claim(ORG_A, PE_1);
    const c2 = await claim(ORG_A, PE_1);
    await claim(ORG_A, PE_2);
    await run(ORG_A, c1, "failures_present", "2026-01-01T00:00:00Z");
    await run(ORG_A, c1, "all_pass", "2026-03-01T00:00:00Z");
    await run(ORG_A, c2, "failures_present", "2026-02-01T00:00:00Z");
    // Org B: must never be counted for org A.
    const b1 = await claim(ORG_B, PE_1);
    await run(ORG_B, b1, "overrides_required", "2025-01-01T00:00:00Z");

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  const svc = () => buildDrizzleM23ReadService(handle.db);
  const zero = { all_pass: 0, failures_present: 0, overrides_required: 0, ready_for_submission: 0 };

  it("counts by NEWEST run, counts never-validated, reports the stalest newest run", async () => {
    const o = await svc().getClaimValidationOverview(actor(ORG_A), {});
    expect(o).toEqual({
      totalClaims: 3,
      neverValidated: 1,
      byOutcome: { ...zero, all_pass: 1, failures_present: 1 },
      oldestLatestRunAt: "2026-02-01T00:00:00.000Z",
    });
  });

  it("never counts another tenant's claims", async () => {
    const o = await svc().getClaimValidationOverview(actor(ORG_B), {});
    expect(o.totalClaims).toBe(1);
    expect(o.byOutcome).toEqual({ ...zero, overrides_required: 1 });
  });

  it("narrows to the provider scope; an empty scope counts nothing", async () => {
    const scoped = await svc().getClaimValidationOverview(actor(ORG_A), {
      providerEntityScope: [PE_2],
    });
    expect(scoped).toEqual({
      totalClaims: 1,
      neverValidated: 1,
      byOutcome: zero,
      oldestLatestRunAt: null,
    });
    const none = await svc().getClaimValidationOverview(actor(ORG_A), { providerEntityScope: [] });
    expect(none.totalClaims).toBe(0);
  });

  it("claim list rows carry the newest run (DISTINCT ON batch) for the same org only", async () => {
    const page = await svc().listClaims(actor(ORG_A), {}, undefined, 50);
    const outcomes = page.items.map((c) => c.latestValidationSummary?.outcome ?? null).sort();
    expect(outcomes).toEqual(["all_pass", "failures_present", null]);
  });

  it("uses the (claim_id, started_at) index for the lateral lookup", async () => {
    await admin.query("SET enable_seqscan = off");
    const { rows } = await admin.query(
      `EXPLAIN SELECT l.outcome, count(*) FROM claim c LEFT JOIN LATERAL (
         SELECT r.outcome, r.completed_at FROM validation_run r WHERE r.claim_id = c.id
         ORDER BY r.started_at DESC LIMIT 1) l ON true WHERE c.organization_id = '${ORG_A}' GROUP BY l.outcome`,
    );
    await admin.query("RESET enable_seqscan");
    expect(rows.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(
      /validation_run\w*claim_id_started_at_idx/,
    );
  });
});
