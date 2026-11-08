// ADR-0107 - migration 1312 backfills the staff signature-request keys onto the full-catalog roles. Pinned to
// FULL_CATALOG_ROLE_KEYS and the contributed catalog so the SQL lists cannot drift from the code (the 1294 precedent).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FULL_CATALOG_ROLE_KEYS, M31_CONTRIBUTED_PERMISSIONS } from "@chartwarden/auth";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    __dirname,
    "../../../packages/db/migrations/1312_m31_portal_signature_request_admin_grants.sql",
  ),
  "utf8",
);
const quoted = (text: string) => [...text.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]).sort();

describe("migration 1312 - signature-request keys for the full-catalog roles", () => {
  it("grants exactly FULL_CATALOG_ROLE_KEYS", () => {
    const roles = /r\."key" IN \(([^)]*)\)/.exec(sql)?.[1] ?? "";
    expect(quoted(roles)).toEqual([...FULL_CATALOG_ROLE_KEYS].sort());
  });

  it("grants every staff portal.signature_request.* key M31 contributes", () => {
    const values = /\(VALUES ([\s\S]*?)\) AS k/.exec(sql)?.[1] ?? "";
    const catalog = Object.keys(M31_CONTRIBUTED_PERMISSIONS)
      .filter((key) => key.startsWith("portal.signature_request."))
      .sort();
    expect(quoted(values)).toEqual(catalog);
  });
});
