/**
 * SECURITY DEFINER functions — the LIVE catalog proof that a caller-created temp object cannot shadow what they name.
 *
 * THE DEFECT. The per-table write-audit trigger functions (`audit_phi_write_<table>`, ~264 migrations of them) were
 * generated with `SET search_path = pg_catalog, public`, and about eighty other definers (membership picker, invitation
 * lookup, mdm / nppes / terminology / report writers, partition maintenance) carried the same or a similar form. That leaves
 * `pg_temp` out of the path, and Postgres then searches the session's temp schema FIRST for relations and types. A role that
 * may create temporary tables could make one named `audit_event`, so the definer function wrote its audit row into that temp
 * table (or failed on it) instead of the append-only log. 1486's support-session close function already ended in pg_temp
 * (1487 re-created the two support-session audit triggers without it); this suite is what keeps every definer from drifting back.
 *
 * THE RULE. Every SECURITY DEFINER function outside the system schemas (extension members excepted) has `pg_temp` as the LAST
 * element of its `search_path`. A trigger the generator emits works under a temp `audit_event` shadow and still writes the
 * real log.
 *
 * THE PREMISE. `public` before `pg_temp` is acceptable only while no caller can create objects in `public`. This suite
 * rebuilds its own database with `DROP SCHEMA public CASCADE; CREATE SCHEMA public`, which carries no PUBLIC grant whatever the
 * cluster's ACL is, so it cannot answer for a deployed cluster. It asserts the initdb default of the image instead
 * (`template1`), and the migration WARNs when a deployed cluster still grants CREATE to PUBLIC. That is the case for a cluster
 * upgraded from PostgreSQL 14 or older, and it is an operator check:
 * `SELECT nspacl FROM pg_namespace WHERE nspname = 'public'`.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:definer:search-path:live` (SUPERUSER to a
 *     THROWAWAY db; a private `chartwarden-postgres:dev` container, never the shared cluster).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { generateAuditTrigger } from "@chartwarden/audit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");

/** Every SECURITY DEFINER function a migration created: the system schemas and extension members are not ours. */
const DEFINERS_SQL = `
SELECT p.oid::regprocedure::text AS fn,
       p.prosrc ILIKE '%audit_event%' AS writes_audit,
       (SELECT c FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') AS search_path
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.prosecdef
   AND n.nspname <> 'information_schema'
   AND n.nspname NOT LIKE 'pg\\_%'
   AND NOT EXISTS (
     SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
   )
 ORDER BY 1`;

/** The elements of a `search_path=a, b, c` setting, or null when the function has none. */
function searchPathElements(setting: string | null): string[] | null {
  if (!setting) return null;
  return setting
    .replace(/^search_path=/, "")
    .split(",")
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter((part) => part.length > 0);
}

/** Whether a function's search_path puts `pg_temp` explicitly last, so a temp object can never shadow a name. */
function hasTempLast(setting: string | null): boolean {
  const elements = searchPathElements(setting);
  return elements !== null && elements[elements.length - 1] === "pg_temp";
}

describe("search_path rule (pure)", () => {
  it("accepts pg_temp last and nothing else", () => {
    expect(hasTempLast("search_path=pg_catalog, public, pg_temp")).toBe(true);
    expect(hasTempLast("search_path=pg_catalog, pg_temp")).toBe(true);
    expect(hasTempLast("search_path=pg_catalog, public")).toBe(false);
    expect(hasTempLast("search_path=pg_temp, pg_catalog, public")).toBe(false);
    expect(hasTempLast("search_path=pg_catalog, public, pg_temp, extra")).toBe(false);
    expect(hasTempLast(null)).toBe(false);
  });
});

describe.skipIf(!DB_URL)("SECURITY DEFINER functions — LIVE Postgres catalog", () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await resetPublicSchema(db);
    await dropLiveRoles(db);
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
  }, 240_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  it("every SECURITY DEFINER function has pg_temp last on its search_path", async () => {
    const { rows } = await db.query<{
      fn: string;
      writes_audit: boolean;
      search_path: string | null;
    }>(DEFINERS_SQL);
    // The rule is not vacuous: hundreds of generated audit triggers and dozens of hand-written definers exist.
    expect(rows.filter((r) => r.writes_audit).length).toBeGreaterThan(100);
    expect(rows.filter((r) => !r.writes_audit).length).toBeGreaterThan(20);
    const offenders = rows.filter((r) => !hasTempLast(r.search_path));
    expect(
      offenders.map((r) => `${r.fn} [${r.search_path ?? "no search_path"}]`),
      "SET search_path = <existing path>, pg_temp (pg_catalog, public, pg_temp; or pg_catalog, pg_temp with qualified names), as 1486 does",
    ).toEqual([]);
  });

  it("a freshly initialised cluster grants PUBLIC no CREATE on public, the premise for public before pg_temp", async () => {
    // `template1` keeps the schema exactly as initdb made it; this suite's own database is rebuilt without any PUBLIC grant.
    const url = new URL(DB_URL as string);
    url.pathname = "/template1";
    const template = new Client({ connectionString: url.toString() });
    await template.connect();
    try {
      const { rows } = await template.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pg_namespace ns,
                LATERAL aclexplode(coalesce(ns.nspacl, acldefault('n', ns.nspowner))) a
          WHERE ns.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE'`,
      );
      expect(rows[0]?.n).toBe(0);
    } finally {
      await template.end();
    }
  });

  it("a trigger the generator emits still writes the real log while a temp audit_event shadows the name", async () => {
    const table = "zz_search_path_probe";
    await db.query(
      // organization_id stays NULL: the real log keys it to organization, and the probe needs no tenant.
      `CREATE TABLE public.${table} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, note text)`,
    );
    for (const statement of generateAuditTrigger({ table, resourceKind: table }).split(
      "--> statement-breakpoint",
    )) {
      await db.query(statement);
    }
    try {
      // The trap: a temp table with the log's name, in this very session, created before the write.
      await db.query("CREATE TEMP TABLE audit_event (LIKE public.audit_event INCLUDING DEFAULTS)");
      await db.query(`INSERT INTO public.${table} (note) VALUES ('probe')`);
      const real = await db.query(
        "SELECT count(*)::int AS n FROM public.audit_event WHERE resource_kind = $1",
        [table],
      );
      const trapped = await db.query("SELECT count(*)::int AS n FROM pg_temp.audit_event");
      expect(real.rows[0]?.n).toBe(1);
      expect(trapped.rows[0]?.n).toBe(0);
    } finally {
      await db.query("DROP TABLE IF EXISTS pg_temp.audit_event");
      await db.query(`DROP TABLE IF EXISTS public.${table} CASCADE`);
    }
  });
});
