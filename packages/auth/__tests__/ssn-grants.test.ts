// GAP-010 — who holds the SSN keys. Pins the default-grant table, the backfill migration 0801 and the permission
// catalog to each other, and asserts the roles that were named must actually exist as role keys in this repo (a
// backfill that targets a nonexistent role key silently grants nothing and a pin test of the table alone would pass).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allPermissionMirrorRows } from "../src/permissions/contributed";
import {
  INTAKE_ROLE_KEYS,
  ROLE_TEMPLATES,
  SSN_DEFAULT_GRANTS,
  SSN_READ_KEY,
  SSN_READ_ROLE_KEYS,
  SSN_WRITE_KEY,
  SSN_WRITE_ROLE_KEYS,
  hasOrgWideScope,
} from "../src/roles";

const MIGRATION = join(__dirname, "../../db/migrations/0801_m5_ssn_default_role_grants.sql");

describe("SSN_DEFAULT_GRANTS", () => {
  it("grants write to the intake supervisor, billing manager and the two full-catalog admins", () => {
    expect([...SSN_WRITE_ROLE_KEYS].sort()).toEqual([
      "administrator",
      "billing_manager",
      "intake_supervisor",
      "org_admin",
    ]);
  });
  it("adds only the compliance officer for read", () => {
    expect(SSN_READ_ROLE_KEYS.filter((k) => !SSN_WRITE_ROLE_KEYS.includes(k as never))).toEqual([
      "compliance_officer",
    ]);
  });
  it("gives clinical roles neither key (minimum necessary)", () => {
    for (const clinical of [
      "rn",
      "lpn",
      "rn_case_manager",
      "md",
      "np",
      "pa",
      "director_of_nursing",
    ])
      expect(Object.keys(SSN_DEFAULT_GRANTS), clinical).not.toContain(clinical);
  });
  it("names role keys that exist: templates, or the M6 intake roles", () => {
    const templateKeys = new Set(ROLE_TEMPLATES.map((t) => t.key));
    for (const key of ["org_admin", "administrator", "compliance_officer"])
      expect(templateKeys.has(key), key).toBe(true);
    expect(INTAKE_ROLE_KEYS).toContain("intake_supervisor");
    // `billing_finance` is a CATEGORY, not a role key: it must not be what we grant to.
    expect(Object.keys(SSN_DEFAULT_GRANTS)).not.toContain("billing_finance");
    expect(templateKeys.has("billing_finance")).toBe(false);
  });
  it("only references keys the permission catalog declares", () => {
    const catalog = new Set(allPermissionMirrorRows().map((r) => r.key));
    expect(catalog.has(SSN_WRITE_KEY)).toBe(true);
    expect(catalog.has(SSN_READ_KEY)).toBe(true);
  });
  it("is frozen", () => {
    expect(Object.isFrozen(SSN_DEFAULT_GRANTS)).toBe(true);
  });
  it("documents the scope boundary: oversight and tenant-admin roles are org-wide chart readers (ADR-0090)", () => {
    for (const key of ["compliance_officer", "org_admin", "administrator"])
      expect(hasOrgWideScope([key]), key).toBe(true);
    for (const key of ["intake_supervisor", "billing_manager"])
      expect(hasOrgWideScope([key]), key).toBe(false);
  });
});

describe("migration 0801", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const pairs = [...sql.matchAll(/\('([a-z_]+)',\s+'(phi\.(?:read|write)_ssn)'\)/g)].map(
    (m) => `${m[1]}:${m[2]}`,
  );

  it("backfills exactly the (role, key) pairs in SSN_DEFAULT_GRANTS", () => {
    const expected = Object.entries(SSN_DEFAULT_GRANTS).flatMap(([role, keys]) =>
      keys.map((k) => `${role}:${k}`),
    );
    expect([...pairs].sort()).toEqual([...expected].sort());
  });
  it("is idempotent and never removes a grant", () => {
    expect(sql).toContain('ON CONFLICT ("role_id", "permission_key") DO NOTHING');
    expect(sql).not.toMatch(/\bDELETE\b/i);
  });
});
