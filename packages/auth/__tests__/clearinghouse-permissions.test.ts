// ADR-0053 amendment 2026-11-06, owner decision D3: the tenant's clearinghouse surface is ORG-LEVEL. Choosing the clearinghouse
// re-routes every provider entity's claims (PHI) to another vendor, so the keys are bound to the org-wide admin roles only, and
// a role scoped to one provider entity (the holder of billing.mac_credential.*) must not inherit them from any template.
import { describe, expect, it } from "vitest";
import {
  M23_CONTRIBUTED_PERMISSIONS,
  ROLE_TEMPLATES,
  allPermissionMirrorRows,
  planRoleTemplateMaterialization,
} from "../src";
import {
  FULL_CATALOG_EXCLUDED_KEYS,
  FULL_CATALOG_ROLE_KEYS,
} from "../src/roles/template-materialization";

const KEYS = ["billing.clearinghouse.read", "billing.clearinghouse.admin"] as const;
const MIRROR = allPermissionMirrorRows().map((r) => ({ key: r.key, category: r.category }));
const PLANNED = planRoleTemplateMaterialization({
  templates: ROLE_TEMPLATES,
  existingRoleKeys: new Set<string>(),
  mirror: MIRROR,
});

describe("billing.clearinghouse.read / .admin", () => {
  it("are minted as ordinary billing keys, separate from the provider-entity-scoped MAC credential keys", () => {
    for (const key of KEYS) {
      expect(M23_CONTRIBUTED_PERMISSIONS).toHaveProperty([key]);
      expect(MIRROR.find((p) => p.key === key)?.category).toBe("billing");
    }
    expect(M23_CONTRIBUTED_PERMISSIONS["billing.mac_credential.admin"].abac).toBe(
      "provider_entity_billing_scope",
    );
    expect(M23_CONTRIBUTED_PERMISSIONS["billing.clearinghouse.admin"].abac).toBe("none");
  });

  it("reach exactly the org-wide admin roles: org_admin and administrator, through the full catalog", () => {
    expect([...FULL_CATALOG_ROLE_KEYS].sort()).toEqual(["administrator", "org_admin"]);
    for (const key of KEYS) expect(FULL_CATALOG_EXCLUDED_KEYS.has(key)).toBe(false);
    const holders = PLANNED.filter((r) => KEYS.every((k) => r.permissionKeys.includes(k))).map(
      (r) => r.key,
    );
    expect(holders.sort()).toEqual(["administrator", "org_admin"]);
  });

  it("are held by no other tenant role template, floor or explicit grant", () => {
    for (const role of PLANNED) {
      if (FULL_CATALOG_ROLE_KEYS.has(role.key)) continue;
      for (const key of KEYS) expect(role.permissionKeys).not.toContain(key);
    }
    for (const t of ROLE_TEMPLATES) {
      for (const key of KEYS) {
        expect([...t.floor, ...(t.grants ?? [])]).not.toContain(key);
      }
    }
  });
});
