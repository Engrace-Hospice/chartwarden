// ADR-0113 D7 — migration 1511's catalog rows and default grants are pinned to the code: the two permission keys, their catalog entries in
// M8_CONTRIBUTED_PERMISSIONS, and the role-key constants (the 0379 / 1294 precedent). The SQL role lists and the constants cannot drift
// apart. Two keys, two owners: `closure_override` to the four supervisor keys; `closure_policy_admin` to the DON keys and the two
// full-catalog administrator roles, never to clinical_supervisor / clinical_lead.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FULL_CATALOG_ROLE_KEYS,
  M8_CONTRIBUTED_PERMISSIONS,
  NOTE_CLOSURE_DEFAULT_GRANTS,
  NOTE_CLOSURE_PERMISSION_KEYS,
  NOTE_CLOSURE_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS,
  NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS,
} from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import { SUPERVISOR_ROLE_KEYS } from "../src/modules/08-encounters/supervisor-roles";

const sql = readFileSync(
  join(__dirname, "../../../packages/db/migrations/1511_m8_note_closure_permissions.sql"),
  "utf8",
);
const quoted = (text: string): string[] =>
  [...text.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1] ?? "");
const [OVERRIDE, POLICY_ADMIN] = NOTE_CLOSURE_PERMISSION_KEYS;

/** The role keys `r."key" IN (...)` of the `role_permission` INSERT that grants `permission`. */
function grantedRoleKeys(permission: string): string[] {
  const statement = sql
    .split("--> statement-breakpoint")
    .find(
      (part) => part.includes('INSERT INTO "role_permission"') && part.includes(`'${permission}'`),
    );
  expect(statement, `a role_permission INSERT for ${permission}`).toBeDefined();
  const list = /r\."key" IN \(([^)]*)\)/.exec(statement ?? "")?.[1] ?? "";
  return quoted(list);
}

describe("note-closure default grants (migration 1511)", () => {
  it("grants closure_override to exactly NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS", () => {
    expect(grantedRoleKeys(OVERRIDE).sort()).toEqual([...NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS].sort());
  });

  it("grants closure_policy_admin to exactly the DON keys and the full-catalog administrator roles", () => {
    expect(grantedRoleKeys(POLICY_ADMIN).sort()).toEqual(
      [...NOTE_CLOSURE_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS, ...FULL_CATALOG_ROLE_KEYS].sort(),
    );
  });

  it("never grants closure_policy_admin to the field supervisors, or closure_override to an administrator", () => {
    for (const key of ["clinical_supervisor", "clinical_lead"]) {
      expect(grantedRoleKeys(POLICY_ADMIN)).not.toContain(key);
    }
    for (const key of FULL_CATALOG_ROLE_KEYS) expect(grantedRoleKeys(OVERRIDE)).not.toContain(key);
  });

  it("seeds only the two closure keys, and no other role or permission", () => {
    const keys = new Set(quoted(sql.split("--> statement-breakpoint").slice(1).join("")));
    for (const key of [
      "org_admin",
      "administrator",
      "clinical_supervisor",
      "clinical_lead",
      "don",
      "director_of_nursing",
    ]) {
      keys.delete(key);
    }
    expect([...keys].filter((k) => k.includes(".")).sort()).toEqual(
      [...NOTE_CLOSURE_PERMISSION_KEYS].sort(),
    );
  });

  it("is the same four-key supervisor set M8 and migration 1103 use", () => {
    expect([...NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS].sort()).toEqual([...SUPERVISOR_ROLE_KEYS].sort());
  });

  it("the policy-admin supervisors are a subset of the supervisor set", () => {
    for (const key of NOTE_CLOSURE_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS) {
      expect(NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS).toContain(key);
    }
  });

  it("leaves aides and clinicians out", () => {
    for (const key of ["rn", "lpn", "chha", "compliance_officer"]) {
      expect(NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS).not.toContain(key);
      expect(NOTE_CLOSURE_DEFAULT_GRANTS).not.toHaveProperty(key);
    }
  });
});

describe("NOTE_CLOSURE_DEFAULT_GRANTS", () => {
  it("gives every supervisor key the override and only the DON keys the policy key as well", () => {
    for (const roleKey of NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS) {
      const granted = NOTE_CLOSURE_DEFAULT_GRANTS[roleKey] ?? [];
      expect(granted, roleKey).toContain(OVERRIDE);
      expect(granted.includes(POLICY_ADMIN), roleKey).toBe(
        (NOTE_CLOSURE_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS as readonly string[]).includes(roleKey),
      );
    }
    expect(NOTE_CLOSURE_DEFAULT_GRANTS.clinical_supervisor).toEqual([OVERRIDE]);
    expect(NOTE_CLOSURE_DEFAULT_GRANTS.clinical_lead).toEqual([OVERRIDE]);
    expect(NOTE_CLOSURE_DEFAULT_GRANTS.director_of_nursing).toEqual([OVERRIDE, POLICY_ADMIN]);
    expect(NOTE_CLOSURE_DEFAULT_GRANTS.don).toEqual([OVERRIDE, POLICY_ADMIN]);
  });
});

describe("note-closure permission catalog (migration 1511 mirror rows)", () => {
  it.each(NOTE_CLOSURE_PERMISSION_KEYS)(
    "%s is a compliance-category M8 key mirrored by the migration",
    (key) => {
      const def = M8_CONTRIBUTED_PERMISSIONS[key];
      expect(def.category).toBe("compliance");
      expect(def.abac).toBe("none");
      const row = new RegExp(
        `\\('${key.replace(".", "\\.")}', '${def.resource}', '${def.action}', '${def.category}', '${def.abac}',`,
      );
      expect(sql).toMatch(row);
    },
  );

  it("declares the migration an expand", () => {
    expect(sql.startsWith("-- compat: expand")).toBe(true);
  });
});
