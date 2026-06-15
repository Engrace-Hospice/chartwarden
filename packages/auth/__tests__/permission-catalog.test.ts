/**
 * M3-T01 — Enums + code-owned permission catalog (M3 spec §3.2, §3.3).
 *
 * Accept criterion: "unit test that code catalog ↔ DB mirror is consistent."
 * The catalog is the source of truth; `permissionMirrorRows()` is the projection that
 * syncs into the read-only `permission` DB table (M3-T02). These tests prove the
 * projection never drifts from the catalog and that M3 ships exactly its cross-cutting
 * subset (role.* / breakglass.* / engagement.*) — the M2/M4 keys are registered by
 * those modules, not here (spec §3.3 ownership model).
 */
import { describe, expect, it } from "vitest";
import { PERMISSIONS, type PermissionKey, permissionMirrorRows } from "../src/permissions";

describe("M3-T01 permission catalog", () => {
  it("ships exactly Module 3's cross-cutting subset (spec §3.3)", () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual(
      [
        "breakglass.cosign",
        "breakglass.invoke",
        "breakglass.read",
        "engagement.manage",
        "engagement.read",
        "role.assign",
        "role.manage",
        "role.read",
      ].sort(),
    );
  });

  it("keys are `resource.action` namespaced (M03-F07 contract)", () => {
    for (const key of Object.keys(PERMISSIONS)) {
      expect(key).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it("each key's map prefix/suffix matches its resource/action", () => {
    for (const key of Object.keys(PERMISSIONS) as PermissionKey[]) {
      const def = PERMISSIONS[key];
      expect(key).toBe(`${def.resource}.${def.action}`);
    }
  });

  it("every catalog entry declares an abac value (predicate name or 'none')", () => {
    for (const def of Object.values(PERMISSIONS)) {
      expect(def.abac).toBeTruthy();
    }
  });

  it("M3's own keys are pure RBAC — abac 'none' (predicate registry is M3-T07)", () => {
    for (const def of Object.values(PERMISSIONS)) {
      expect(def.abac).toBe("none");
    }
  });
});

describe("M3-T01 catalog ↔ DB mirror consistency", () => {
  it("projects exactly one mirror row per catalog key, none extra", () => {
    const rows = permissionMirrorRows();
    expect(rows).toHaveLength(Object.keys(PERMISSIONS).length);
    expect(rows.map((r) => r.key).sort()).toEqual(Object.keys(PERMISSIONS).sort());
  });

  it("each mirror row's fields equal its catalog entry (abac → defaultAbac)", () => {
    for (const row of permissionMirrorRows()) {
      const def = PERMISSIONS[row.key as PermissionKey];
      expect(def).toBeDefined();
      expect(row.resource).toBe(def.resource);
      expect(row.action).toBe(def.action);
      expect(row.category).toBe(def.category);
      expect(row.defaultAbac).toBe(def.abac);
    }
  });

  it("mirror keys are unique (primary-key safe for the `permission` table)", () => {
    const keys = permissionMirrorRows().map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
