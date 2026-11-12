import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("adopts the BIL-2 FK index migration alias only when its SQL checksum is unchanged", async () => {
    const filename = "1382_fk_supporting_indexes_code_status_emergency_recipient.sql";
    const legacy = "1378_fk_supporting_indexes_code_status_emergency_recipient.sql";
    const dir = dirWith({ [filename]: body });
    const db = fakeDb({ [legacy]: sha(body) });
    const result = await applyMigrations(db, { migrationsDir: dir, strictOrphans: true });
    expect(result.ran).toEqual([]);
    expect(result.orphaned).toEqual([]);
    expect(result.pending).toEqual([]);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE _chartwarden_migration"),
      [filename, sha(body), legacy],
    );
  });

  it("does not adopt the BIL-2 migration alias when the applied checksum differs", async () => {
    const filename = "1382_fk_supporting_indexes_code_status_emergency_recipient.sql";
    const legacy = "1378_fk_supporting_indexes_code_status_emergency_recipient.sql";
    const dir = dirWith({ [filename]: body });
    const result = await applyMigrations(fakeDb({ [legacy]: "different-checksum" }), {
      migrationsDir: dir,
    });
    expect(result.pending).toEqual([filename]);
    expect(result.orphaned).toEqual([legacy]);
  });

  it("adopts the deployed M36 filenames by their real checksums, then runs the ack-actor correction", async () => {
    const aliases = [
      [
        "1478_m36_death_notification.sql",
        "1454_m36_death_notification.sql",
        "31e0e3628276fa649bde2bc6f3bb03dba4daf9425e88555fb974bc8f6e71d645",
      ],
      [
        "1479_m36_death_notification_funeral_send.sql",
        "1455_m36_death_notification_funeral_send.sql",
        "70a713ace1fedde081da6209dcf0ef9bbe755d60e36f05dc5db506f55c894268",
      ],
      [
        "1480_m36_death_notification_disclosure_integrity.sql",
        "1456_m36_death_notification_disclosure_integrity.sql",
        "db72f50bca94c0db6922a51eee08adb551487f6caa15828f913cb562542f31c2",
      ],
    ] as const;
    const migrationsDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../packages/db/migrations",
    );
    const correction = "1481_m36_death_notification_ack_actor.sql";
    const current = Object.fromEntries(
      [...aliases.map(([filename]) => filename), correction].map((filename) => [
        filename,
        readFileSync(join(migrationsDir, filename), "utf8"),
      ]),
    );
    const tracked = Object.fromEntries(
      aliases.map(([, legacy, productionChecksum]) => [legacy, productionChecksum]),
    );
    const db = fakeDb(tracked);

    const result = await applyMigrations(db, {
      migrationsDir: dirWith(current),
      strictOrphans: true,
    });

    expect(result).toMatchObject({ ran: [correction], pending: [correction], orphaned: [] });
    for (const [filename, legacy, productionChecksum] of aliases) {
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE _chartwarden_migration"),
        [filename, sha(current[filename] ?? ""), legacy],
      );
      expect(tracked[legacy]).toBe(productionChecksum);
    }
  });
});
