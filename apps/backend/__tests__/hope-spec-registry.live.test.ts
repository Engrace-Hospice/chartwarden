import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient, schema } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importHopeSpec } from "../../../scripts/db/import-hope-spec";
import { createHopeSpecRegistry } from "../src/modules/10-hope/hope-spec-registry";
import { LIVE_DROP_ROLES } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = LIVE_DROP_ROLES;

/**
 * A fresh schema, like the sibling spec suites. The database is shared and vitest does not order files:
 * `m10-hope-phase-1a-spec-foundation` leaves its own synthetic `1.00.1` version behind, which the real
 * import then refuses as "metadata differs".
 */
async function resetAndMigrate(): Promise<void> {
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    await db.query("DROP SCHEMA IF EXISTS public CASCADE");
    await db.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await db.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      let text = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        text = text.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- vector stripped");
        text = text.replace(/\bvector\(\d+\)/g, "text");
        text = text.replace(/^.*USING hnsw \(.*$/gm, "-- hnsw stripped");
      }
      await db.query(text);
    }
  } finally {
    await db.end();
  }
}

describe.skipIf(!DB_URL)("HopeSpecRegistry — LIVE Postgres", () => {
  let handle: ReturnType<typeof createDbClient>;

  beforeAll(async () => {
    await resetAndMigrate();
    handle = createDbClient({ connectionString: DB_URL! });
    await importHopeSpec({ databaseUrl: DB_URL });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
  });

  it("resolves v1.00.1 for target dates on/after 2025-10-01", async () => {
    const registry = createHopeSpecRegistry(handle.db);
    await expect(registry.resolveVersionForTargetDate("2025-09-30")).rejects.toThrow(
      "No HOPE spec version",
    );
    await expect(registry.resolveVersionForTargetDate("2025-10-01")).resolves.toMatchObject({
      code: "1.00.1",
    });
    await expect(registry.resolveVersionForTargetDate("2026-01-01")).resolves.toMatchObject({
      code: "1.00.1",
    });
  });

  it("detects overlapping effective ranges rather than picking one silently", async () => {
    await handle.db.execute(sql`
      INSERT INTO ${schema.hopeSpecVersions}
        (code, item_set_version, effective_from, effective_to, source_label)
      VALUES
        ('overlap-test', '1.00', '2025-12-01', NULL, 'overlap fixture')
      ON CONFLICT DO NOTHING
    `);
    await expect(
      createHopeSpecRegistry(handle.db).resolveVersionForTargetDate("2025-12-01"),
    ).rejects.toThrow("Overlapping HOPE spec versions");
  });

  it("reads items, active ISC members, and item options", async () => {
    const registry = createHopeSpecRegistry(handle.db);
    const version = await registry.resolveVersionForTargetDate("2025-10-01");
    await expect(registry.getItem(version.id, "J2051A")).resolves.toMatchObject({
      itemCode: "J2051A",
      kind: "assessment",
    });
    // The CMS v1.00.1 item master marks 29 items `x` in its `isc_hd` column.
    await expect(registry.getActiveItems(version.id, "HD")).resolves.toHaveLength(29);
    await expect(registry.getItemOptions(version.id, "J2051A")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ valueCode: "0" }),
        expect.objectContaining({ valueCode: "1" }),
        expect.objectContaining({ valueCode: "2" }),
        expect.objectContaining({ valueCode: "3" }),
        expect.objectContaining({ valueCode: "9" }),
      ]),
    );
  });
});
