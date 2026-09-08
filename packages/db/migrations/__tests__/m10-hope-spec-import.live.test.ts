import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importHopeSpec } from "../../../../scripts/db/import-hope-spec";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

describe.skipIf(!DB_URL)("M10 HOPE spec import — LIVE Postgres", () => {
  let db: Client;

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
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- vector stripped");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- hnsw stripped");
      }
      await db.query(sql);
    }
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await resetSchema();
    await applyMigrations();
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  it("imports CMS HOPE v1.00.1 idempotently", async () => {
    const first = await importHopeSpec({ databaseUrl: DB_URL });
    const second = await importHopeSpec({ databaseUrl: DB_URL });
    expect(second).toEqual(first);
    expect(first.items).toBe(194);
    expect(first.options).toBe(554);
    expect(first.iscRows).toBe(776);
  });

  it("materializes official HA/HUV/HD assessment section counts", async () => {
    const { rows } = await db.query<{ isc: string; section_label: string; n: string }>(
      `SELECT isi.isc, i.section_label, count(*)::text AS n
       FROM hope_spec_version v
       JOIN hope_spec_item i ON i.spec_version_id = v.id
       JOIN hope_spec_item_isc isi ON isi.spec_item_id = i.id
       WHERE v.code='1.00.1' AND i.kind='assessment' AND isi.active = true
       GROUP BY isi.isc, i.section_label`,
    );
    const grouped: Record<string, Record<string, number>> = {};
    for (const row of rows) {
      grouped[row.isc] ??= {};
      grouped[row.isc][row.section_label] = Number(row.n);
    }
    expect(grouped.HA).toEqual({ A: 56, F: 8, I: 16, J: 43, M: 21, N: 6, Z: 1 });
    expect(grouped.HUV).toEqual({ A: 25, J: 22, M: 21, N: 6, Z: 2 });
    expect(grouped.HD).toEqual({ A: 16, Z: 1 });
  });

  it("stores a complete ISC matrix and representative item/options", async () => {
    const matrix = await db.query<{ item_code: string; isc: string; active: boolean }>(
      `SELECT i.item_code, isi.isc, isi.active
       FROM hope_spec_version v
       JOIN hope_spec_item i ON i.spec_version_id = v.id
       JOIN hope_spec_item_isc isi ON isi.spec_item_id = i.id
       WHERE v.code='1.00.1' AND i.item_code IN ('Z0350','Z0500B')
       ORDER BY i.item_code, isi.isc`,
    );
    expect(matrix.rows.filter((r) => r.item_code === "Z0350")).toEqual([
      { item_code: "Z0350", isc: "HA", active: false },
      { item_code: "Z0350", isc: "HD", active: false },
      { item_code: "Z0350", isc: "HUV", active: true },
      { item_code: "Z0350", isc: "XX", active: true },
    ]);
    expect(matrix.rows.filter((r) => r.item_code === "Z0500B").every((r) => r.active)).toBe(true);

    const j2051 = await db.query<{ value_code: string; label: string }>(
      `SELECT o.value_code, o.label
       FROM hope_spec_version v
       JOIN hope_spec_item i ON i.spec_version_id = v.id
       JOIN hope_spec_item_option o ON o.spec_item_id = i.id
       WHERE v.code='1.00.1' AND i.item_code='J2051A'
       ORDER BY o.sort_order`,
    );
    expect(j2051.rows.map((r) => r.value_code)).toEqual(["0", "1", "^", "2", "3", "9"]);
    expect(j2051.rows.find((r) => r.value_code === "9")?.label).toBe(
      "Not applicable (the patient is not experiencing the symptom)",
    );
  });
});
