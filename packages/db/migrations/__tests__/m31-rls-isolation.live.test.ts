/**
 * M31 Patient/Family Portal & Telehealth — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / ADR-0010).
 *
 * M31's pure suites exercise the session/grant/telehealth state machines but never touch a database, so they
 * cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table grant that leaks across tenants.
 * This applies the real migrations to a real Postgres and drives the policies as the unprivileged `wardenx_app`
 * role (no BYPASSRLS), covering all THREE manifest-owned M31 tables (§3.3):
 *   • `portal_account`      — D2's account root; a cross-tenant read exposes another org's caregiver directory.
 *   • `portal_access_grant` — D5/D6/D7's per-patient authorization (carries patient_id) — a cross-tenant write
 *     forges portal access into another org's chart.
 *   • `telehealth_visit`    — D8/D14's video-visit root (carries patient_id + vendor room ciphers).
 *
 * All three key their RLS predicate on app.org_id ALONE (set by withOrgContext), with FORCE ROW LEVEL SECURITY
 * closing the owner-bypass hole. The cipher columns are §3.6 audit-denylisted (asserted indirectly: the audit
 * trigger fires).
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set WARDENX_TEST_NO_PGVECTOR=1).
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
/** portal_account.user_id FKs `user`; the single seeded user satisfies both orgs (the active-account unique
 * index keys on (organization_id, user_id, relationship), so the same user in two orgs never collides).
 * patient_id / *_membership_id / source_consent_record_id / m17_visit_id carry NO FK — literals are fine. */
const USER = "33333333-3333-3333-3333-333333333333";
const MEMBERSHIP = "44444444-4444-4444-4444-444444444444";
const PATIENT = "55555555-5555-5555-5555-555555555555";
const CONSENT = "66666666-6666-6666-6666-666666666666";
/** telehealth_visit.m17_visit_id carries a GLOBAL unique index, so org A and org B must use distinct values. */
const M17_VISIT_A = "77777777-7777-7777-7777-777777777771";
const M17_VISIT_B = "77777777-7777-7777-7777-777777777772";

type SeedIds = {
  providerEntity: string;
  location: string;
  portalAccount: string;
  portalAccessGrant: string;
  telehealthVisit: string;
};

/** The THREE manifest-owned org-scoped M31 tables (ADR-0005: the spec §2.1 ERD's other entities never
 * materialize as M31 tables). All three carry a direct `_org` WITH CHECK policy. */
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "portal_account", key: "portalAccount" },
  { table: "portal_access_grant", key: "portalAccessGrant" },
  { table: "telehealth_visit", key: "telehealthVisit" },
];

describe.skipIf(!DB_URL)(
  "M31 Portal & Telehealth — RLS cross-tenant denial — LIVE Postgres (§3.5)",
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

    /** Seed one full M31 portal/telehealth chain for `org` as superuser (RLS + grants bypassed). */
    async function seedOrg(org: string, n: number, m17Visit: string): Promise<SeedIds> {
      const providerEntity = (
        await db.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [org, `CCN-M31${n}`, `M31 Provider ${n}`, `NPI-M31${n}`],
        )
      ).rows[0].id as string;

      const location = (
        await db.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerEntity, `Loc-M31${n}`],
        )
      ).rows[0].id as string;

      const portalAccount = (
        await db.query(
          `INSERT INTO portal_account (organization_id, user_id, relationship, display_name_cipher, email_cipher)
         VALUES ($1,$2,'family_caregiver','enc-name','enc-email') RETURNING id`,
          [org, USER],
        )
      ).rows[0].id as string;

      const portalAccessGrant = (
        await db.query(
          `INSERT INTO portal_access_grant (organization_id, provider_entity_id, location_id, portal_account_id,
           patient_id, grant_kind, scope_set_jsonb, source_consent_record_id, source_consent_version,
           granted_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,'family_caregiver','{}'::jsonb,$6,'v1',$7) RETURNING id`,
          [org, providerEntity, location, portalAccount, PATIENT, CONSENT, MEMBERSHIP],
        )
      ).rows[0].id as string;

      const telehealthVisit = (
        await db.query(
          `INSERT INTO telehealth_visit (organization_id, provider_entity_id, location_id, m17_visit_id,
           patient_id, assigned_membership_id, vendor, vendor_room_id_cipher, vendor_room_url_cipher,
           scheduled_visit_setting)
         VALUES ($1,$2,$3,$4,$5,$6,'daily_co','enc-room','enc-url','patient_home') RETURNING id`,
          [org, providerEntity, location, m17Visit, PATIENT, MEMBERSHIP],
        )
      ).rows[0].id as string;

      return { providerEntity, location, portalAccount, portalAccessGrant, telehealthVisit };
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
      await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m31-actor@x.test')`, [USER]);

      a = await seedOrg(ORG_A, 1, M17_VISIT_A);
      b = await seedOrg(ORG_B, 2, M17_VISIT_B);
    }, 120_000);

    afterAll(async () => {
      if (db) await db.end();
    });

    // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime role ever
    // gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green. scripts/db/migrate.ts
    // grants exactly that behind WARDENX_DEV_BYPASSRLS=1, so this is reachable.
    it("wardenx_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
      const { rows } = await db.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'wardenx_app'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolbypassrls).toBe(false);
    });

    it("every M31 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
      const rls = readFileSync(
        join(MIGRATIONS_DIR, "0139_portal_m31_rls_audit_triggers.sql"),
        "utf8",
      );
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

    it("a WITH CHECK refuses a portal_access_grant forged into another tenant", async () => {
      // portal_access_grant carries patient_id — a cross-tenant write would let one tenant plant portal access
      // into another org's chart. The WITH CHECK must reject an organization_id that isn't the session's org.
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO portal_access_grant (organization_id, provider_entity_id, location_id, portal_account_id,
             patient_id, grant_kind, scope_set_jsonb, source_consent_record_id, source_consent_version,
             granted_by_membership_id)
           VALUES ($1,$2,$3,$4,$5,'family_caregiver','{}'::jsonb,$6,'v1',$7)`,
            [ORG_A, a.providerEntity, a.location, a.portalAccount, PATIENT, CONSENT, MEMBERSHIP],
          ),
        ),
      ).rejects.toThrow();
    });

    it("org B cannot UPDATE org A's telehealth_visit (the USING clause covers writes too)", async () => {
      const res = await withOrg(ORG_B, () =>
        db.query("UPDATE telehealth_visit SET audio_only_fallback_active=true WHERE id=$1", [
          a.telehealthVisit,
        ]),
      );
      expect(res.rowCount).toBe(0);
      const still = await db.query(
        "SELECT audio_only_fallback_active FROM telehealth_visit WHERE id=$1",
        [a.telehealthVisit],
      );
      expect(still.rows[0].audio_only_fallback_active).toBe(false);
    });

    it("the M4 write-audit trigger fired for the portal writes (§3.6/§3.8)", async () => {
      const r = await db.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind IN ('portal_account','portal_access_grant','telehealth_visit')",
      );
      expect(r.rows[0].n).toBeGreaterThan(0);
    });

    // #117 / migration 0224 — the suspend/reinstate reason the API demanded and discarded now lands here.
    // `check-audit-denylist-sync` proves the CONSTANT and the SQL agree; only an executed trigger proves the
    // scrub actually happens, and 0224 replaces a function 0139 defined, so this also proves the replacement
    // took (a CREATE OR REPLACE that silently missed would leave the old three-column array in place).
    it("a status-change reason is stored on the row and SCRUBBED from the audit trail (0224)", async () => {
      const sealed = "v1.k1.NONCE.TAG.SEALEDBLOB";
      const res = await withOrg(ORG_A, () =>
        db.query(
          "UPDATE portal_account SET status='suspended', suspended_at=now(), status_change_reason_cipher=$2 WHERE id=$1",
          [a.portalAccount, sealed],
        ),
      );
      expect(res.rowCount).toBe(1);

      // On the row: the sealed reason is there to be read back by whoever can open it.
      const row = await db.query(
        "SELECT status, status_change_reason_cipher FROM portal_account WHERE id=$1",
        [a.portalAccount],
      );
      expect(row.rows[0].status).toBe("suspended");
      expect(row.rows[0].status_change_reason_cipher).toBe(sealed);

      // In the audit trail: the STATUS transition is visible, the reason's ciphertext is not — the same
      // posture as the three contact ciphers. The audit records that a reason was given, not what it said.
      const ev = await db.query(
        `SELECT after->>'status' AS status, after->>'status_change_reason_cipher' AS reason
           FROM audit_event
          WHERE resource_kind='portal_account' AND resource_id=$1 AND event_type='portal_account.update'
          ORDER BY created_at DESC LIMIT 1`,
        [a.portalAccount],
      );
      expect(ev.rows[0].status).toBe("suspended");
      expect(ev.rows[0].reason).toBe("<changed>");
      expect(ev.rows[0].reason).not.toContain("SEALEDBLOB");
    });
  },
);
