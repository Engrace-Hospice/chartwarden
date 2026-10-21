/**
 * Migration 1146 — 'chartwarden' joins the reserved usernames — the LIVE Postgres proof.
 *
 * Path A (legacy data): replay every migration BEFORE 1146, seed a user that already holds username
 * 'chartwarden' (legal under 1064), apply 1146. It must not fail; the constraint is left NOT VALID, the
 * legacy row is untouched, and new writes of 'chartwarden' / 'wardenx' are rejected (23514).
 * Path B (clean data): after the legacy row is renamed, re-applying 1146 takes the no-violation branch, the
 * constraint becomes VALID, and it keeps rejecting the reserved names while accepting ordinary ones and NULL.
 * (No second-database replay: 1142 drops a cluster-global role, so a second database cannot replay it.)
 *
 * Run on a private pgvector container, one database at a time:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://postgres:…@host/throwaway bun run test:reserved-username:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const MIGRATION = "1146_m1_reserve_chartwarden_username.sql";
const CONSTRAINT = "user_username_not_reserved";

const sqlFiles = (upTo?: string) =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && (upTo === undefined || f < upTo))
    .sort();

async function replay(db: Client, files: string[]) {
  for (const f of files) await db.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
}

const validated = async (db: Client) =>
  (await db.query("SELECT convalidated FROM pg_constraint WHERE conname = $1", [CONSTRAINT])).rows[0]
    .convalidated as boolean;

const insertUser = (db: Client, id: string, username: string | null) =>
  db.query(`INSERT INTO "user" (id, email, username) VALUES ($1, $2, $3)`, [id, `${id}@x.test`, username]);

async function expectReservedRejected(db: Client, tag: string) {
  for (const [i, name] of ["chartwarden", "wardenx", "admin"].entries()) {
    await expect(insertUser(db, `00000000-0000-4000-8000-00000000${tag}${i}`, name), name).rejects.toMatchObject({
      code: "23514",
    });
  }
}

describe.skipIf(!DB_URL)("migration 1146 — reserve 'chartwarden' username — LIVE Postgres", () => {
  let db: Client;
  const LEGACY = "00000000-0000-4000-8000-0000000a0001";

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await replay(db, sqlFiles(MIGRATION));
    await insertUser(db, LEGACY, "chartwarden");
    await db.query(readFileSync(join(MIGRATIONS_DIR, MIGRATION), "utf8"));
  }, 900_000);

  afterAll(async () => {
    await db?.end();
  });

  it("applies over a legacy 'chartwarden' row without failing, leaving the constraint NOT VALID", async () => {
    expect(await validated(db)).toBe(false);
    const r = await db.query(`SELECT username FROM "user" WHERE id = $1`, [LEGACY]);
    expect(r.rows).toEqual([{ username: "chartwarden" }]);
  });

  it("rejects new 'chartwarden' / 'wardenx' / 'admin' usernames even while NOT VALID", async () => {
    await expectReservedRejected(db, "0b0");
  });

  it("accepts ordinary usernames and NULL", async () => {
    await insertUser(db, "00000000-0000-4000-8000-0000000a0010", "nurse.jane");
    await insertUser(db, "00000000-0000-4000-8000-0000000a0011", null);
  });

  it("is re-runnable: once the legacy row is renamed, a re-run validates the constraint", async () => {
    await db.query(`UPDATE "user" SET username = 'legacy-owner' WHERE id = $1`, [LEGACY]);
    await db.query(readFileSync(join(MIGRATIONS_DIR, MIGRATION), "utf8"));
    expect(await validated(db)).toBe(true);
  });

  it("once VALID it still rejects the reserved names and accepts ordinary ones", async () => {
    await expectReservedRejected(db, "0c0");
    await insertUser(db, "00000000-0000-4000-8000-0000000a0020", "nurse.jane2");
  });
});
