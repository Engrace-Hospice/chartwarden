/**
 * `superadmin` supersedes sysadmin (`administrator`) and orgadmin (`org_admin`). Both hold the permission catalog
 * (minus what is withheld from them on purpose), and a stored `role_permission` row cannot keep a role current as
 * modules add keys: the grants that keep the two tenant admin roles whole write tenant-owned rows only. The
 * resolver therefore answers `superadmin` from the code catalog, never from stored rows — but with the SAME
 * withholdings the admin roles have, so superadmin never holds both halves of a two-person control.
 */
import {
  FULL_CATALOG_EXCLUDED_KEYS,
  PLATFORM_PERMISSION_CATEGORY,
  ROLE_TEMPLATES,
  SUPERADMIN_ROLE_KEY,
  allPermissionMirrorRows,
  effectivePermissionKeys,
  planRoleTemplateMaterialization,
  platformPermissionKeysIn,
} from "@chartwarden/auth";
import { describe, expect, it } from "vitest";

const mirror = allPermissionMirrorRows();
const held = () => new Set(effectivePermissionKeys(SUPERADMIN_ROLE_KEY, [], null));

describe("effectivePermissionKeys", () => {
  it("gives superadmin every catalog key that is not withheld, with no role_permission row stored", () => {
    const granted = held();
    expect(mirror.length).toBeGreaterThan(0);
    for (const { key } of mirror) {
      if (!FULL_CATALOG_EXCLUDED_KEYS.has(key)) expect(granted.has(key)).toBe(true);
    }
  });

  it("withholds what the admin roles are denied by design: redaction request + approve, review, urgent send/receive", () => {
    // One account holding BOTH halves of the redaction two-person control (ADR-0055 D9) is the escalation to avoid.
    expect([...FULL_CATALOG_EXCLUDED_KEYS].sort()).toEqual([
      "messaging.redact.approve",
      "messaging.redact.request",
      "messaging.review",
      "messaging.urgent.receive",
      "messaging.urgent.send",
    ]);
    const granted = held();
    for (const key of FULL_CATALOG_EXCLUDED_KEYS) expect(granted.has(key)).toBe(false);
  });

  it("is exactly what orgadmin holds plus the platform-category keys, and a superset of sysadmin", () => {
    const planned = planRoleTemplateMaterialization({
      templates: ROLE_TEMPLATES,
      existingRoleKeys: new Set(),
      mirror,
    });
    const orgAdmin = planned.find((r) => r.key === "org_admin")?.permissionKeys ?? [];
    const administrator = planned.find((r) => r.key === "administrator")?.permissionKeys ?? [];
    expect(orgAdmin.length).toBeGreaterThan(0);
    expect(administrator.length).toBeGreaterThan(0);
    const platformKeys = mirror
      .filter((row) => row.category === PLATFORM_PERMISSION_CATEGORY)
      .map((row) => row.key);
    expect([...held()].sort()).toEqual([...new Set([...orgAdmin, ...platformKeys])].sort());
    for (const key of administrator) expect(held().has(key)).toBe(true);
  });

  it("confers only the stored keys when the role row is tenant-owned (it never reaches here, but must not widen)", () => {
    expect(effectivePermissionKeys(SUPERADMIN_ROLE_KEY, ["patient.read"], "org-a")).toEqual([
      "patient.read",
    ]);
  });

  it("leaves every other role on exactly the keys stored for it", () => {
    const stored = ["patient.read"] as const;
    expect(effectivePermissionKeys("rn", stored, "org-a")).toEqual(["patient.read"]);
    expect(effectivePermissionKeys("platform_admin", [], null)).toEqual([]);
  });
});

describe("platformPermissionKeysIn", () => {
  const platformKeys = mirror
    .filter((row) => row.category === PLATFORM_PERMISSION_CATEGORY)
    .map((row) => row.key);

  it("names exactly the platform-category keys among those it is given", () => {
    expect(platformKeys.length).toBeGreaterThan(0);
    expect(platformPermissionKeysIn(["patient.read", ...platformKeys, "visit.read"])).toEqual(
      platformKeys,
    );
    expect(platformPermissionKeysIn(["patient.read", "visit.read"])).toEqual([]);
    expect(platformPermissionKeysIn([])).toEqual([]);
  });

  it("is never true of a key a tenant admin role is materialized with", () => {
    // If it were, the role routes would refuse a tenant editing its own org_admin role back to its defaults.
    const planned = planRoleTemplateMaterialization({
      templates: ROLE_TEMPLATES,
      existingRoleKeys: new Set(),
      mirror,
    });
    for (const role of planned) expect(platformPermissionKeysIn(role.permissionKeys)).toEqual([]);
  });
});
