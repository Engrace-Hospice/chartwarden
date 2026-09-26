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
import { allPermissionMirrorRows } from "../src/permissions/contributed";
import { ROLE_TEMPLATES, SYSTEM_LOCKED_FLOORS, floorViolations } from "../src/roles";

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

/**
 * F-093 — the role catalog's permission references must resolve against the permission catalog.
 *
 * `SYSTEM_LOCKED_FLOORS` and `RoleTemplate.grants` are both typed `readonly string[]` and not
 * `PermissionKey`, deliberately: they name keys OTHER modules register, which the M3-only union cannot
 * express. So nothing — not the compiler, not any gate — ever compared the two, and eight of the
 * twenty-seven floor entries named keys no module registers (`cti.sign` where M6 registers
 * `cti.sign_hospice_md`, `order.cosign` where M11 registers `orders.cosign`, `security_event.read` for a
 * resource that exists nowhere in the platform, …).
 *
 * That is not cosmetic. `role_permission.permission_key` REFERENCES `permission.key`, so a floor key
 * with no catalog row is UNGRANTABLE — the insert dies on the foreign key — which made the CoP floor of
 * four of the six locked roles unsatisfiable. And `floorViolations` reports an ungrantable key as
 * stripped on every permission-set edit, so once §3.4.1 is genuinely enforced (it was not: the check
 * lived only in the in-memory RoleStore, never in the Drizzle one production mounts) a locked role
 * becomes permanently uneditable.
 */
describe("F-093 role catalog ↔ permission catalog", () => {
  const registered = new Set(allPermissionMirrorRows().map((r) => r.key));

  it("every system_locked CoP floor key is a registered permission key", () => {
    const dangling = Object.entries(SYSTEM_LOCKED_FLOORS).flatMap(([role, floor]) =>
      (floor as readonly string[]).filter((k) => !registered.has(k)).map((k) => `${role}: ${k}`),
    );
    expect(dangling).toEqual([]);
  });

  it("every role template's default grants are registered permission keys", () => {
    const dangling = ROLE_TEMPLATES.flatMap((t) =>
      (t.grants ?? []).filter((k) => !registered.has(k)).map((k) => `${t.key}: ${k}`),
    );
    expect(dangling).toEqual([]);
  });

  it("a system_locked role's floor is satisfiable by granting exactly the floor", () => {
    // The property the FK enforces at the database, asserted here where it is cheap: if every floor key
    // is grantable then `floorViolations(key, floor)` is empty, i.e. the minimum edit that keeps a
    // locked role legal is the floor itself. A dangling key breaks this in both directions at once.
    for (const [role, floor] of Object.entries(SYSTEM_LOCKED_FLOORS)) {
      expect([role, floorViolations(role, [...(floor as readonly string[])])]).toEqual([role, []]);
    }
  });
});
