/**
 * M38 Clinical Terminology Service — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / §3.7).
 *
 * M38 is almost entirely PLATFORM reference data: canonical code systems, concepts, value sets and
 * their expansions are shared across every tenant (read-all `USING (true)`, loader-only writes), so
 * they carry NO `organization_id` and NO tenant RLS to prove. Exactly ONE M38 table is tenant-pivoted:
 * `value_set_tenant_extension` — a hospice's local additions to a platform value set (§3.7). A wrong
 * predicate or missing WITH CHECK there would let one tenant read or forge another tenant's value-set
 * customizations, so that single table is the whole isolation surface worth a live DB.
 *
 * The 12 platform tables are EXCLUDED from the cross-tenant sweep BY DESIGN (each has no org column):
 *   code_system, code_system_version, concept_icd10cm, concept_snomed, concept_loinc, concept_rxnorm,
 *   value_set, value_set_member, value_set_expansion, deprecation_mapping, concept_embedding,
 *   terminology_update_log — canonical reference, visible to all orgs (0015 §2, `USING (true)`).
 *
 * M38 uses pgvector (`concept_embedding.embedding vector(384)`); the live cluster has pgvector, so this
 * runs as-is. The applyMigrations strip logic (kept verbatim from M6) only matters for a pgvector-less
 * local PG via CHARTWARDEN_TEST_NO_PGVECTOR=1.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m38` (SUPERUSER to a THROWAWAY
 *     db; for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropLiveRoles } from "../../../../apps/backend/__tests__/_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** `value_set_tenant_extension.added_by` carries a real FK to `user`; one seeded user covers it. */
const USER = "33333333-3333-3333-3333-333333333333";
/** The platform value set the tenant extension attaches to (FK parent, shared by both orgs). */
const VALUE_SET = "vs-m38-hospice-dx";

type SeedIds = {
  providerEntity: string;
  location: string;
  valueSetTenantExtension: string;
};

// Only tables with an `organization_id` column AND a tenant `app.org_id` RLS policy are covered.
// M38 has exactly one: value_set_tenant_extension. The 12 platform tables are platform-read
// (`USING (true)`), have no org column, and are deliberately NOT in this sweep (see file header).
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "value_set_tenant_extension", key: "valueSetTenantExtension" },
];

describe.skipIf(!DB_URL)("M38 Terminology — RLS cross-tenant denial — LIVE Postgres (§3.7)", () => {
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
    await dropLiveRoles(db);
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

  /** Seed one org-scoped M38 tenant-extension chain for `org` as superuser (RLS + grants bypassed). */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const providerEntity = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M38${n}`, `M38 Provider ${n}`, `NPI-M38${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M38${n}`],
      )
    ).rows[0].id as string;

    const valueSetTenantExtension = (
      await db.query(
        `INSERT INTO value_set_tenant_extension (value_set_id, organization_id, system_id, code, reason,
           added_by)
         VALUES ($1,$2,'icd10cm',$3,'local hospice addition',$4) RETURNING id`,
        [VALUE_SET, org, `Z51.${n}`, USER],
      )
    ).rows[0].id as string;

    return { providerEntity, location, valueSetTenantExtension };
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
    await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m38-actor@x.test')`, [USER]);
    // Platform FK parent for the tenant extension — a shared, non-tenant value set (§3.7).
    await db.query(
      `INSERT INTO value_set (id, name, scope) VALUES ($1,'M38 Hospice Dx','hospice')`,
      [VALUE_SET],
    );
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

  it("every M38 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    const rls = readFileSync(
      join(MIGRATIONS_DIR, "0015_terminology_m38_rls_audit_triggers.sql"),
      "utf8",
    );
    // Only the org-scoped table carries a WITH CHECK policy; the 12 platform policies are SELECT-only
    // `USING (true)` (and live inside a DO/format loop), so this matcher isolates the tenant surface.
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
      expect(seenByB.rows[0].n).toBe(0);
    },
  );

  it("a WITH CHECK refuses a tenant extension forged into another tenant", async () => {
    // value_set_tenant_extension is the ONLY tenant-pivoted M38 table — a cross-tenant write would let
    // one hospice inject value-set customizations under another org's identity.
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO value_set_tenant_extension (value_set_id, organization_id, system_id, code, reason,
             added_by)
           VALUES ($1,$2,'icd10cm','Z99.9','forged',$3)`,
          [VALUE_SET, ORG_A, USER],
        ),
      ),
    ).rejects.toThrow();
  });

  it("org B cannot UPDATE org A's tenant extension (the USING clause covers writes too)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE value_set_tenant_extension SET reason='hijacked' WHERE id=$1", [
        a.valueSetTenantExtension,
      ]),
    );
    expect(res.rowCount).toBe(0);
    const still = await db.query("SELECT reason FROM value_set_tenant_extension WHERE id=$1", [
      a.valueSetTenantExtension,
    ]);
    expect(still.rows[0].reason).toBe("local hospice addition");
  });

  it("the M4 write-audit trigger fired for the tenant-extension writes (§3.8)", async () => {
    // 0015 §5: the generated trigger emits resource_kind 'term_value_set_extension'.
    const r = await db.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'term_value_set_extension'",
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});
