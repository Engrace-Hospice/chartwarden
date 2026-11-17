// `superadmin` is answered from the code permission catalog, and "superadmin holds at least what org_admin holds"
// is only true if that catalog has every key the migrations seed into `permission` (a key a migration adds by SQL
// alone could be handed to org_admin through role_permission and then exceed the catalog superadmin reads).
// superadmin-permissions.test.ts compares two views of the SAME TypeScript catalog, so it cannot see this; this
// reads the SQL.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { allPermissionMirrorRows } from "@chartwarden/auth";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = new URL("../../packages/db/migrations/", import.meta.url).pathname;

/** Keys from every `INSERT INTO "permission" (...) VALUES (...)` statement, up to its ON CONFLICT or `;`. */
function permissionKeysSeededBySql(): Map<string, string> {
  const found = new Map<string, string>();
  const statement = /INSERT INTO "?permission"?\s*\([^)]*\)\s*VALUES([\s\S]*?)(?:ON CONFLICT|;)/gi;
  // A tuple opens with the key then resource, action, category, all single-quoted literals.
  const tuple = /\(\s*'([a-z0-9_.]+)'\s*,\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'[a-z_]+'/gi;
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const [, values = ""] of sql.matchAll(statement)) {
      for (const [, key = ""] of values.matchAll(tuple)) found.set(key, file);
    }
  }
  return found;
}

describe("the permission catalog covers every key the migrations seed", () => {
  const seeded = permissionKeysSeededBySql();

  it("finds the seeded keys (the parser is not silently matching nothing)", () => {
    expect(seeded.size).toBeGreaterThan(500);
  });

  it("has no key that exists only in SQL, so no tenant role can hold more than the catalog superadmin reads", () => {
    const catalog = new Set(allPermissionMirrorRows().map((row) => row.key));
    const sqlOnly = [...seeded]
      .filter(([key]) => !catalog.has(key))
      .map(([key, file]) => `${key} (${file})`);
    expect(sqlOnly).toEqual([]);
  });
});
