/**
 * M4 Audit & Compliance Log — RLS cross-tenant denial: the LIVE Postgres proof (§3.6 / ADR-0010).
 *
 * The shared `rls-isolation.live.test.ts` already proves M4's MACHINERY live — that `audit_event` is
 * append-only to `wardenx_app`, and that the write-audit trigger fires and scrubs for M36/M38/M40 writes.
 * What it never touched is M4's OWN tables. That is the gap this closes, and it is the one that matters
 * most for M4 specifically: `legal_hold` and `destruction_certificate` are the tables that GATE
 * destruction. A tenant that could read or write another tenant's legal hold could suppress or force a
 * destruction it has no authority over, and no unit test can catch a wrong RLS predicate or a missing
 * WITH CHECK — only a real Postgres running as the unprivileged `wardenx_app` role can.
 *
 * Two shapes are covered, because M4 owns both:
 *   • ORG-SCOPED (4): legal_hold, destruction_certificate, audit_export, audit_seal — canonical
 *     `organization_id = current_setting('app.org_id')` policies.
 *   • PLATFORM-REFERENCE (3): state_retention_override, audit_denylist_catalog, audit_action_catalog —
 *     no organization_id at all, SELECT-only to `wardenx_app`. The risk here is the inverse: these must be
 *     readable by EVERY tenant (a denylist a tenant cannot read is a denylist that does not scrub) and
 *     writable by NONE.
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
/** The `*_by` columns (applied_by / executed_by / requested_by) carry real FKs to `user`. */
const ACTOR = "33333333-3333-3333-3333-333333333333";

type SeedIds = {
  legalHold: string;
  destructionCertificate: string;
  auditExport: string;
  auditSeal: string;
};

const ORG_SCOPED: { table: string; key: keyof SeedIds }[] = [
  { table: "legal_hold", key: "legalHold" },
  { table: "destruction_certificate", key: "destructionCertificate" },
  { table: "audit_export", key: "auditExport" },
  { table: "audit_seal", key: "auditSeal" },
];

/** The three platform-reference tables: no organization_id, SELECT-only to the app role. */
const PLATFORM_REFERENCE = [
  "state_retention_override",
  "audit_denylist_catalog",
  "audit_action_catalog",
];

describe.skipIf(!DB_URL)("M4 Audit — RLS cross-tenant denial — LIVE Postgres (§3.6)", () => {
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
        // BOTH spellings appear in the corpus — 0001 quotes the extension name, 0014 does not — and
        // there is more than one occurrence, so this must be global, not the first match only.
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
          "-- (vector extension stripped: WARDENX_TEST_NO_PGVECTOR set)",
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

  /** Seed one row in each org-scoped M4 table for `org`, as superuser (RLS + grants bypassed). */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const legalHold = (
      await db.query(
        `INSERT INTO legal_hold (organization_id, name, criteria, reason, applied_by)
         VALUES ($1,$2,'{"patientIds":[]}'::jsonb,'litigation hold',$3) RETURNING id`,
        [org, `Hold-${n}`, ACTOR],
      )
    ).rows[0].id as string;

    const destructionCertificate = (
      await db.query(
        `INSERT INTO destruction_certificate (organization_id, data_class, record_count,
           date_range_start, date_range_end, method, approved_by)
         VALUES ($1,'clinical_record',10,now() - interval '10 years',now() - interval '9 years',
                 'crypto_erase',$2) RETURNING id`,
        [org, ACTOR],
      )
    ).rows[0].id as string;

    const auditExport = (
      await db.query(
        `INSERT INTO audit_export (organization_id, requested_by, scope, format, expires_at)
         VALUES ($1,$2,'{"from":"2026-01-01"}'::jsonb,'csv', now() + interval '30 days') RETURNING id`,
        [org, ACTOR],
      )
    ).rows[0].id as string;

    const auditSeal = (
      await db.query(
        `INSERT INTO audit_seal (organization_id, partition, from_id, to_id, event_count, chain_hash)
         VALUES ($1,$2,gen_random_uuid(),gen_random_uuid(),100,repeat('a',64)) RETURNING id`,
        [org, `audit_event_2026_0${n}`],
      )
    ).rows[0].id as string;

    return { legalHold, destructionCertificate, auditExport, auditSeal };
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
    await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m4-actor@x.test')`, [ACTOR]);
    a = await seedOrg(ORG_A, 1);
    await seedOrg(ORG_B, 2);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
  // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
  // scripts/db/migrate.ts grants exactly that behind WARDENX_DEV_BYPASSRLS=1, so this is reachable,
  // not theoretical. Six of fifteen suites asserted this and NONE of the four suites CI runs did.
  it("wardenx_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'wardenx_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("every M4 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    const rls = readFileSync(join(MIGRATIONS_DIR, "0012_audit_m4_rls_grants.sql"), "utf8");
    const policyBlocks = (rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? []).filter(
      (b) => ORG_SCOPED.some((t) => b.includes(`"${t.table}"`)),
    );
    expect(policyBlocks.length).toBe(ORG_SCOPED.length);
    for (const block of policyBlocks) {
      const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
      expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
      expect(block).not.toMatch(/pg_has_role/i);
      expect(block).not.toMatch(/IS NULL/i);
    }
  });

  it.each(ORG_SCOPED)(
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

  it("a WITH CHECK refuses a legal hold written into another tenant's scope", async () => {
    // The sharpest M4 case: a legal hold is what SUSPENDS destruction. If B could write one scoped to A,
    // it could freeze — or, by the same hole, release — a retention obligation that is not its own.
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO legal_hold (organization_id, name, criteria, reason, applied_by)
           VALUES ($1,'cross-tenant','{}'::jsonb,'should be refused',$2)`,
          [ORG_A, ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it("org B cannot UPDATE org A's destruction certificate (the USING clause covers writes too)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE destruction_certificate SET method='overwrite' WHERE id=$1", [
        a.destructionCertificate,
      ]),
    );
    // RLS makes the row invisible, so the UPDATE matches nothing rather than erroring — the row must be
    // untouched either way.
    expect(res.rowCount).toBe(0);
    const still = await db.query("SELECT method FROM destruction_certificate WHERE id=$1", [
      a.destructionCertificate,
    ]);
    expect(still.rows[0].method).toBe("crypto_erase");
  });

  it.each(PLATFORM_REFERENCE)(
    "%s is platform reference — readable under EVERY tenant context",
    async (table) => {
      // A denylist or action catalog a tenant cannot read is one that silently stops scrubbing.
      const underA = await withOrg(ORG_A, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table}`),
      );
      const underB = await withOrg(ORG_B, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table}`),
      );
      // Identical row counts under either tenant is the property: a platform-reference table must not
      // vary by tenant. NOT asserted non-empty — only `state_retention_override` is seeded by the
      // migrations (0012); the two catalogs are populated by the M4 catalog refresh at boot, so an
      // empty count here is expected and is not what this test is about.
      expect(underA.rows[0].n).toBe(underB.rows[0].n);
    },
  );

  it.each(PLATFORM_REFERENCE)(
    "%s is NOT writable by the app role (SELECT-only grant)",
    async (table) => {
      await expect(withOrg(ORG_A, () => db.query(`DELETE FROM ${table}`))).rejects.toThrow(
        /permission denied/i,
      );
    },
  );

  it("the seeded state retention overrides are visible to a tenant (the §24.4 lookup works live)", async () => {
    const r = await withOrg(ORG_A, () =>
      db.query(
        "SELECT retention_spec FROM state_retention_override WHERE state_code='OR' AND data_class='clinical_record'",
      ),
    );
    expect(r.rows[0]?.retention_spec).toBe("7y");
  });
});
