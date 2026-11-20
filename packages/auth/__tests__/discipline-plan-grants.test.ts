// M15 (CW-AC-44 neighbour): the default discipline_plan.* grants for the two RN role keys. The constant and migration
// 1526 cannot drift apart, only the five keys go to only those two roles, and `sign` goes only to the role that can use it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allPermissionMirrorRows } from "../src/permissions/contributed";
import {
  DISCIPLINE_PLAN_DEFAULT_GRANTS,
  DISCIPLINE_PLAN_GRANTEE_ROLE_KEYS,
  ROLE_TEMPLATES,
} from "../src/roles";

const FIVE_KEYS = [
  "discipline_plan.read",
  "discipline_plan.read_summary",
  "discipline_plan.author",
  "discipline_plan.finalize",
  "discipline_plan.sign",
];

const pairs = (): string[] =>
  Object.entries(DISCIPLINE_PLAN_DEFAULT_GRANTS)
    .flatMap(([role, keys]) => keys.map((k) => `${role}|${k}`))
    .sort();

describe("DISCIPLINE_PLAN_DEFAULT_GRANTS", () => {
  it("migration 1526 grants exactly the constant", () => {
    const sql = readFileSync(
      join(__dirname, "../../db/migrations/1526_m15_discipline_plan_default_grants.sql"),
      "utf8",
    );
    const inMigration = [...sql.matchAll(/\('([a-z_]+)', '(discipline_plan\.[a-z_]+)'\)/g)]
      .map((m) => `${m[1]}|${m[2]}`)
      .sort();
    expect(inMigration).toEqual(pairs());
  });

  it("goes to exactly rn and rn_case_manager", () => {
    expect([...DISCIPLINE_PLAN_GRANTEE_ROLE_KEYS].sort()).toEqual(["rn", "rn_case_manager"]);
  });

  it("grants only the five read / read_summary / author / finalize / sign keys", () => {
    for (const keys of Object.values(DISCIPLINE_PLAN_DEFAULT_GRANTS))
      for (const key of keys) expect(FIVE_KEYS, key).toContain(key);
  });

  it("gives both roles read, read_summary, author and finalize, and sign only to rn_case_manager", () => {
    for (const role of ["rn", "rn_case_manager"])
      expect(DISCIPLINE_PLAN_DEFAULT_GRANTS[role], role).toEqual(
        expect.arrayContaining(FIVE_KEYS.filter((k) => k !== "discipline_plan.sign")),
      );
    // plain `rn` is not a signer role of any discipline-plan kind (apps/backend/__tests__/discipline-plan-grants-pin.test.ts)
    expect(DISCIPLINE_PLAN_DEFAULT_GRANTS.rn).not.toContain("discipline_plan.sign");
    expect(DISCIPLINE_PLAN_DEFAULT_GRANTS.rn_case_manager).toContain("discipline_plan.sign");
  });

  it("never grants the system keys", () => {
    for (const keys of Object.values(DISCIPLINE_PLAN_DEFAULT_GRANTS)) {
      expect(keys).not.toContain("discipline_plan.idg_revise");
      expect(keys).not.toContain("discipline_plan.read_internal");
    }
  });

  it("every granted key is a registered permission", () => {
    const registered = new Set(allPermissionMirrorRows().map((p) => p.key));
    for (const keys of Object.values(DISCIPLINE_PLAN_DEFAULT_GRANTS))
      for (const key of keys) expect(registered.has(key), key).toBe(true);
  });

  it("neither grantee is a role template, so a fresh tenant gets the keys only once a template carries them", () => {
    // If one is promoted to a template, this fails: that template must then carry exactly its grants (the care plan rule).
    const templated = ROLE_TEMPLATES.filter((t) => t.key in DISCIPLINE_PLAN_DEFAULT_GRANTS);
    expect(templated.map((t) => t.key)).toEqual([]);
  });
});
