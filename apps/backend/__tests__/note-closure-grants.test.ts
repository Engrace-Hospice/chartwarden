// ADR-0113 — migration 1511's catalog rows and default grants are pinned to the code: the two permission keys, their catalog entries in
// M8_CONTRIBUTED_PERMISSIONS, and NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS (the 0379 / 1294 precedent). The SQL role list and the constants
// cannot drift apart.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  M8_CONTRIBUTED_PERMISSIONS,
  NOTE_CLOSURE_PERMISSION_KEYS,
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

describe("note-closure default grants (migration 1511)", () => {
  it("grants exactly NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS", () => {
    const list = /r\."key" IN \(([^)]*)\)/.exec(sql)?.[1] ?? "";
    expect([...quoted(list)].sort()).toEqual([...NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS].sort());
  });

  it("grants exactly the two closure permission keys", () => {
    const cross = /CROSS JOIN \(VALUES (.*?)\) AS k/s.exec(sql)?.[1] ?? "";
    expect([...quoted(cross)].sort()).toEqual([...NOTE_CLOSURE_PERMISSION_KEYS].sort());
  });

  it("is the same four-key supervisor set M8 and migration 1103 use", () => {
    expect([...NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS].sort()).toEqual([...SUPERVISOR_ROLE_KEYS].sort());
  });

  it("leaves org_admin, aides and clinicians out", () => {
    for (const key of ["org_admin", "administrator", "rn", "lpn", "chha", "compliance_officer"]) {
      expect(NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS).not.toContain(key);
    }
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
