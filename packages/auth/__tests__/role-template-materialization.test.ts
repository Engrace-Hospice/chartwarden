import { readFileSync } from "node:fs";
import { join } from "node:path";
/**
 * GAP-006 - the pure plan for materializing ROLE_TEMPLATES into one tenant's `role` rows.
 * The DB executor is proven live (m3-role-template-materialization.live.test.ts); this pins the decisions.
 */
import { describe, expect, it } from "vitest";
import {
  NOTE_CLOSURE_PERMISSION_KEYS,
  NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS,
  ROLE_TEMPLATES,
  allPermissionMirrorRows,
  isTenantRoleReserved,
  planRoleTemplateMaterialization,
} from "../src";
import {
  ADMINISTRATOR_EXCLUDED_KEYS,
  FULL_CATALOG_EXCLUDED_KEYS,
} from "../src/roles/template-materialization";

const MIRROR = allPermissionMirrorRows().map((r) => ({ key: r.key, category: r.category }));
const plan = (existing: string[] = [], mirror = MIRROR) =>
  planRoleTemplateMaterialization({
    templates: ROLE_TEMPLATES,
    existingRoleKeys: new Set(existing),
    mirror,
  });

describe("planRoleTemplateMaterialization", () => {
  it("gives a fresh tenant every tenant-assignable template, including org_admin", () => {
    const keys = plan().map((r) => r.key);
    expect(keys).toContain("org_admin");
    expect(keys).toContain("administrator");
    expect(keys).toContain("medical_director");
    expect(keys).toContain("compliance_officer");
  });

  it("never clones a platform-owned template into a tenant", () => {
    for (const role of plan())
      expect(isTenantRoleReserved({ key: role.key, category: role.category })).toBe(false);
    expect(plan().some((r) => r.key.startsWith("platform_"))).toBe(false);
  });

  it("is create-only: roles the org already has are not planned again", () => {
    const keys = plan(["org_admin", "medical_director"]).map((r) => r.key);
    expect(keys).not.toContain("org_admin");
    expect(keys).not.toContain("medical_director");
    expect(keys).toContain("administrator");
    expect(plan(ROLE_TEMPLATES.map((t) => t.key))).toEqual([]);
  });

  it("gives org_admin and administrator the whole catalog EXCEPT cross-tenant platform keys", () => {
    const orgAdmin = plan().find((r) => r.key === "org_admin");
    const platformKeys = MIRROR.filter((p) => p.category === "platform").map((p) => p.key);
    expect(platformKeys.length).toBeGreaterThan(0);
    expect(orgAdmin?.permissionKeys.length).toBe(
      MIRROR.length - platformKeys.length - FULL_CATALOG_EXCLUDED_KEYS.size,
    );
    for (const key of platformKeys) expect(orgAdmin?.permissionKeys).not.toContain(key);
    // administrator holds the same catalog less the keys its role-keyed ABAC predicate never admits (a dead grant).
    expect(plan().find((r) => r.key === "administrator")?.permissionKeys).toEqual(
      orgAdmin?.permissionKeys.filter((k) => !ADMINISTRATOR_EXCLUDED_KEYS.has(k)),
    );
  });

  it("keeps messaging.review (the lifecycle review queue) off org_admin and administrator", () => {
    expect(MIRROR.some((p) => p.key === "messaging.review")).toBe(true);
    for (const key of ["org_admin", "administrator"])
      expect(plan().find((r) => r.key === key)?.permissionKeys).not.toContain("messaging.review");
  });

  it("keeps the urgent clinical keys off org_admin and administrator, and gives them to exactly the role templates migration 1105 names", () => {
    const sql = readFileSync(
      join(__dirname, "../../db/migrations/1105_m36_message_urgency.sql"),
      "utf8",
    );
    // The role-key list 1105 grants each permission to (the `r."key" IN (...)` after that permission's SELECT).
    const granted = (permission: string): string[] => {
      const at = sql.indexOf(`'${permission}'\n  FROM "role" r`);
      const list = /IN \(([^)]*)\)/.exec(sql.slice(at))?.[1] ?? "";
      return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    };
    const templateKeys = new Set(ROLE_TEMPLATES.map((t) => t.key));
    for (const key of ["messaging.urgent.send", "messaging.urgent.receive"]) {
      expect(MIRROR.some((p) => p.key === key)).toBe(true);
      for (const role of ["org_admin", "administrator", "compliance_officer"])
        expect(plan().find((r) => r.key === role)?.permissionKeys).not.toContain(key);
      const holders = plan()
        .filter((r) => r.permissionKeys.includes(key))
        .map((r) => r.key)
        .sort();
      const expected = granted(key)
        .filter((role) => templateKeys.has(role))
        .sort();
      expect(expected.length).toBeGreaterThan(0);
      expect(granted(key).length).toBeGreaterThan(5);
      expect(holders).toEqual(expected);
    }
  });

  it("splits the closure keys (ADR-0113 D7): the override to the supervisor template only, the policy key to the DON template AND the administrators", () => {
    const [OVERRIDE, POLICY_ADMIN] = NOTE_CLOSURE_PERMISSION_KEYS;
    const templated = ROLE_TEMPLATES.filter((t) =>
      (NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS as readonly string[]).includes(t.key),
    ).map((t) => t.key);
    // Only the DON is a template today; clinical_supervisor / don / clinical_lead get the override from migration 1515 where a tenant created them.
    expect(templated).toEqual(["director_of_nursing"]);
    const holders = (key: string) =>
      plan()
        .filter((r) => r.permissionKeys.includes(key))
        .map((r) => r.key)
        .sort();
    for (const key of NOTE_CLOSURE_PERMISSION_KEYS) {
      expect(MIRROR.some((p) => p.key === key)).toBe(true);
      expect(plan().find((r) => r.key === "compliance_officer")?.permissionKeys).not.toContain(key);
    }
    // the override stays out of the full catalog: an administrator is not a clinical supervisor
    expect(FULL_CATALOG_EXCLUDED_KEYS.has(OVERRIDE)).toBe(true);
    expect(holders(OVERRIDE)).toEqual(["director_of_nursing"]);
    // the policy key is derived by the administrators and held by the DON template
    expect(FULL_CATALOG_EXCLUDED_KEYS.has(POLICY_ADMIN)).toBe(false);
    expect(holders(POLICY_ADMIN)).toEqual(["administrator", "director_of_nursing", "org_admin"]);
  });

  it("grants messaging.review to the director of nursing template only among the defaults", () => {
    expect(plan().find((r) => r.key === "director_of_nursing")?.permissionKeys).toContain(
      "messaging.review",
    );
  });

  it("grants a locked role at least its CoP floor", () => {
    const director = plan().find((r) => r.key === "medical_director");
    const template = ROLE_TEMPLATES.find((t) => t.key === "medical_director");
    expect(director?.systemLocked).toBe(true);
    for (const key of template?.floor ?? []) expect(director?.permissionKeys).toContain(key);
  });

  it("skips (and reports) template keys the permission mirror lacks instead of failing the plan", () => {
    const trimmed = MIRROR.filter((p) => p.key !== "patient.read");
    const director = plan([], trimmed).find((r) => r.key === "medical_director");
    expect(director?.permissionKeys).not.toContain("patient.read");
    expect(director?.missingPermissionKeys).toContain("patient.read");
  });
});
