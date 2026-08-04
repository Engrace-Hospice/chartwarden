/**
 * M40 Master Data Management — RLS cross-tenant denial: the LIVE Postgres proof (§3.6 / 0019).
 *
 * M40 is a DELIBERATE MIX of platform master data and org-scoped tenant records, and that mix is the
 * whole point of this suite. Of the eleven manifest-owned tables only FOUR are org-scoped and carry a
 * tenant `app.org_id` RLS policy — the other seven are canonical/global directory data (public read,
 * `USING (true)`) or platform-ops surfaces (wardenx_admin only, no tenant policy at all). A suite that
 * swept all eleven would assert cross-tenant *denial* against tables that are supposed to be *shared*,
 * and pass for the wrong reason. So COVERED is exactly the four org-scoped tables; every excluded table
 * is listed below with the reason it is NOT tenant-isolated.
 *
 * EXCLUDED (not org-scoped — no organization_id, no `_org` tenant policy; §3.6 0019):
 *   • external_physician  — CANONICAL directory row. Public read to every tenant (USING (true));
 *                           writable only via mdm_canonical_writer. Shared, not isolated.
 *   • facility            — CANONICAL. Same posture as external_physician.
 *   • payer               — CANONICAL. Same posture as external_physician.
 *   • entity_relationship — canonical-SHAPE cross-cutting graph (org-less): public read, mdm_canonical_writer writes.
 *   • merge_request       — PLATFORM-OPS surface, wardenx_admin only. No wardenx_app grant at all.
 *   • nppes_sync_log      — PLATFORM-OPERATIONAL log, wardenx_admin only. No wardenx_app grant.
 *   • nppes_sync_coordination — PLATFORM-OPERATIONAL singleton (INTEGER PK), wardenx_admin only. No wardenx_app grant.
 * None of the eleven are partitioned, so there is no partition-leaf caveat here.
 *
 * The four COVERED tables are where a tenant's PRIVATE data lives: the overlay carries a tenant's own
 * do-not-refer flags / commercial contract terms for a physician; mdm_baa_record is the tenant's HIPAA
 * Business Associate Agreement register (§7.7). A cross-tenant read of either is a real disclosure, and
 * a cross-tenant write of a BAA row would let one org forge another's compliance posture.
 *
 * This applies the real migrations to a real Postgres and drives the policies as the unprivileged
 * `wardenx_app` role (no BYPASSRLS). Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m40` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set WARDENX_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "mdm_canonical_writer",
];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** `external_physician_tenant_overlay.created_by` and `mdm_provisional.proposed_by` carry real FKs to
 * `user`, so a single seeded user is enough for every user reference in the chain. */
const USER = "33333333-3333-3333-3333-333333333333";

type SeedIds = {
  providerEntity: string;
  location: string;
  /** CANONICAL (org-less) FK parent for the overlay — seeded per org but globally shared. */
  externalPhysician: string;
  physicianOverlay: string;
  mdmProvisional: string;
  mdmBaaRecord: string;
  mdmBaaRequired: string;
};

const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "external_physician_tenant_overlay", key: "physicianOverlay" },
  { table: "mdm_provisional", key: "mdmProvisional" },
  { table: "mdm_baa_record", key: "mdmBaaRecord" },
  { table: "mdm_baa_required", key: "mdmBaaRequired" },
];

describe.skipIf(!DB_URL)(
  "M40 Master Data Management — RLS cross-tenant denial — LIVE Postgres (§3.6)",
  () => {
    let db: Client;
    let a: SeedIds;
    let b: SeedIds;

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
          sql = sql.replace(
            /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
            "-- (vector extension stripped: WARDENX_TEST_NO_PGVECTOR set)",
          );
          sql = sql.replace(/\bvector\(\d+\)/g, "text");
          sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped: no pgvector)");
        }
        await db.query(sql);
      }
    }

    /** Seed one full M40 org-scoped chain for `org` as superuser (RLS + grants bypassed). The canonical
     * external_physician parent is seeded here too (org-less, but the overlay FK needs a real id). */
    async function seedOrg(org: string, n: number): Promise<SeedIds> {
      const providerEntity = (
        await db.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [org, `CCN-M40${n}`, `M40 Provider ${n}`, `NPI-M40${n}`],
        )
      ).rows[0].id as string;

      const location = (
        await db.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerEntity, `Loc-M40${n}`],
        )
      ).rows[0].id as string;

      // CANONICAL directory row (org-LESS) — the shared FK parent for the overlay. npi NULL to avoid the
      // partial unique index; first/last name are the only NOT NULLs.
      const externalPhysician = (
        await db.query(
          `INSERT INTO external_physician (first_name, last_name) VALUES ($1,$2) RETURNING id`,
          [`Gregory${n}`, `House${n}`],
        )
      ).rows[0].id as string;

      const physicianOverlay = (
        await db.query(
          `INSERT INTO external_physician_tenant_overlay (external_physician_id, organization_id,
           relationship_notes, do_not_refer, created_by)
         VALUES ($1,$2,'preferred for cardiology', false, $3) RETURNING id`,
          [externalPhysician, org, USER],
        )
      ).rows[0].id as string;

      const mdmProvisional = (
        await db.query(
          `INSERT INTO mdm_provisional (organization_id, entity_kind, proposed_fields, proposed_by, reason)
         VALUES ($1,'physician','{"lastName":"Provisional"}'::jsonb,$2,'referral intake') RETURNING id`,
          [org, USER],
        )
      ).rows[0].id as string;

      const mdmBaaRecord = (
        await db.query(
          `INSERT INTO mdm_baa_record (organization_id, entity_kind, canonical_id, baa_status, executed_on)
         VALUES ($1,'physician',$2,'executed', now()::date) RETURNING id`,
          [org, externalPhysician],
        )
      ).rows[0].id as string;

      const mdmBaaRequired = (
        await db.query(
          `INSERT INTO mdm_baa_required (organization_id, kind, required)
         VALUES ($1,'physician', true) RETURNING id`,
          [org],
        )
      ).rows[0].id as string;

      return {
        providerEntity,
        location,
        externalPhysician,
        physicianOverlay,
        mdmProvisional,
        mdmBaaRecord,
        mdmBaaRequired,
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
      await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m40-actor@x.test')`, [USER]);
      a = await seedOrg(ORG_A, 1);
      b = await seedOrg(ORG_B, 2);
    }, 120_000);

    afterAll(async () => {
      if (db) await db.end();
    });

    // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
    // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
    // scripts/db/migrate.ts grants exactly that behind WARDENX_DEV_BYPASSRLS=1, so this is reachable.
    it("wardenx_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
      const { rows } = await db.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'wardenx_app'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolbypassrls).toBe(false);
    });

    it("every M40 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
      const rls = readFileSync(join(MIGRATIONS_DIR, "0019_mdm_m40_rls_audit_triggers.sql"), "utf8");
      // Only the four org-scoped tables declare a WITH CHECK policy; the canonical `USING (true)` read
      // policies and the platform-ops (admin-only, no-policy) tables carry NO WITH CHECK, so this filters
      // to exactly the COVERED set.
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

    it("a WITH CHECK refuses a BAA record forged into another tenant's register", async () => {
      // mdm_baa_record is the tenant's HIPAA Business Associate Agreement register (§7.7) — a cross-tenant
      // write would let one org manufacture another's compliance posture. Use org B's canonical physician
      // so it is the WITH CHECK (org mismatch), not the (org,kind,canonical) unique index, that rejects.
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO mdm_baa_record (organization_id, entity_kind, canonical_id, baa_status)
           VALUES ($1,'physician',$2,'executed')`,
            [ORG_A, b.externalPhysician],
          ),
        ),
      ).rejects.toThrow();
    });

    it("org B cannot UPDATE org A's overlay (the USING clause covers writes too)", async () => {
      const res = await withOrg(ORG_B, () =>
        db.query("UPDATE external_physician_tenant_overlay SET do_not_refer=true WHERE id=$1", [
          a.physicianOverlay,
        ]),
      );
      expect(res.rowCount).toBe(0);
      const still = await db.query(
        "SELECT do_not_refer FROM external_physician_tenant_overlay WHERE id=$1",
        [a.physicianOverlay],
      );
      expect(still.rows[0].do_not_refer).toBe(false);
    });

    it("the M4 write-audit trigger fired for the overlay writes (§3.7)", async () => {
      // resource_kind is 'physician_overlay' (the M4 generator's label), NOT the table name.
      const r = await db.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'physician_overlay'",
      );
      expect(r.rows[0].n).toBeGreaterThan(0);
    });
  },
);
