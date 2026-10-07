import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../db/migrate";

// GAP-189: a tracking row whose migration file no longer exists must be reported, not ignored.
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function fakeDb(tracked: Record<string, string>): Client {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT filename, checksum")) {
        return {
          rows: Object.entries(tracked).map(([filename, checksum]) => ({ filename, checksum })),
        };
      }
      return { rows: [] };
    }),
  } as unknown as Client;
}

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe("applyMigrations orphan detection (GAP-189)", () => {
  const body = "SELECT 1;";

  it("reports applied rows whose file was removed", async () => {
    const dir = dirWith({ "0001_a.sql": body });
    const db = fakeDb({ "0001_a.sql": sha(body), "0002_gone.sql": "x" });
    const result = await applyMigrations(db, { migrationsDir: dir });
    expect(result.orphaned).toEqual(["0002_gone.sql"]);
  });

  it("reports no orphans for a clean ledger", async () => {
    const dir = dirWith({ "0001_a.sql": body });
    const result = await applyMigrations(fakeDb({ "0001_a.sql": sha(body) }), {
      migrationsDir: dir,
    });
    expect(result.orphaned).toEqual([]);
  });

  it("throws under strictOrphans but not plain strict", async () => {
    const dir = dirWith({ "0001_a.sql": body });
    const tracked = { "0001_a.sql": sha(body), "0002_gone.sql": "x" };
    await expect(
      applyMigrations(fakeDb(tracked), { migrationsDir: dir, strict: true }),
    ).resolves.toBeDefined();
    await expect(
      applyMigrations(fakeDb(tracked), { migrationsDir: dir, strictOrphans: true }),
    ).rejects.toThrow(/0002_gone\.sql/);
  });
});
