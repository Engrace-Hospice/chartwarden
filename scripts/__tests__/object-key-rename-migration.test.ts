// Static contract of migration 1546 (the object-key column rename) and its operator runbook: the migration bounds
// its own lock waits, and the catalog predicate it ends with is the SAME text the runbook has the operator run
// before the window (a drifted copy would let the pre-window check pass while the migration aborts the window).
// The behaviour itself (rows, scrub list, scratch objects) is proved live in db-migrate.live.test.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripSqlComments } from "../lib/gate-scan";
import { normalizeCatalogPredicate } from "../lib/object-key-rename-predicate";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATION = join(ROOT, "packages/db/migrations/1546_object_key_column_rename.sql");
const RUNBOOK = join(ROOT, "docs/runbooks/object-key-column-rename-deployment.md");

describe("migration 1546 static contract", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("is declared contract", () => {
    expect(sql.split("\n")[0]).toBe("-- compat: contract");
  });

  it("bounds its lock waits before it takes the first lock", () => {
    // Arrange
    const firstStatement = stripSqlComments(sql).trim().split(";")[0]!.replace(/\s+/g, " ");

    // Assert
    expect(firstStatement).toBe("SET LOCAL lock_timeout = '10s'");
  });

  it("ends with the same catalog predicate the runbook has the operator run before the window", () => {
    // Arrange
    const runbook = readFileSync(RUNBOOK, "utf8");

    // Act
    const inMigration = normalizeCatalogPredicate(sql);
    const inRunbook = normalizeCatalogPredicate(runbook);

    // Assert
    expect(inMigration.length).toBeGreaterThan(200);
    expect(inRunbook).toBe(inMigration);
  });
});
