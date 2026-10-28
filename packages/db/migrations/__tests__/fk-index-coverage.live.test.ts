/**
 * Foreign-key index coverage — the LIVE catalog proof (GAP-178).
 *
 * A foreign key whose referencing column(s) lead no index makes every DELETE/UPDATE of the parent row
 * scan the whole child table (and every `ON DELETE CASCADE` / `SET NULL` edge does the same per parent
 * row). 0480 indexed the 186 cascade/set-null/domain FKs that had none; this suite is what stops the
 * gap re-opening, by asking the CATALOG (`pg_constraint` x `pg_index`) of a freshly migrated database —
 * the one place the answer is exact, because a corpus parser has to reimplement DDL semantics
 * (DO blocks, DROP ... CASCADE, renames) and a Postgres-free gate cannot.
 *
 * THE RULE. Every FK on a non-partition `public` table must have a VALID index whose key starts with
 * the FK's columns (a PRIMARY KEY / UNIQUE constraint counts), EXCEPT a NO ACTION / RESTRICT FK whose
 * parent is one of {@link SOFT_DELETED_PARENTS}: the siting and actor stamps (`location_id`,
 * `provider_entity_id`, `*_user_id`, `*_membership_id`) carried by nearly every clinical row. Those
 * parents are soft-deleted, so the parent-delete scan an index would serve does not happen, and the
 * index would tax every INSERT on the highest-volume tables. A NEW FK to any other parent, or any
 * cascade / set-null FK at all, must ship with its index in the same migration.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:fk-indexes:live` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropLiveRoles } from "../../../../apps/backend/__tests__/_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");

/** Parents that are soft-deleted, never hard-deleted — see the header. */
const SOFT_DELETED_PARENTS: readonly string[] = [
  "location",
  "provider_entity",
  '"user"',
  "membership",
];
/** `pg_constraint.confdeltype`: a = NO ACTION, r = RESTRICT. */
const PASSIVE_DELETE_RULES = ["a", "r"];

const UNINDEXED_FK_SQL = `
WITH fks AS (
  SELECT c.conname, c.conrelid, c.conkey, c.confdeltype,
         c.conrelid::regclass::text AS tbl, c.confrelid::regclass::text AS reftbl
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = r.relnamespace
  WHERE c.contype = 'f' AND n.nspname = 'public' AND NOT r.relispartition AND c.conparentid = 0
)
SELECT f.tbl, f.conname, f.confdeltype, f.reftbl,
  (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
     FROM unnest(f.conkey) WITH ORDINALITY k(attnum, ord)
     JOIN pg_attribute a ON a.attrelid = f.conrelid AND a.attnum = k.attnum) AS cols
FROM fks f
WHERE NOT EXISTS (
  SELECT 1 FROM pg_index i
  WHERE i.indrelid = f.conrelid AND i.indisvalid
    AND (string_to_array(i.indkey::text, ' '))[1:cardinality(f.conkey)]
        = (SELECT array_agg(x::text) FROM unnest(f.conkey) x)
)
ORDER BY 1, 2`;

interface UnindexedFk {
  tbl: string;
  conname: string;
  confdeltype: string;
  reftbl: string;
  cols: string;
}

/** An unindexed FK the rule sanctions. */
function isSanctioned(fk: Pick<UnindexedFk, "confdeltype" | "reftbl">): boolean {
  return PASSIVE_DELETE_RULES.includes(fk.confdeltype) && SOFT_DELETED_PARENTS.includes(fk.reftbl);
}

describe("fk-index-coverage rule (pure)", () => {
  it("sanctions a NO ACTION FK to a soft-deleted parent", () => {
    expect(isSanctioned({ confdeltype: "a", reftbl: "location" })).toBe(true);
    expect(isSanctioned({ confdeltype: "r", reftbl: '"user"' })).toBe(true);
  });
  it("never sanctions a cascade / set-null edge, or any other parent", () => {
    expect(isSanctioned({ confdeltype: "c", reftbl: "location" })).toBe(false);
    expect(isSanctioned({ confdeltype: "n", reftbl: "membership" })).toBe(false);
    expect(isSanctioned({ confdeltype: "a", reftbl: "patient" })).toBe(false);
  });
});

describe.skipIf(!DB_URL)("FK index coverage — LIVE Postgres catalog (GAP-178)", () => {
  let db: Client;

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

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await resetSchema();
    await applyMigrations();
  }, 180_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  it("every cascade / set-null FK and every FK to a hard-deletable parent has a supporting index", async () => {
    const { rows } = await db.query<UnindexedFk>(UNINDEXED_FK_SQL);
    const offenders = rows.filter((fk) => !isSanctioned(fk));
    expect(
      offenders.map((fk) => `${fk.tbl}(${fk.cols}) -> ${fk.reftbl} [${fk.conname}]`),
      "add `CREATE INDEX IF NOT EXISTS … ON <table> (<fk columns>)` in a migration (see 0480)",
    ).toEqual([]);
  });

  it("the sanctioned-exception list is real: those FKs exist and are unindexed (so the rule is not vacuous)", async () => {
    const { rows } = await db.query<UnindexedFk>(UNINDEXED_FK_SQL);
    expect(rows.filter(isSanctioned).length).toBeGreaterThan(0);
  });
});
