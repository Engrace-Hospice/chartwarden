// ADR-0114 (visit-note drafting) — migration 1520's catalog row and default grants are pinned to the code: the permission key, its
// catalog entry in M8_CONTRIBUTED_PERMISSIONS, the role-key constants and the DON template (the 1515 / note-closure-grants.test.ts
// precedent). The SQL role list and the constants cannot drift apart. The draft switch has the SAME owners as the closure policy: the
// DON keys and the two full-catalog administrator roles, never the field supervisors, aides or clinicians.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DRAFT_POLICY_ADMIN_PERMISSION_KEY,
  DRAFT_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS,
  FULL_CATALOG_EXCLUDED_KEYS,
  FULL_CATALOG_ROLE_KEYS,
  M8_CONTRIBUTED_PERMISSIONS,
  NOTE_CLOSURE_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS,
  ROLE_TEMPLATES,
  VISIT_NOTE_DRAFT_DEFAULT_GRANTS,
} from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import { roleMayHoldPermission } from "../../../scripts/db/lib/idg-role-grants";

const sql = readFileSync(
  join(__dirname, "../../../packages/db/migrations/1520_m8_visit_note_draft_permissions.sql"),
  "utf8",
);
const quoted = (text: string): string[] =>
  [...text.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1] ?? "");

/** The role keys `r."key" IN (...)` of the `role_permission` INSERT. */
function grantedRoleKeys(): string[] {
  const statement = sql
    .split("--> statement-breakpoint")
    .find((part) => part.includes('INSERT INTO "role_permission"'));
  expect(statement, "a role_permission INSERT").toBeDefined();
  const list = /r\."key" IN \(([^)]*)\)/.exec(statement ?? "")?.[1] ?? "";
  return quoted(list);
}

describe("visit-note draft default grants (migration 1520)", () => {
  it("seeds exactly one permission key, encounter.draft_policy_admin", () => {
    expect(DRAFT_POLICY_ADMIN_PERMISSION_KEY).toBe("encounter.draft_policy_admin");
    const permissionInsert =
      sql
        .split("--> statement-breakpoint")
        .find((part) => part.includes('INSERT INTO "permission"')) ?? "";
    expect(quoted(permissionInsert).filter((k) => k.includes("."))).toEqual([
      DRAFT_POLICY_ADMIN_PERMISSION_KEY,
    ]);
  });

  it("grants it to exactly the DON keys and the full-catalog administrator roles", () => {
    expect(grantedRoleKeys().sort()).toEqual(
      [...DRAFT_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS, ...FULL_CATALOG_ROLE_KEYS].sort(),
    );
  });

  it("never grants it to the field supervisors or to clinicians and aides", () => {
    for (const key of ["clinical_supervisor", "clinical_lead", "rn", "lpn", "chha"]) {
      expect(grantedRoleKeys()).not.toContain(key);
    }
  });

  it("has the same owners as the closure policy", () => {
    expect([...DRAFT_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS].sort()).toEqual(
      [...NOTE_CLOSURE_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS].sort(),
    );
  });

  it("declares the migration an expand", () => {
    expect(sql.startsWith("-- compat: expand")).toBe(true);
  });
});

describe("visit-note draft permission catalog (migration 1520 mirror row)", () => {
  it("is a compliance-category M8 key with no ABAC default, mirrored by the migration", () => {
    const def = M8_CONTRIBUTED_PERMISSIONS[DRAFT_POLICY_ADMIN_PERMISSION_KEY];
    expect(def.resource).toBe("encounter");
    expect(def.action).toBe("draft_policy_admin");
    expect(def.category).toBe("compliance");
    expect(def.abac).toBe("none");
    expect(sql).toMatch(
      /\('encounter\.draft_policy_admin', 'encounter', 'draft_policy_admin', 'compliance', 'none',/,
    );
  });

  it("is derived from the full catalog by the administrators (not withheld)", () => {
    expect(FULL_CATALOG_EXCLUDED_KEYS.has(DRAFT_POLICY_ADMIN_PERMISSION_KEY)).toBe(false);
  });
});

describe("VISIT_NOTE_DRAFT_DEFAULT_GRANTS and the DON template", () => {
  it("maps each DON key to the policy key, and nobody else", () => {
    expect(Object.keys(VISIT_NOTE_DRAFT_DEFAULT_GRANTS).sort()).toEqual(
      [...DRAFT_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS].sort(),
    );
    for (const roleKey of DRAFT_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS) {
      expect(VISIT_NOTE_DRAFT_DEFAULT_GRANTS[roleKey]).toEqual([DRAFT_POLICY_ADMIN_PERMISSION_KEY]);
    }
  });

  it("the director_of_nursing template carries the key", () => {
    const don = ROLE_TEMPLATES.find((template) => template.key === "director_of_nursing");
    expect(don?.grants).toContain(DRAFT_POLICY_ADMIN_PERMISSION_KEY);
  });
});

describe("roleMayHoldPermission (the dev category sweep must not hand the key to field roles)", () => {
  it.each(["director_of_nursing", "don"])("keeps it for %s", (role) => {
    expect(roleMayHoldPermission(role, DRAFT_POLICY_ADMIN_PERMISSION_KEY)).toBe(true);
  });

  it.each([
    "clinical_supervisor",
    "clinical_lead",
    "rn",
    "lpn",
    "chha",
    "chaplain",
    "volunteer",
    "msw",
    "md",
    "np",
    "auditor",
    "compliance_officer",
  ])("withholds it from %s", (role) => {
    expect(roleMayHoldPermission(role, DRAFT_POLICY_ADMIN_PERMISSION_KEY)).toBe(false);
  });
});
