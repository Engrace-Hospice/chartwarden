/**
 * M41 Billing - Commercial, payer and plan model (issue #721) - LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Proves: tenant B sees none of tenant A's plans, routes or rates and cannot write into A (RLS is forced); the app role has
 * no DELETE; a plan must name an ACTIVE COMMERCIAL M40 payer (Medicare, Medicaid, Medicare Advantage and merged payers are
 * refused); the claim filing indicator is limited to the commercial set; effective dating refuses an overlapping plan,
 * route or rate but allows adjacent periods; a child cannot point at another tenant's plan (composite FK); a rate carries
 * exactly the amount its basis names; the anchor columns are not updatable by the app role; the audit trail records plan
 * writes; no table has a column that could hold PHI.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m41:payer-plan:live
 * (SUPERUSER to a THROWAWAY db on a PRIVATE pgvector/pgvector:pg18 - this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "00000000-0000-4000-8000-0000000041a1";
const ORG_B = "00000000-0000-4000-8000-0000000041b1";
const TABLES = ["commercial_payer_plan", "commercial_payer_route", "commercial_contract_rate"];

describe.skipIf(!DB_URL)("M41 commercial payer and plan model - LIVE Postgres", () => {
  let admin: Client;
  let app: Client;
  let commercialPayer: string;
  let medicarePayer: string;
  let medicaidPayer: string;
  let advantagePayer: string;
  let mergedPayer: string;
  let inactivePayer: string;
  let otherPayer: string;

  /** Run `fn` as chartwarden_app inside one transaction scoped to `org` (what withOrgContext does). */
  async function asOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.org_id', $1, true)", [org]);
      const out = await fn();
      await app.query("COMMIT");
      return out;
    } catch (e) {
      await app.query("ROLLBACK");
      throw e;
    }
  }
  const failure = (p: Promise<unknown>) =>
    p.then(
      () => "",
      (e: { message?: string }) => e.message ?? "failed",
    );

  const planSql = `INSERT INTO commercial_payer_plan
    (organization_id, payer_id, plan_name, claim_filing_indicator, effective_from, effective_to)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`;
  const newPlan = (
    org: string,
    payer: string,
    name: string,
    cfi = "CI",
    from = "2026-01-01",
    to: string | null = null,
  ) => asOrg(org, async () => (await app.query(planSql, [org, payer, name, cfi, from, to])).rows[0].id as string);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await dropLiveRoles(admin);
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [org, slug] of [
      [ORG_A, "m41-a"],
      [ORG_B, "m41-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'A','A')",
        [org, slug],
      );
    }
    const mkPayer = async (kind: string, name: string, status = "active") =>
      (
        await admin.query(
          "INSERT INTO payer (kind, name, status) VALUES ($1::payer_kind,$2,$3::mdm_entity_status) RETURNING id",
          [kind, name, status],
        )
      ).rows[0].id as string;
    commercialPayer = await mkPayer("commercial", "Synthetic Commercial Health");
    medicarePayer = await mkPayer("medicare", "Synthetic Medicare");
    medicaidPayer = await mkPayer("medicaid", "Synthetic Medicaid");
    advantagePayer = await mkPayer("medicare_advantage", "Synthetic Advantage");
    inactivePayer = await mkPayer("commercial", "Synthetic Deactivated", "deactivated");
    otherPayer = await mkPayer("other", "Synthetic Other Program");
    const survivor = await mkPayer("commercial", "Synthetic Survivor");
    mergedPayer = (
      await admin.query(
        "INSERT INTO payer (kind, name, status, merged_into_id) VALUES ('commercial','Synthetic Merged','merged',$1) RETURNING id",
        [survivor],
      )
    ).rows[0].id as string;
    app = new Client({ connectionString: await appRoleConnectionString(admin, DB_URL as string) });
    await app.connect();
  }, 600_000);

  afterAll(async () => {
    await app?.end();
    await admin?.end();
  });

  it("isolates tenants: B reads nothing of A and cannot write into A", async () => {
    const planA = await newPlan(ORG_A, commercialPayer, "iso-plan");
    await asOrg(ORG_A, () =>
      app.query(
        `INSERT INTO commercial_payer_route (organization_id, plan_id, clearinghouse_key, clearinghouse_payer_id, effective_from)
         VALUES ($1,$2,'stedi','SYNTH01','2026-01-01')`,
        [ORG_A, planA],
      ),
    );
    await asOrg(ORG_A, () =>
      app.query(
        `INSERT INTO commercial_contract_rate (organization_id, plan_id, level_of_care, revenue_code, rate_basis, rate_cents, effective_from)
         VALUES ($1,$2,'routine_home_care','0651','per_diem',20000,'2026-01-01')`,
        [ORG_A, planA],
      ),
    );
    for (const t of TABLES) {
      const own = await asOrg(ORG_A, () => app.query(`SELECT count(*)::int AS n FROM ${t}`));
      const other = await asOrg(ORG_B, () => app.query(`SELECT count(*)::int AS n FROM ${t}`));
      expect(own.rows[0].n).toBeGreaterThan(0);
      expect(other.rows[0].n).toBe(0);
    }
    // writing a row stamped with A while scoped to B fails the WITH CHECK
    expect(await failure(asOrg(ORG_B, () => app.query(planSql, [ORG_A, commercialPayer, "x", "CI", "2026-01-01", null])))).toMatch(
      /row-level security/,
    );
    // B cannot update or delete A's rows (invisible, zero rows)
    const upd = await asOrg(ORG_B, () =>
      app.query("UPDATE commercial_payer_plan SET effective_to = '2026-12-31' WHERE id = $1", [planA]),
    );
    expect(upd.rowCount).toBe(0);
  });

  it("forces RLS and gives the app role no DELETE", async () => {
    const { rows } = await admin.query(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)",
      [TABLES],
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
    const planA = await newPlan(ORG_A, commercialPayer, "nodelete-plan");
    expect(await failure(asOrg(ORG_A, () => app.query("DELETE FROM commercial_payer_plan WHERE id=$1", [planA])))).toMatch(
      /permission denied/,
    );
  });

  it("refuses a plan whose payer is not an active commercial payer", async () => {
    for (const bad of [medicarePayer, medicaidPayer, advantagePayer, mergedPayer, inactivePayer, randomUUID()]) {
      expect(await failure(newPlan(ORG_A, bad, "bad-payer"))).toMatch(/M41_PLAN_PAYER_NOT_COMMERCIAL/);
    }
    await newPlan(ORG_A, otherPayer, "tricare-like", "CH"); // non-Medicare program payers are kind 'other'
  });

  it("limits the claim filing indicator to the commercial set", async () => {
    for (const bad of ["MA", "MB", "MC", "16", "09"]) {
      expect(await failure(newPlan(ORG_A, commercialPayer, `cfi-${bad}`, bad))).toMatch(/claim_filing_indicator/);
    }
    for (const ok of ["12", "HM", "BL"]) await newPlan(ORG_A, commercialPayer, `cfi-ok-${ok}`, ok);
  });

  it("effective dating: overlap refused, adjacent periods and other tenants allowed", async () => {
    await newPlan(ORG_A, commercialPayer, "dated", "CI", "2026-01-01", "2026-06-30");
    expect(await failure(newPlan(ORG_A, commercialPayer, "Dated", "CI", "2026-06-30", null))).toMatch(/no_overlap/);
    await newPlan(ORG_A, commercialPayer, "dated", "CI", "2026-07-01", null); // adjacent
    await newPlan(ORG_B, commercialPayer, "dated", "CI", "2026-01-01", null); // other tenant, same payer and name
    expect(await failure(newPlan(ORG_A, commercialPayer, "backwards", "CI", "2026-05-01", "2026-04-01"))).toMatch(/plan_dates/);
  });

  it("routes and rates: composite FK blocks another tenant's plan; overlap and amount shape enforced", async () => {
    const planA = await newPlan(ORG_A, commercialPayer, "child-plan");
    const planB = await newPlan(ORG_B, commercialPayer, "child-plan-b");
    const route = (org: string, plan: string, from = "2026-01-01", to: string | null = null, key = "stedi") =>
      asOrg(org, () =>
        app.query(
          `INSERT INTO commercial_payer_route (organization_id, plan_id, clearinghouse_key, clearinghouse_payer_id, effective_from, effective_to)
           VALUES ($1,$2,$3,'SYNTH02',$4,$5)`,
          [org, plan, key, from, to],
        ),
      );
    expect(await failure(route(ORG_A, planB))).toMatch(/foreign key|row-level security/);
    await route(ORG_A, planA, "2026-01-01", "2026-03-31");
    expect(await failure(route(ORG_A, planA, "2026-03-01"))).toMatch(/no_overlap/);
    await route(ORG_A, planA, "2026-01-01", null, "claimmd"); // another clearinghouse, same dates
    expect(await failure(route(ORG_A, planA, "2026-04-01", null, "Bad Key!"))).toMatch(/clearinghouse_key/);

    const rate = (basis: string, cents: number | null, pct: number | null, from = "2026-01-01", to: string | null = null) =>
      asOrg(ORG_A, () =>
        app.query(
          `INSERT INTO commercial_contract_rate (organization_id, plan_id, level_of_care, revenue_code, rate_basis, rate_cents, percent_of_charges, effective_from, effective_to)
           VALUES ($1,$2,'general_inpatient','0656',$3,$4,$5,$6,$7)`,
          [ORG_A, planA, basis, cents, pct, from, to],
        ),
      );
    expect(await failure(rate("per_diem", null, 80))).toMatch(/commercial_contract_rate_amount/);
    expect(await failure(rate("percent_of_charges", 100, null))).toMatch(/commercial_contract_rate_amount/);
    expect(await failure(rate("percent_of_charges", null, 120))).toMatch(/percent_of_charges/);
    await rate("per_diem", 90000, null, "2026-01-01", "2026-06-30");
    await rate("percent_of_charges", null, 85, "2026-07-01");
    expect(await failure(rate("per_hour", 5000, null, "2026-06-01", "2026-06-15"))).toMatch(/rate_hourly/);
    expect(await failure(rate("per_diem", 1000, null, "2026-06-01", "2026-06-15"))).toMatch(/no_overlap/);
  });

  it("keeps anchor columns immutable for the app role but lets terms and end dates change", async () => {
    const plan = await newPlan(ORG_A, commercialPayer, "immutable-plan");
    expect(
      await failure(asOrg(ORG_A, () => app.query("UPDATE commercial_payer_plan SET payer_id=$2 WHERE id=$1", [plan, medicarePayer]))),
    ).toMatch(/permission denied/);
    expect(
      await failure(asOrg(ORG_A, () => app.query("UPDATE commercial_payer_plan SET organization_id=$2 WHERE id=$1", [plan, ORG_B]))),
    ).toMatch(/permission denied/);
    const ok = await asOrg(ORG_A, () =>
      app.query(
        "UPDATE commercial_payer_plan SET authorization_requirement='required_at_admission', authorization_lead_days=3, effective_to='2026-12-31' WHERE id=$1",
        [plan],
      ),
    );
    expect(ok.rowCount).toBe(1);
    expect(
      await failure(asOrg(ORG_A, () => app.query("UPDATE commercial_payer_plan SET authorization_requirement='not_required' WHERE id=$1", [plan]))),
    ).toMatch(/auth_lead/);
  });

  it("keeps route and rate anchors immutable, refuses removal, and audits insert and update", async () => {
    const plan = await newPlan(ORG_A, commercialPayer, "anchor-plan");
    const other = await newPlan(ORG_A, commercialPayer, "anchor-plan-2");
    const route = (
      await asOrg(ORG_A, () =>
        app.query(
          `INSERT INTO commercial_payer_route (organization_id, plan_id, clearinghouse_key, clearinghouse_payer_id, effective_from)
           VALUES ($1,$2,'stedi','SYNTH03','2026-01-01') RETURNING id`,
          [ORG_A, plan],
        ),
      )
    ).rows[0].id;
    const rate = (
      await asOrg(ORG_A, () =>
        app.query(
          `INSERT INTO commercial_contract_rate (organization_id, plan_id, level_of_care, revenue_code, rate_basis, rate_cents, effective_from)
           VALUES ($1,$2,'routine_home_care','0651','per_diem',100,'2026-01-01') RETURNING id`,
          [ORG_A, plan],
        ),
      )
    ).rows[0].id;
    for (const [t, id, set] of [
      ["commercial_payer_route", route, `plan_id='${other}'`],
      ["commercial_payer_route", route, "clearinghouse_key='claimmd'"],
      ["commercial_payer_route", route, "effective_from='2025-01-01'"],
      ["commercial_contract_rate", rate, `plan_id='${other}'`],
      ["commercial_contract_rate", rate, "level_of_care='general_inpatient'"],
      ["commercial_contract_rate", rate, "effective_from='2025-01-01'"],
    ] as const) {
      expect(await failure(asOrg(ORG_A, () => app.query(`UPDATE ${t} SET ${set} WHERE id=$1`, [id])))).toMatch(
        /permission denied/,
      );
    }
    for (const [t, id] of [
      ["commercial_payer_route", route],
      ["commercial_contract_rate", rate],
    ] as const) {
      expect(await failure(asOrg(ORG_A, () => app.query(`DELETE FROM ${t} WHERE id=$1`, [id])))).toMatch(
        /permission denied/,
      );
      await asOrg(ORG_A, () => app.query(`UPDATE ${t} SET effective_to='2026-12-31' WHERE id=$1`, [id]));
      const { rows } = await admin.query(
        "SELECT event_type FROM audit_event WHERE resource_kind=$1 AND resource_id=$2 ORDER BY event_type",
        [t, id],
      );
      expect(rows.map((r: { event_type: string }) => r.event_type)).toEqual([`${t}.insert`, `${t}.update`]);
    }
  });

  it("audits plan writes, and the tables carry no PHI-capable column", async () => {
    const plan = await newPlan(ORG_A, commercialPayer, "audited-plan");
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='commercial_payer_plan' AND resource_id=$1",
      [plan],
    );
    expect(rows[0].n).toBe(1);
    const cols = await admin.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = ANY($1)",
      [TABLES],
    );
    const phi = /patient|member|subscriber|mbi|ssn|dob|birth|name_(first|last)|group_number|policy_number/i;
    expect(cols.rows.map((r) => r.column_name).filter((c: string) => phi.test(c))).toEqual([]);
  });
});
