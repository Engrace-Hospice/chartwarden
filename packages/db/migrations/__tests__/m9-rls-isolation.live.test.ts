/**
 * M9 Clinical Assessments Suite — RLS cross-tenant denial: the LIVE Postgres proof (§3.3 / §3.5 / ADR-0010).
 *
 * M9's pure suites exercise correction-supersede, significant-change scoring, and the scale registry but never
 * touch a database, so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table grant
 * that leaks across tenants. This applies the real migrations (0032 tables + 0033 RLS/audit) to a real Postgres
 * and drives the policies as the unprivileged `chartwarden_app` role (no BYPASSRLS), covering all FIVE org-scoped
 * M9 tables.
 *
 * The one that makes this worth more than a checkbox is `clinical_assessment`: it holds the scored clinical
 * record (PPS/KPS/FAST/PAINAD/ESAS-r … plus the free-text `data` jsonb), and a cross-tenant write would let one
 * tenant forge or read another org's clinical assessments. It is RANGE-partitioned on captured_at (§3.6), and
 * the `_org` policy sits on the partitioned PARENT (row policies on the parent propagate to every leaf, PG11+),
 * so it keeps a direct policy block and stays in the policy-block count.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m9` (SUPERUSER to a THROWAWAY db;
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
/** `membership.user_id` carries a real FK to `user`, so a single seeded user backs every org's membership. */
const USER = "33333333-3333-3333-3333-333333333333";
/** patient_id / admission_id / clinical_assessment_id (on the child tables) are NOT NULL but carry NO FK —
 * literals / the real assessment id are fine. */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

type SeedIds = {
  membership: string;
  providerEntity: string;
  location: string;
  clinicalAssessment: string;
  assessmentCosignature: string;
  significantChangeEvent: string;
  scaleLicense: string;
  scalePolicy: string;
  reassessmentDue: string;
};

const COVERED: { table: string; key: keyof SeedIds }[] = [
  // clinical_assessment is PARTITIONED (RANGE on captured_at) but the `_org` policy is on the partitioned
  // PARENT and propagates to every leaf, so it keeps a real policy block and stays in the count.
  { table: "clinical_assessment", key: "clinicalAssessment" },
  { table: "assessment_cosignature", key: "assessmentCosignature" },
  { table: "significant_change_event", key: "significantChangeEvent" },
  { table: "scale_license", key: "scaleLicense" },
  { table: "scale_policy", key: "scalePolicy" },
];

// GAP-181 — the cadence ledger (0481): its policy lives in a later migration than the policy-shape case reads.
const EXTRA_COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "assessment_reassessment_due", key: "reassessmentDue" },
];

describe.skipIf(!DB_URL)(
  "M9 Clinical Assessments — RLS cross-tenant denial — LIVE Postgres (§3.5)",
  () => {
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

    /** Seed one full M9 assessment chain for `org` as superuser (RLS + grants bypassed). */
    async function seedOrg(org: string, n: number): Promise<SeedIds> {
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
          [org, `CCN-M9${n}`, `M9 Provider ${n}`, `NPI-M9${n}`],
        )
      ).rows[0].id as string;

      const location = (
        await db.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerEntity, `Loc-M9${n}`],
        )
      ).rows[0].id as string;

      const clinicalAssessment = (
        await db.query(
          `INSERT INTO clinical_assessment (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, scale_type, scale_version, data, score, score_interpretation, captured_at,
           captured_by_membership_id, captured_by_discipline)
         VALUES ($1,$2,$3,$4,$5,'pps','1.0','{"notes":"seed"}'::jsonb, 60, 'PPS 60%', now(), $6, 'RN')
         RETURNING id`,
          [org, providerEntity, location, PATIENT, ADMISSION, membership],
        )
      ).rows[0].id as string;

      const assessmentCosignature = (
        await db.query(
          `INSERT INTO assessment_cosignature (organization_id, provider_entity_id, location_id,
           clinical_assessment_id, cosigner_membership_id, cosigner_role, attestation_text)
         VALUES ($1,$2,$3,$4,$5,'physician','I attest') RETURNING id`,
          [org, providerEntity, location, clinicalAssessment, membership],
        )
      ).rows[0].id as string;

      const significantChangeEvent = (
        await db.query(
          `INSERT INTO significant_change_event (organization_id, provider_entity_id, location_id,
           clinical_assessment_id, rule_id, delta_value, threshold_value, status)
         VALUES ($1,$2,$3,$4,'pps_drop_20_in_14d', 20, 20, 'open') RETURNING id`,
          [org, providerEntity, location, clinicalAssessment],
        )
      ).rows[0].id as string;

      const scaleLicense = (
        await db.query(
          `INSERT INTO scale_license (organization_id, scale_type, license_holder, license_number,
           effective_date, expires_at, status, recorded_by_membership_id)
         VALUES ($1,'pps','Palliative Perf Scale','LIC-1', now()::date, now()::date + 365, 'active', $2)
         RETURNING id`,
          [org, membership],
        )
      ).rows[0].id as string;

      const scalePolicy = (
        await db.query(
          `INSERT INTO scale_policy (organization_id, scale_type, enabled, updated_by_membership_id)
         VALUES ($1,'pps', true, $2) RETURNING id`,
          [org, membership],
        )
      ).rows[0].id as string;

      const reassessmentDue = (
        await db.query(
          `INSERT INTO assessment_reassessment_due (organization_id, provider_entity_id, location_id, patient_id,
             scale_type, last_captured_at, cadence_days, due_at)
           VALUES ($1,$2,$3,gen_random_uuid(),'pps', now(), 15, now() + interval '15 days') RETURNING id`,
          [org, providerEntity, location],
        )
      ).rows[0].id as string;

      return {
        membership,
        providerEntity,
        location,
        clinicalAssessment,
        assessmentCosignature,
        significantChangeEvent,
        scaleLicense,
        scalePolicy,
        reassessmentDue,
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
      await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m9-actor@x.test')`, [USER]);
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

    it("every M9 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
      const rls = readFileSync(
        join(MIGRATIONS_DIR, "0033_assessment_m9_rls_audit_triggers.sql"),
        "utf8",
      );
      const policyBlocks = (rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? []).filter(
        (b) => COVERED.some((t) => b.includes(`"${t.table}"`)),
      );
      expect(policyBlocks.length).toBe(COVERED.length); // 5 org-scoped M9 tables, each with a direct `_org` policy
      for (const block of policyBlocks) {
        const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
        expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
        expect(block).not.toMatch(/pg_has_role/i);
        expect(block).not.toMatch(/IS NULL/i);
      }
    });

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

    it("a WITH CHECK refuses a clinical_assessment forged into another tenant", async () => {
      // clinical_assessment is the scored clinical record — a cross-tenant write would let one tenant
      // manufacture (or, via a returning read, disclose) another org's patient assessments.
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO clinical_assessment (organization_id, provider_entity_id, location_id, patient_id,
             admission_id, scale_type, scale_version, data, captured_at, captured_by_membership_id,
             captured_by_discipline)
           VALUES ($1,$2,$3,$4,$5,'pps','1.0','{"notes":"forged"}'::jsonb, now(), $6, 'RN')`,
            [ORG_A, a.providerEntity, a.location, PATIENT, ADMISSION, a.membership],
          ),
        ),
      ).rejects.toThrow();
    });

    it("org B cannot UPDATE org A's significant_change_event (the USING clause covers writes too)", async () => {
      const res = await withOrg(ORG_B, () =>
        db.query("UPDATE significant_change_event SET status='escalated' WHERE id=$1", [
          a.significantChangeEvent,
        ]),
      );
      expect(res.rowCount).toBe(0);
      const still = await db.query("SELECT status FROM significant_change_event WHERE id=$1", [
        a.significantChangeEvent,
      ]);
      expect(still.rows[0].status).toBe("open");
    });

    it("the M4 write-audit trigger fired for the clinical_assessment writes (§3.4)", async () => {
      const r = await db.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'clinical_assessment'",
      );
      expect(r.rows[0].n).toBeGreaterThan(0);
    });
  },
);
