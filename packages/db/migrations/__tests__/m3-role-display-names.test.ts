import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  fileURLToPath(new URL("../1088_m3_demo_role_display_names.sql", import.meta.url)),
  "utf8",
);

describe("M3 demo role display-name repair migration", () => {
  it("is narrowly scoped to the demo org, technical key, and known bad current name", () => {
    expect(SQL).toContain("o.slug = 'wardenx-demo'");
    expect(SQL).toContain("r.organization_id = o.id");
    expect(SQL).toContain("r.key = corrected.role_key");
    expect(SQL).toContain("r.name = corrected.old_name");
    expect(SQL).not.toMatch(/DELETE\s+FROM\s+role/i);
    expect(SQL).not.toMatch(/INSERT\s+INTO\s+role/i);
    expect(SQL).not.toMatch(/membership_role|role_permission/i);
  });

  it("contains exactly the four known corrupt key/name transitions", () => {
    const transitions = [
      ...SQL.matchAll(/\('([^']+)'::text,\s*'([^']+)'::text,\s*'([^']+)'::text\)/g),
    ].map((match) => match.slice(1));
    expect(transitions).toEqual([
      ["rn", "RN Case Manager", "Registered Nurse (RN)"],
      ["md", "Hospice Medical Director", "Physician (MD/DO)"],
      ["hospice_physician", "Hospice Medical Director", "Hospice Physician"],
      ["compliance_officer", "Clinical Supervisor", "Compliance Officer"],
    ]);
  });

  it("is idempotent because repaired rows no longer satisfy the old-name predicate", () => {
    for (const [, oldName, newName] of [
      ["rn", "RN Case Manager", "Registered Nurse (RN)"],
      ["md", "Hospice Medical Director", "Physician (MD/DO)"],
      ["hospice_physician", "Hospice Medical Director", "Hospice Physician"],
      ["compliance_officer", "Clinical Supervisor", "Compliance Officer"],
    ]) {
      expect(newName).not.toBe(oldName);
    }
    expect(SQL).toContain("SET name = corrected.new_name");
    expect(SQL).toContain("r.name = corrected.old_name");
  });
});
