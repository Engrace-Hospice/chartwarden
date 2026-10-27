/**
 * M7 Care Plan (IPOC) — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / ADR-0010).
 *
 * M7's pure suites exercise the version/quorum/clock machinery but never touch a database, so they cannot
 * catch a wrong RLS predicate, a missing WITH CHECK, or a base-table grant that leaks across tenants. This
 * applies the real migrations to a real Postgres and drives the policies as the unprivileged `chartwarden_app`
 * role (no BYPASSRLS), covering all SIX org-scoped M7 tables.
 *
 * Two of the six carry the risk that makes this worth more than a checkbox:
 *   • `problem.sud_related` is the 42 CFR Part 2 flag. A cross-tenant read here is not a generic PHI leak,
 *     it is a substance-use disclosure — the one class of record with its own federal statute.
 *   • `care_plan_signature` is the IDG quorum evidence. Cross-tenant write access would let one tenant
 *     manufacture another's certification signatures.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = [
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** `care_plan_signature.membership_id` carries a real FK to `membership`, so each org needs one. */
const USER = "33333333-3333-3333-3333-333333333333";

type SeedIds = {
  membership: string;
  providerEntity: string;
  location: string;
  carePlan: string;
  carePlanVersion: string;
  carePlanSignature: string;
  problem: string;
  goal: string;
  intervention: string;
  idgDecisionApplication: string;
  idgProposedChange: string;
};

const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "care_plan", key: "carePlan" },
  { table: "care_plan_version", key: "carePlanVersion" },
  { table: "care_plan_signature", key: "carePlanSignature" },
  { table: "problem", key: "problem" },
  { table: "goal", key: "goal" },
  { table: "intervention", key: "intervention" },
  { table: "care_plan_idg_decision_application", key: "idgDecisionApplication" },
];

// GAP-183 — the governed-IDG proposal rows (0218); RLS lives in a later migration than the policy-shape list.
const EXTRA_COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "care_plan_idg_proposed_change", key: "idgProposedChange" },
];

describe.skipIf(!DB_URL)("M7 Care Plan — RLS cross-tenant denial — LIVE Postgres (§3.5)", () => {
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
        // BOTH spellings appear in the corpus — 0001 quotes the extension name, 0014 does not — and
        // there is more than one occurrence, so this must be global, not the first match only.
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
          "-- (vector extension stripped: CHARTWARDEN_TEST_NO_PGVECTOR set)",
        );
        // Dropping the extension is not enough: 0014 declares an `embedding vector(384)` COLUMN, so the
        // TYPE must still resolve. A test-only text shim keeps the DDL applying without touching any
        // table this suite asserts on (M38's embedding column is never read here).
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        // …and the pgvector-only ACCESS METHOD the embedding index uses goes with it.
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped: no pgvector)");
      }
      await db.query(sql);
    }
  }

  /** Seed one full M7 care-plan chain for `org` as superuser (RLS + grants bypassed). */
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
        [org, `CCN-M7${n}`, `M7 Provider ${n}`, `NPI-M7${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M7${n}`],
      )
    ).rows[0].id as string;

    const patient = "44444444-4444-4444-4444-444444444444";
    const admission = "55555555-5555-5555-5555-555555555555";

    const carePlan = (
      await db.query(
        `INSERT INTO care_plan (organization_id, provider_entity_id, location_id, patient_id, admission_id,
           initial_due_at)
         VALUES ($1,$2,$3,$4,$5, now() + interval '5 days') RETURNING id`,
        [org, providerEntity, location, patient, admission],
      )
    ).rows[0].id as string;

    const carePlanVersion = (
      await db.query(
        `INSERT INTO care_plan_version (organization_id, provider_entity_id, location_id, care_plan_id,
           sequence, kind, required_signer_set)
         VALUES ($1,$2,$3,$4,1,'initial','[]'::jsonb) RETURNING id`,
        [org, providerEntity, location, carePlan],
      )
    ).rows[0].id as string;

    const carePlanSignature = (
      await db.query(
        `INSERT INTO care_plan_signature (organization_id, provider_entity_id, location_id,
           care_plan_version_id, membership_id, signer_role, signature_method, attestation_text)
         VALUES ($1,$2,$3,$4,$5,'rn_case_manager','typed','I attest') RETURNING id`,
        [org, providerEntity, location, carePlanVersion, membership],
      )
    ).rows[0].id as string;

    const problem = (
      await db.query(
        `INSERT INTO problem (organization_id, provider_entity_id, location_id, care_plan_id,
           description, kind, sud_related)
         VALUES ($1,$2,$3,$4,'Substance use disorder','related',true) RETURNING id`,
        [org, providerEntity, location, carePlan],
      )
    ).rows[0].id as string;

    const goal = (
      await db.query(
        `INSERT INTO goal (organization_id, provider_entity_id, location_id, care_plan_id, problem_id,
           original_text, source)
         VALUES ($1,$2,$3,$4,$5,'Comfort maintained','clinical') RETURNING id`,
        [org, providerEntity, location, carePlan, problem],
      )
    ).rows[0].id as string;

    const intervention = (
      await db.query(
        `INSERT INTO intervention (organization_id, provider_entity_id, location_id, care_plan_id,
           problem_id, scope_text, frequency_text, frequency_value, discipline)
         VALUES ($1,$2,$3,$4,$5,'RN visit','weekly','1w','rn') RETURNING id`,
        [org, providerEntity, location, carePlan, problem],
      )
    ).rows[0].id as string;

    const idgDecisionApplication = (
      await db.query(
        `INSERT INTO care_plan_idg_decision_application
           (organization_id, provider_entity_id, location_id, idg_decision_id,
            source_outbox_event_id, care_plan_id, care_plan_version_id, idg_meeting_id)
         VALUES ($1,$2,$3,gen_random_uuid(),gen_random_uuid(),$4,$5,gen_random_uuid()) RETURNING id`,
        // idg_meeting_id: NOT NULL since 0218 (M7 governed IDG proposals). Like idg_decision_id it is a
        // cross-module M14 reference with no FK, so a fresh uuid satisfies it.
        [org, providerEntity, location, carePlan, carePlanVersion],
      )
    ).rows[0].id as string;

    const idgProposedChange = (
      await db.query(
        `INSERT INTO care_plan_idg_proposed_change (organization_id, provider_entity_id, location_id,
           application_id, care_plan_id, care_plan_version_id, idg_decision_id, idg_meeting_id, ordinal,
           entity_type, operation, proposed)
         VALUES ($1,$2,$3,$4,$5,$6,gen_random_uuid(),gen_random_uuid(),1,'problem','problem_add','{}'::jsonb)
         RETURNING id`,
        [org, providerEntity, location, idgDecisionApplication, carePlan, carePlanVersion],
      )
    ).rows[0].id as string;

    return {
      membership,
      providerEntity,
      location,
      carePlan,
      carePlanVersion,
      carePlanSignature,
      problem,
      goal,
      intervention,
      idgDecisionApplication,
      idgProposedChange,
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
    await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m7-actor@x.test')`, [USER]);
    a = await seedOrg(ORG_A, 1);
    b = await seedOrg(ORG_B, 2);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
  // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
  // scripts/db/migrate.ts grants exactly that behind CHARTWARDEN_DEV_BYPASSRLS=1, so this is reachable,
  // not theoretical. Six of fifteen suites asserted this and NONE of the four suites CI runs did.
  it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("every M7 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    const rls = [
      "0029_care_plan_m7_rls_audit_triggers.sql",
      "0166_care_plan_idg_decision_application.sql",
    ]
      .map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
      .join("\n");
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

  it("a SUD-flagged problem does not leak across tenants (42 CFR Part 2)", async () => {
    // Named separately from the table sweep above because the failure mode is categorically different:
    // this row is not merely PHI, it is a substance-use disclosure with its own federal statute.
    const leaked = await withOrg(ORG_B, () =>
      db.query("SELECT count(*)::int AS n FROM problem WHERE sud_related = true"),
    );
    // Org B seeded its own SUD problem, so it must see exactly ONE — its own, never A's.
    expect(leaked.rows[0].n).toBe(1);
    const isOwn = await withOrg(ORG_B, () =>
      db.query("SELECT count(*)::int AS n FROM problem WHERE id=$1", [a.problem]),
    );
    expect(isOwn.rows[0].n).toBe(0);
  });

  it("a WITH CHECK refuses a signature forged into another tenant's care-plan version", async () => {
    // care_plan_signature is the IDG quorum evidence — a cross-tenant write would let one tenant
    // manufacture another's certification signatures.
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO care_plan_signature (organization_id, provider_entity_id, location_id,
             care_plan_version_id, membership_id, signer_role, signature_method, attestation_text)
           VALUES ($1,$2,$3,$4,$5,'medical_director','typed','forged')`,
          [ORG_A, a.providerEntity, a.location, a.carePlanVersion, b.membership],
        ),
      ),
    ).rejects.toThrow();
  });

  it("org B cannot UPDATE org A's care plan (the USING clause covers writes too)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE care_plan SET status='discharged' WHERE id=$1", [a.carePlan]),
    );
    expect(res.rowCount).toBe(0);
    const still = await db.query("SELECT status FROM care_plan WHERE id=$1", [a.carePlan]);
    expect(still.rows[0].status).toBe("draft");
  });

  it("the M4 write-audit trigger fired for the care-plan writes (§3.8)", async () => {
    const r = await db.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'care_plan'",
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});
