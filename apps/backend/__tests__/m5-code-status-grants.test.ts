// ADR-0104 — migration 1294's default grants are pinned to CODE_STATUS_EDITOR_ROLE_KEYS (the 0379 / admitting-clinician
// precedent): the SQL role list and the constant cannot drift apart.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CODE_STATUS_EDITOR_ROLE_KEYS } from "@chartwarden/auth";
import { describe, expect, it } from "vitest";

describe("patient.edit_code_status default grants", () => {
  it("migration 1294 grants exactly CODE_STATUS_EDITOR_ROLE_KEYS", () => {
    const sql = readFileSync(
      join(__dirname, "../../../packages/db/migrations/1294_m5_patient_code_status.sql"),
      "utf8",
    );
    const list = /r\."key" IN \(([^)]*)\)/.exec(sql)?.[1] ?? "";
    const keys = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...keys].sort()).toEqual([...CODE_STATUS_EDITOR_ROLE_KEYS].sort());
  });

  it("leaves intake and external roles out", () => {
    for (const key of ["intake_supervisor", "physician_office", "rn", "lpn"]) {
      expect(CODE_STATUS_EDITOR_ROLE_KEYS).not.toContain(key);
    }
  });
});
