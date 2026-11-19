// ADR-0113 D7 / CW-AC-48 — a full-catalog dev role (administrator, org_admin) never holds `encounter.closure_override`, whichever dev
// script built it. Migration 1515, the role materializer and the permission sync already withhold it; the two seed scripts
// (`db:seed`, `db:seed:org-admin`) once handed the whole catalog out, so a reseeded demo tenant gave its admins the supervisor key.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOTE_CLOSURE_PERMISSION_KEYS, allPermissionMirrorRows } from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import { WITHHELD_CLOSURE_KEYS, fullCatalogGrantRows } from "../db/lib/full-catalog-grants";

const [OVERRIDE, POLICY_ADMIN] = NOTE_CLOSURE_PERMISSION_KEYS;
const source = (file: string): string => readFileSync(join(__dirname, "../db", file), "utf8");

describe("fullCatalogGrantRows", () => {
  const rows = allPermissionMirrorRows();

  it("withholds the override and nothing else of the closure pair", () => {
    expect([...WITHHELD_CLOSURE_KEYS]).toEqual([OVERRIDE]);
    const granted = new Set(fullCatalogGrantRows(rows).map((row) => row.key));
    expect(granted.has(OVERRIDE)).toBe(false);
    expect(granted.has(POLICY_ADMIN)).toBe(true);
  });

  it("drops exactly the withheld rows from the catalog", () => {
    expect(rows.some((row) => row.key === OVERRIDE)).toBe(true);
    expect(fullCatalogGrantRows(rows)).toHaveLength(rows.length - WITHHELD_CLOSURE_KEYS.size);
  });
});

describe("the dev scripts that build a full-catalog role", () => {
  it.each(["seed.ts", "seed-org-admin.ts", "sync-permission-catalog.ts"])(
    "%s grants through fullCatalogGrantRows",
    (file) => {
      expect(source(file)).toContain("fullCatalogGrantRows(");
    },
  );

  it.each(["seed.ts", "seed-org-admin.ts"])("%s never maps the whole catalog to keys", (file) => {
    expect(source(file)).not.toMatch(/\ballRows\.map\(\(\w+\) => \w+\.key\)/);
  });
});
