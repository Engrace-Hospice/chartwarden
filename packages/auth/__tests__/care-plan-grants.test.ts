// D-2 (CW-AC-44): the default care_plan.* grants. The constant, migration 1494 and the DON template cannot drift apart,
// and the sign grant matches the six roles `signer_role_match` accepts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allPermissionMirrorRows } from "../src/permissions/contributed";
import { CARE_PLAN_DEFAULT_GRANTS, CARE_PLAN_GRANTEE_ROLE_KEYS, ROLE_TEMPLATES } from "../src/roles";

const SIGNER_ROLE_KEYS = [
  "rn_case_manager",
  "hospice_physician",
  "nurse_practitioner",
  "msw",
  "chaplain",
  "medical_director",
]; // apps/backend/src/modules/07-care-plan/abac-predicates.ts SIGNER_ROLE_KEYS

const pairs = (): string[] =>
  Object.entries(CARE_PLAN_DEFAULT_GRANTS)
    .flatMap(([role, keys]) => keys.map((k) => `${role}|${k}`))
    .sort();

describe("CARE_PLAN_DEFAULT_GRANTS", () => {
  it("migration 1494 grants exactly the constant", () => {
    const sql = readFileSync(
      join(__dirname, "../../db/migrations/1494_care_plan_clinical_default_grants.sql"),
      "utf8",
    );
    const inMigration = [...sql.matchAll(/\('([a-z_]+)', '(care_plan\.[a-z_]+)'\)/g)]
      .map((m) => `${m[1]}|${m[2]}`)
      .sort();
    expect(inMigration).toEqual(pairs());
  });

  it("grants care_plan.sign to exactly the six signer roles", () => {
    const signers = CARE_PLAN_GRANTEE_ROLE_KEYS.filter((r) =>
      CARE_PLAN_DEFAULT_GRANTS[r]?.includes("care_plan.sign"),
    );
    expect([...signers].sort()).toEqual([...SIGNER_ROLE_KEYS].sort());
  });

  it("lets only the nurse case manager, clinical supervisor and DON author or finalize", () => {
    for (const key of ["care_plan.author", "care_plan.finalize"]) {
      const holders = CARE_PLAN_GRANTEE_ROLE_KEYS.filter((r) =>
        CARE_PLAN_DEFAULT_GRANTS[r]?.includes(key),
      );
      expect([...holders].sort()).toEqual(
        ["clinical_supervisor", "director_of_nursing", "rn_case_manager"].sort(),
      );
    }
  });

  it("never grants the system keys or an external role", () => {
    for (const keys of Object.values(CARE_PLAN_DEFAULT_GRANTS)) {
      expect(keys).not.toContain("care_plan.bootstrap");
      expect(keys).not.toContain("care_plan.idg_revise");
    }
    for (const role of ["physician_office", "portal_patient", "collaborator", "volunteer", "chha"])
      expect(CARE_PLAN_GRANTEE_ROLE_KEYS, role).not.toContain(role);
  });

  it("every granted key is a registered permission", () => {
    const registered = new Set(allPermissionMirrorRows().map((p) => p.key));
    for (const keys of Object.values(CARE_PLAN_DEFAULT_GRANTS))
      for (const key of keys) expect(registered.has(key), key).toBe(true);
  });

  it("the DON template carries its care plan grants for a fresh tenant", () => {
    const don = ROLE_TEMPLATES.find((t) => t.key === "director_of_nursing");
    for (const key of CARE_PLAN_DEFAULT_GRANTS.director_of_nursing ?? [])
      expect([...(don?.grants ?? []), ...(don?.floor ?? [])], key).toContain(key);
  });
});
