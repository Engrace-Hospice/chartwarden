// Tenant onboarding slice 4 (ADR-0110): the DoseSpot clinic registration decides where EVERY prescription of the organization
// goes, so its tenant keys are ORG-LEVEL and bound to the org-wide admin roles only (a prescriber-roster admin must not inherit
// them), and its platform keys belong to the exact platform_ops role like the other onboarding-data keys.
import { describe, expect, it } from "vitest";
import {
  M12_CONTRIBUTED_PERMISSIONS,
  M34_CONTRIBUTED_PERMISSIONS,
  PLATFORM_ONBOARDING_DATA_KEYS,
  ROLE_TEMPLATES,
  allPermissionMirrorRows,
  planRoleTemplateMaterialization,
} from "../src";
import {
  FULL_CATALOG_EXCLUDED_KEYS,
  FULL_CATALOG_ROLE_KEYS,
} from "../src/roles/template-materialization";

const TENANT_KEYS = ["prescribing.clinic.read", "prescribing.clinic.admin"] as const;
const PLATFORM_KEYS = ["tenant_dosespot.read_platform", "tenant_dosespot.write_platform"] as const;
const MIRROR = allPermissionMirrorRows().map((r) => ({ key: r.key, category: r.category }));
const PLANNED = planRoleTemplateMaterialization({
  templates: ROLE_TEMPLATES,
  existingRoleKeys: new Set<string>(),
  mirror: MIRROR,
});

describe("prescribing.clinic.read / .admin (the tenant's own registration)", () => {
  it("are minted as org-level keys, separate from the prescriber roster key", () => {
    for (const key of TENANT_KEYS) {
      expect(M12_CONTRIBUTED_PERMISSIONS).toHaveProperty([key]);
      expect(M12_CONTRIBUTED_PERMISSIONS[key].abac).toBe("none");
    }
    expect(M12_CONTRIBUTED_PERMISSIONS).toHaveProperty(["prescribing.admin.roster"]);
  });

  it("reach exactly the org-wide admin roles: org_admin and administrator, through the full catalog", () => {
    for (const key of TENANT_KEYS) expect(FULL_CATALOG_EXCLUDED_KEYS.has(key)).toBe(false);
    const holders = PLANNED.filter((r) =>
      TENANT_KEYS.every((k) => r.permissionKeys.includes(k)),
    ).map((r) => r.key);
    expect(holders.sort()).toEqual([...FULL_CATALOG_ROLE_KEYS].sort());
  });

  it("are held by no other tenant role template, floor or explicit grant", () => {
    for (const role of PLANNED) {
      if (FULL_CATALOG_ROLE_KEYS.has(role.key)) continue;
      for (const key of TENANT_KEYS) expect(role.permissionKeys).not.toContain(key);
    }
    for (const t of ROLE_TEMPLATES) {
      for (const key of TENANT_KEYS) expect([...t.floor, ...(t.grants ?? [])]).not.toContain(key);
    }
  });
});

describe("tenant_dosespot.read_platform / .write_platform (an operator for the tenant)", () => {
  it("are platform keys gated on the platform_ops predicate and listed with the onboarding-data keys", () => {
    for (const key of PLATFORM_KEYS) {
      expect(M34_CONTRIBUTED_PERMISSIONS[key]).toMatchObject({
        category: "platform",
        abac: "tenant_lifecycle_platform_ops",
      });
      expect(PLATFORM_ONBOARDING_DATA_KEYS).toContain(key);
    }
  });
});
