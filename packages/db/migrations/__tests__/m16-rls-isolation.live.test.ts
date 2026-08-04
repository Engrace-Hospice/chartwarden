/**
 * M16 Bereavement — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / §9.3 / ADR-0010).
 *
 * The pure suites (apps/backend/__tests__/bereavement-*.test.ts, packages/bereavement) exercise the §2.2–2.4
 * lifecycle, the D3/D17 risk rubric and the §4.1 authz composition, but they never touch a database — so
 * they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table grant that leaks across
 * tenants. This test applies the real migrations to a real Postgres and exercises the policies as the
 * unprivileged `wardenx_app` role, proving cross-tenant denial for real on ALL 9 org-scoped M16 tables
 * under the canonical `organization_id = current_setting('app.org_id')` ONE-SHAPE policy (ADR-0010 D3 —
 * no second PERMISSIVE provider-entity policy; the PE/location narrowing the seven patient-bearing tables
 * carry is M3 ABAC at the handler, never a second policy that would OR rather than AND).
 *
 * `wardenx_app` MUST be NOBYPASSRLS for any of this to mean anything: a role with BYPASSRLS satisfies every
 * assertion below vacuously. That is asserted first, before a single isolation case runs.
 *
 * Two M16-specific cases beyond the M15 template:
 *   - `bereavement_contact_log` is PARTITIONED (§3.6 / D12). RLS is declared on the PARENT and propagates
 *     to every partition (PG11+), so the isolation case runs through the parent and would fail if a
 *     partition had somehow been created outside the policy's reach.
 *   - `bereavement_risk_score` is APPEND-ONLY (D11): the immutability trigger refuses UPDATE outright. That
 *     is asserted here as well, because "the tenant cannot update another tenant's row" and "nobody can
 *     update this row at all" are different guarantees and the ledger relies on the second one.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m16` (SUPERUSER to a THROWAWAY
 *     db — this DROPs and recreates `public`, so never point it at a database you care about).
 *   - The target needs **pgvector**: the chain does not merely `CREATE EXTENSION vector`, it declares
 *     COLUMNS of type `vector`, so stripping the extension DDL cannot make a plain image work. A
 *     `pgvector/pgvector:pgNN` container is the throwaway to use. `WARDENX_TEST_NO_PGVECTOR=1` removes
 *     only the extension statements, which is enough for the earlier migrations but not the whole chain.
 *   - Raise `max_locks_per_transaction` (512 is ample). `DROP SCHEMA public CASCADE` takes one lock per
 *     relation, and the chain's partitioned tables put the default 64 well out of reach.
 *
 * Verified green against a throwaway `pgvector/pgvector:pg16 -c max_locks_per_transaction=512`: 18/18.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** A membership sentinel — M16 stores membership ids without a cross-module FK (M2 owns that table). */
const MEMBERSHIP = "00000000-0000-0000-0000-000000000000";

type SeedIds = {
  pe: string;
  location: string;
  plan: string;
  contact: string;
  risk: string;
  outreach: string;
  log: string;
  anniversary: string;
  closure: string;
  optOut: string;
  gateOverride: string;
};

/** The 9 manifest-owned M16 tables, each with the seeded row the isolation case looks for. */
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "bereavement_plan", key: "plan" },
  { table: "bereaved_contact", key: "contact" },
  { table: "bereavement_risk_score", key: "risk" },
  { table: "bereavement_outreach", key: "outreach" },
  { table: "bereavement_contact_log", key: "log" },
  { table: "bereavement_anniversary_reminder", key: "anniversary" },
  { table: "bereavement_plan_closure", key: "closure" },
  { table: "bereavement_opt_out", key: "optOut" },
  { table: "tenant_bereavement_external_source_gate_override", key: "gateOverride" },
];

describe.skipIf(!DB_URL)("M16 Bereavement — RLS cross-tenant denial — LIVE Postgres (§3.5)", () => {
  let db: Client;
  let a: SeedIds;

  async function withOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
    await db.query("SET ROLE wardenx_app");
    await db.query("SELECT set_config('app.org_id', $1, false)", [org]);
    try {
      return await fn();
    } finally {
      await db.query("RESET ROLE");
    }
  }

  async function resetSchema() {
    await db.query("DROP SCHEMA IF EXISTS public CASCADE");
    await db.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await db.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        // Global, and tolerant of the unquoted spelling: the chain declares the extension in BOTH forms
        // (0001 quoted, 0014 bare), so a single-match anchored regex silently leaves the second one in
        // and the escape hatch fails on a migration nobody was looking at.
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
      }
      await db.query(sql);
    }
  }

  /** Seed one full M16 chain for `org` as superuser (RLS + grants bypassed). `n` distinguishes the rows. */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const patient = `4444444${n}-4444-4444-4444-444444444444`;
    const admission = `5555555${n}-5555-5555-5555-555555555555`;
    const pe = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'00000${n}','PE','123456789${n}','enc','0930') RETURNING id`,
        [org],
      )
    ).rows[0].id as string;
    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Main Office','1 Main St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [pe],
      )
    ).rows[0].id as string;
    // `active` requires an assigned counselor AND an opened_at (§3.3.1's three CHECKs).
    const plan = (
      await db.query(
        `INSERT INTO bereavement_plan (organization_id, patient_id, admission_id, provider_entity_id,
           location_id, status, death_date, death_time, assigned_counselor_user_id,
           assigned_counselor_assigned_at, opened_at)
         VALUES ($1,$2,$3,$4,$5,'active', (now() - interval '30 days')::date, now() - interval '30 days',
           $6, now() - interval '29 days', now() - interval '29 days') RETURNING id`,
        [org, patient, admission, pe, location, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const contact = (
      await db.query(
        `INSERT INTO bereaved_contact (organization_id, provider_entity_id, location_id, plan_id, status,
           display_name, relationship_code, confirmed_at)
         VALUES ($1,$2,$3,$4,'active','Survivor','spouse', now()) RETURNING id`,
        [org, pe, location, plan],
      )
    ).rows[0].id as string;
    const risk = (
      await db.query(
        `INSERT INTO bereavement_risk_score (organization_id, provider_entity_id, location_id, plan_id,
           bereaved_contact_id, score_kind, risk_factors_jsonb, rule_score, rule_tier, data_completeness,
           confidence_band)
         VALUES ($1,$2,$3,$4,$5,'rule_deterministic','{"social_isolation":true}'::jsonb, 18,'moderate',
           'partial','MEDIUM') RETURNING id`,
        [org, pe, location, plan, contact],
      )
    ).rows[0].id as string;
    // The D4 ceiling CHECK is `due_at - death_anchor_at BETWEEN 0 AND 426` days, so the anchor is the plan's
    // death instant and the touchpoint sits inside the window.
    const outreach = (
      await db.query(
        `INSERT INTO bereavement_outreach (organization_id, provider_entity_id, location_id, plan_id,
           bereaved_contact_id, kind, status, anniversary_mark, death_anchor_at, due_at, late_grace_until,
           completed_at)
         VALUES ($1,$2,$3,$4,$5,'phone_call','completed','one_month', now() - interval '30 days',
           now() - interval '1 day', now() + interval '6 days', now()) RETURNING id`,
        [org, pe, location, plan, contact],
      )
    ).rows[0].id as string;
    const log = (
      await db.query(
        `INSERT INTO bereavement_contact_log (organization_id, provider_entity_id, location_id, plan_id,
           bereaved_contact_id, outreach_id, contact_at, kind, outcome, logged_by_user_id,
           contact_responded_directly)
         VALUES ($1,$2,$3,$4,$5,$6, now(),'phone_call','engaged',$7,true) RETURNING id`,
        [org, pe, location, plan, contact, outreach, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const anniversary = (
      await db.query(
        `INSERT INTO bereavement_anniversary_reminder (organization_id, provider_entity_id, location_id,
           plan_id, mark, target_date)
         VALUES ($1,$2,$3,$4,'anniversary', (now() + interval '335 days')::date) RETURNING id`,
        [org, pe, location, plan],
      )
    ).rows[0].id as string;
    // `thirteen_month_completion` is one of the four system-driven reasons: cosign-exempt and
    // narrative-exempt, which is exactly why it is the reason a seed row can legally carry.
    const closure = (
      await db.query(
        `INSERT INTO bereavement_plan_closure (organization_id, provider_entity_id, location_id, plan_id,
           reason, close_kind, outreach_completed_count, outreach_missed_count, contacts_active_count,
           contacts_opted_out_count)
         VALUES ($1,$2,$3,$4,'thirteen_month_completion','auto',5,0,1,0) RETURNING id`,
        [org, pe, location, plan],
      )
    ).rows[0].id as string;
    const optOut = (
      await db.query(
        `INSERT INTO bereavement_opt_out (organization_id, provider_entity_id, location_id,
           bereaved_contact_id, plan_id, opt_out_kind, source_kind, recorded_by_user_id)
         VALUES ($1,$2,$3,$4,$5,'full','counselor_recorded',$6) RETURNING id`,
        [org, pe, location, contact, plan, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const gateOverride = (
      await db.query(
        `INSERT INTO tenant_bereavement_external_source_gate_override (organization_id,
           require_death_certificate_uploaded, configured_by_membership_id)
         VALUES ($1,true,$2) RETURNING id`,
        [org, MEMBERSHIP],
      )
    ).rows[0].id as string;
    return {
      pe,
      location,
      plan,
      contact,
      risk,
      outreach,
      log,
      anniversary,
      closure,
      optOut,
      gateOverride,
    };
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await resetSchema();
    await applyMigrations();
    await db.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    a = await seedOrg(ORG_A, 1);
    await seedOrg(ORG_B, 2);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  it("wardenx_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'wardenx_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("every M16 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    const rls = readFileSync(
      join(MIGRATIONS_DIR, "0102_bereavement_m16_rls_audit_triggers.sql"),
      "utf8",
    );
    const policyBlocks = rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? [];
    expect(policyBlocks.length).toBe(9);
    for (const block of policyBlocks) {
      const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((mm) => mm[1]);
      expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
      expect(block).not.toMatch(/pg_has_role/i);
      expect(block).not.toMatch(/IS NULL/i);
      // The PE narrowing the patient-bearing tables carry is ABAC at the handler, never a second pivot.
      expect(block).not.toMatch(/provider_entity_id\s*=/i);
    }
  });

  it("RLS is ENABLED and FORCEd on every owned table (a table-owner read would otherwise skip the policy)", async () => {
    const { rows } = await db.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname = ANY($1) AND relkind IN ('r','p')`,
      [COVERED.map((c) => c.table)],
    );
    expect(rows).toHaveLength(COVERED.length);
    for (const r of rows) expect(r.relrowsecurity).toBe(true);
  });

  it.each(COVERED)(
    "$table: org A sees its row, org B cannot (cross-tenant denial)",
    async ({ table, key }) => {
      const id = a[key];
      const seenByA = await withOrg(ORG_A, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
      const seenByB = await withOrg(ORG_B, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByB.rows[0].n).toBe(0); // org B cannot read org A's row
    },
  );

  it("a contact-log PARTITION cannot be addressed directly by wardenx_app (the leaf carries no grant)", async () => {
    // PostgreSQL applies the PARENT's policy to a query routed THROUGH the parent, but a leaf addressed by
    // name is governed by its own `relrowsecurity` — and `CREATE TABLE … PARTITION OF` gives a leaf neither
    // the parent's policies nor the parent's ACL. So the leaf's protection is the GRANT layer, not RLS, and
    // that is what has to be asserted: an assertion that leaves inherit RLS would pass only by accident on
    // a database where someone had enabled it leaf-by-leaf, and would say nothing about the real defense.
    const leaves = await db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'bereavement_contact_log' ORDER BY c.relname`,
    );
    expect(leaves.rows.length).toBeGreaterThan(0); // the DEFAULT plus the seeded monthly leaves

    const granted = await db.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.role_table_grants
       WHERE grantee='wardenx_app' AND table_name = ANY($1)`,
      [leaves.rows.map((r) => r.relname)],
    );
    expect(granted.rows.map((r) => r.table_name)).toEqual([]);

    // And empirically: naming a leaf directly is refused outright.
    const leaf = leaves.rows[0]?.relname as string;
    await expect(withOrg(ORG_B, () => db.query(`SELECT 1 FROM ${leaf} LIMIT 1`))).rejects.toThrow();
  });

  it("the contact log read THROUGH the parent is tenant-scoped across every partition", async () => {
    // The read that matters: the app only ever queries the parent, and the parent's policy prunes to the
    // caller's org no matter which monthly leaf the row landed in.
    const asA = await withOrg(ORG_A, () =>
      db.query<{ n: number }>("SELECT count(*)::int AS n FROM bereavement_contact_log"),
    );
    const asB = await withOrg(ORG_B, () =>
      db.query<{ n: number }>("SELECT count(*)::int AS n FROM bereavement_contact_log"),
    );
    expect(asA.rows[0].n).toBe(1);
    expect(asB.rows[0].n).toBe(1); // each org sees ONLY its own seeded log row
  });

  it("an UPDATE from the wrong tenant touches zero rows (not just an unreadable SELECT)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE bereaved_contact SET display_name = 'tampered' WHERE id=$1", [a.contact]),
    );
    expect(res.rowCount).toBe(0);
    const check = await db.query("SELECT display_name FROM bereaved_contact WHERE id=$1", [
      a.contact,
    ]);
    expect(check.rows[0].display_name).toBe("Survivor");
  });

  it("a WITH CHECK refuses an INSERT into another tenant's scope", async () => {
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO bereaved_contact (organization_id, provider_entity_id, plan_id, display_name,
             relationship_code)
           VALUES ($1,$2,$3,'Injected','friend')`,
          [ORG_A, a.pe, a.plan], // B tries to write a row scoped to A
        ),
      ),
    ).rejects.toThrow();
  });

  it("the risk-score ledger is append-only — UPDATE is refused for the OWNING tenant too (D11)", async () => {
    await expect(
      withOrg(ORG_A, () =>
        db.query("UPDATE bereavement_risk_score SET rule_tier = 'low' WHERE id=$1", [a.risk]),
      ),
    ).rejects.toThrow();
    const check = await db.query("SELECT rule_tier FROM bereavement_risk_score WHERE id=$1", [
      a.risk,
    ]);
    expect(check.rows[0].rule_tier).toBe("moderate");
  });

  it("wardenx_app holds no DELETE on the M16 tables — destruction runs through the eraser (§8.5)", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.role_table_grants
       WHERE grantee='wardenx_app' AND privilege_type='DELETE' AND table_name = ANY($1)`,
      [COVERED.map((c) => c.table)],
    );
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });
});
