/**
 * M10 HOPE Engine — RLS cross-tenant denial: the LIVE Postgres proof (§3.3 / §3.5 / ADR-0010).
 *
 * M10's pure suites exercise the timepoint schedule, SFV, validation and submission state machines but
 * never touch a database, so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table
 * grant that leaks across tenants. This applies the real migrations (0034 tables + 0035 RLS/audit) to a real
 * Postgres and drives the policies as the unprivileged `chartwarden_app` role (no BYPASSRLS), covering all SIX
 * org-scoped M10-owned tables.
 *
 * The one that makes this worth more than a checkbox is `hope_assessment` — the signed HOPE record (the very
 * document submitted to iQIES for CMS HQRP), carrying the patient's clinical `data` jsonb. A cross-tenant
 * write would let one tenant manufacture another's HOPE assessments, or read another org's PHI. It is also
 * RANGE-partitioned on target_date (§3.6): its `_org` policy lives on the partitioned PARENT, and every query
 * in this suite goes through the parent (`hope_assessment`), so the parent policy is what enforces isolation.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m10` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** The single membership actor's underlying `user`; `hope_assessment.created_by_membership_id` carries a real
 * FK to `membership`, so one seeded membership per org is enough for every membership reference in the chain. */
const USER = "33333333-3333-3333-3333-333333333333";
/** patient_id / admission_id are NOT NULL on every M10 table but carry NO FK — literals are fine. */
const PATIENT = "44444444-4444-4444-4444-444444444444";
// Distinct per org: `uniq_hope_sched_admission_rfa_open` is UNIQUE(admission_id, rfa_kind) and does NOT
// include organization_id, so two orgs sharing one admission literal would collide (not a tenancy bug —
// the index is scoped by the admission, which is itself org-owned upstream).
const ADMISSION_A = "55555555-5555-5555-5555-555555555555";
const ADMISSION_B = "66666666-6666-6666-6666-666666666666";

type SeedIds = {
  membership: string;
  providerEntity: string;
  location: string;
  schedule: string;
  assessment: string;
  sfv: string;
  finding: string;
  submission: string;
  submissionItem: string;
  answer: string;
  resultEvent: string;
  retentionReview: string;
};

// All six M10-owned tables are org-scoped (organization_id NOT NULL) and each carries a direct `<table>_org`
// RLS policy in 0035 — including `hope_assessment`, whose policy is on the RANGE-partitioned PARENT and is
// enforced because the sweep queries the parent, not a leaf. No M10 table is a catalog / non-org-scoped table,
// so none is excluded from COVERED and the policy-block count equals COVERED.length (= 6).
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "hope_timepoint_schedule", key: "schedule" },
  { table: "hope_assessment", key: "assessment" }, // partitioned parent; policy on parent (see file header)
  { table: "symptom_follow_up_visit", key: "sfv" },
  { table: "hope_validation_finding", key: "finding" },
  { table: "hope_submission", key: "submission" },
  { table: "hope_submission_item", key: "submissionItem" },
];

// GAP-183 — org-scoped PHI tables whose RLS landed in a later migration than 0035 (the result event had NO
// RLS until 0233) and so were never in the policy-shape list above: the per-item HOPE answers and the
// iQIES validation-report result events.
const EXTRA_COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "hope_assessment_answer", key: "answer" },
  { table: "hope_submission_result_event", key: "resultEvent" },
  { table: "hope_retention_review", key: "retentionReview" }, // GAP-181 (0482)
];

describe.skipIf(!DB_URL)("M10 HOPE — RLS cross-tenant denial — LIVE Postgres (§3.5)", () => {
  let db: Client;
  let a: SeedIds;
  let b: SeedIds;

  async function withOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
    await db.query("SET ROLE chartwarden_app");
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
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
          "-- (vector extension stripped: CHARTWARDEN_TEST_NO_PGVECTOR set)",
        );
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped: no pgvector)");
      }
      await db.query(sql);
    }
  }

  /** Seed one full M10 HOPE chain for `org` as superuser (RLS + grants bypassed). */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const ADMISSION = n === 1 ? ADMISSION_A : ADMISSION_B;
    const membership = (
      await db.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, org],
      )
    ).rows[0].id as string;

    const providerEntity = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M10${n}`, `M10 Provider ${n}`, `NPI-M10${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M10${n}`],
      )
    ).rows[0].id as string;

    const schedule = (
      await db.query(
        `INSERT INTO hope_timepoint_schedule (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, rfa_kind, window_opens_at, window_closes_at, late_deadline_at, alert_cadence,
           generated_by)
         VALUES ($1,$2,$3,$4,$5,'01_admission', now(), now() + interval '5 days', now() + interval '10 days',
           '{}'::jsonb, 'auto_admission') RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION],
      )
    ).rows[0].id as string;

    const assessment = (
      await db.query(
        `INSERT INTO hope_assessment (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, schedule_id, rfa_kind, data, target_date, created_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6,'01_admission', '{}'::jsonb, now(), $7) RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, schedule, membership],
      )
    ).rows[0].id as string;

    // triggering_assessment_id / hope_assessment_id are NOT NULL but carry NO FK — the assessment id is a
    // realistic (and unique) value that satisfies the uniq_sfv_per_triggering_assessment / active-item indexes.
    const sfv = (
      await db.query(
        `INSERT INTO symptom_follow_up_visit (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, triggering_assessment_id, triggered_at, due_at, alert_cadence)
         VALUES ($1,$2,$3,$4,$5,$6, now(), now() + interval '2 days', '{}'::jsonb) RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, assessment],
      )
    ).rows[0].id as string;

    const finding = (
      await db.query(
        `INSERT INTO hope_validation_finding (organization_id, provider_entity_id, location_id,
           hope_assessment_id, rule_id, severity, section, message)
         VALUES ($1,$2,$3,$4,'RULE-1','warning','J2051','finding message') RETURNING id`,
        [org, providerEntity, location, assessment],
      )
    ).rows[0].id as string;

    const submission = (
      await db.query(
        `INSERT INTO hope_submission (organization_id, provider_entity_id, submission_period,
           envelope_storage_uri, envelope_sha256, item_count)
         VALUES ($1,$2,'2026Q1','s3://envelope','sha-abc',1) RETURNING id`,
        [org, providerEntity],
      )
    ).rows[0].id as string;

    const submissionItem = (
      await db.query(
        `INSERT INTO hope_submission_item (organization_id, hope_submission_id, hope_assessment_id)
         VALUES ($1,$2,$3) RETURNING id`,
        [org, submission, assessment],
      )
    ).rows[0].id as string;

    // hope_spec_* are global (non-org) catalog tables; one fixture version/item per org keeps `code` unique.
    const specVersion = (
      await db.query(
        `INSERT INTO hope_spec_version
           (code, item_set_version, effective_from, effective_to, source_label, source_release)
         VALUES ($1,'1.00','2025-10-01',NULL,'RLS fixture','FINAL') RETURNING id`,
        [`RLS-M10-${n}`],
      )
    ).rows[0].id as string;
    const specItem = (
      await db.query(
        `INSERT INTO hope_spec_item (spec_version_id, cms_item_master_key, item_code, database_item_code,
           short_label, section_label, item_sort_order, section_sort_order, cms_item_type_code, kind,
           source_metadata)
         VALUES ($1,$2,'A0000',$3,'Fixture','Administrative',10,1,'C','assessment','{}'::jsonb)
         RETURNING id`,
        [specVersion, `RLS-KEY-${n}`, `A0000_DB_${n}`],
      )
    ).rows[0].id as string;

    // hope_assessment_id carries NO FK (the table is range-partitioned), so the real assessment id is used.
    const answer = (
      await db.query(
        `INSERT INTO hope_assessment_answer (organization_id, provider_entity_id, location_id,
           hope_assessment_id, spec_version_id, spec_item_id, state, value, source)
         VALUES ($1,$2,$3,$4,$5,$6,'answered','"yes"'::jsonb,'user') RETURNING id`,
        [org, providerEntity, location, assessment, specVersion, specItem],
      )
    ).rows[0].id as string;

    const resultEvent = (
      await db.query(
        `INSERT INTO hope_submission_result_event (organization_id, hope_submission_id, hope_submission_item_id,
           report_hash, result_status)
         VALUES ($1,$2,$3,'hash-abc','accepted') RETURNING id`,
        [org, submission, submissionItem],
      )
    ).rows[0].id as string;

    const retentionReview = (
      await db.query(
        `INSERT INTO hope_retention_review (organization_id, provider_entity_id, location_id, patient_id,
           basis, anchor_at, retention_years, eligible_at, status)
         VALUES ($1,$2,$3,$4,'standard_7y', now(), 7, now() + interval '7 years', 'cleared') RETURNING id`,
        [org, providerEntity, location, PATIENT],
      )
    ).rows[0].id as string;

    return {
      membership,
      providerEntity,
      location,
      schedule,
      assessment,
      sfv,
      finding,
      submission,
      submissionItem,
      answer,
      resultEvent,
      retentionReview,
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
    await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m10-actor@x.test')`, [USER]);
    a = await seedOrg(ORG_A, 1);
    b = await seedOrg(ORG_B, 2);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
  // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
  // scripts/db/migrate.ts grants exactly that behind CHARTWARDEN_DEV_BYPASSRLS=1, so this is reachable.
  it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("every M10 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    const rls = readFileSync(join(MIGRATIONS_DIR, "0035_hope_m10_rls_audit_triggers.sql"), "utf8");
    const policyBlocks = (rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? []).filter(
      (b) => COVERED.some((t) => b.includes(`"${t.table}"`)),
    );
    expect(policyBlocks.length).toBe(COVERED.length);
    for (const block of policyBlocks) {
      const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
      expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
      expect(block).not.toMatch(/pg_has_role/i);
      expect(block).not.toMatch(/IS NULL/i);
    }
  });

  // GAP-183 — tables whose RLS policy lives in a LATER migration than the file the policy-shape case above
  // reads, so they are proven here by behaviour (and the catalog check below) rather than by policy text.
  it.each([...COVERED, ...EXTRA_COVERED])(
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
      expect(seenByB.rows[0].n).toBe(0);
    },
  );

  it("a WITH CHECK refuses a HOPE assessment forged into another tenant's org", async () => {
    // hope_assessment is the signed HOPE record submitted to iQIES for CMS HQRP — a cross-tenant write would
    // let one tenant manufacture another's assessments (and plant PHI in the `data` jsonb under org A).
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO hope_assessment (organization_id, provider_entity_id, location_id, patient_id,
             admission_id, rfa_kind, data, target_date, created_by_membership_id)
           VALUES ($1,$2,$3,$4,$5,'01_admission','{}'::jsonb, now(), $6)`,
          [ORG_A, a.providerEntity, a.location, PATIENT, ADMISSION_A, a.membership],
        ),
      ),
    ).rejects.toThrow();
  });

  it("org B cannot UPDATE org A's timepoint schedule (the USING clause covers writes too)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE hope_timepoint_schedule SET status='skipped' WHERE id=$1", [a.schedule]),
    );
    expect(res.rowCount).toBe(0);
    const still = await db.query("SELECT status FROM hope_timepoint_schedule WHERE id=$1", [
      a.schedule,
    ]);
    expect(still.rows[0].status).toBe("open");
  });

  it("the M4 write-audit trigger fired for the hope_assessment writes (§3.4)", async () => {
    const r = await db.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'hope_assessment'",
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});
