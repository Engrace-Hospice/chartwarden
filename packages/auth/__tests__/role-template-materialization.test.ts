/**
 * GAP-006 - the pure plan for materializing ROLE_TEMPLATES into one tenant's `role` rows.
 * The DB executor is proven live (m3-role-template-materialization.live.test.ts); this pins the decisions.
 */
import { describe, expect, it } from "vitest";
import {
  ROLE_TEMPLATES,
  allPermissionMirrorRows,
  isTenantRoleReserved,
  planRoleTemplateMaterialization,
} from "../src";

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
    expect(orgAdmin?.permissionKeys.length).toBe(MIRROR.length - platformKeys.length);
    for (const key of platformKeys) expect(orgAdmin?.permissionKeys).not.toContain(key);
    expect(plan().find((r) => r.key === "administrator")?.permissionKeys).toEqual(
      orgAdmin?.permissionKeys,
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
