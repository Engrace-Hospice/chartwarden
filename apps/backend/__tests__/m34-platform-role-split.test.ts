// CW-AC-22 - the platform_ops split. Each onboarding power the role used to hold together (the signed-BAA upload and the platform BAA
// register write, go-live approval, tenant pricing) has a role of its own and a predicate that admits THAT role alone, so a key on
// platform_ops (a grant that outlived migration 1559) or on a billing role opens nothing. The reader predicate admits the four
// onboarding roles. Superadmin, which stands for every role by design, passes all of them through the role expansion.
import {
  PLATFORM_DUTY_ROLE_KEYS,
  PLATFORM_ONBOARDING_ROLE_KEYS,
  PLATFORM_OPS_ROLE_KEYS,
  expandSuperadminRoles,
} from "@chartwarden/auth";
import type { AbacContext, AbacTarget } from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import {
  M34_ABAC_PREDICATES,
  type TenantPlatformAbacResolver,
  buildTenantPlatformAbacPredicates,
} from "../src/modules/34-saas-tenant-platform/abac-predicates";
import { buildM35AbacPredicates } from "../src/modules/35-subscription/abac-predicates";

const resolver: TenantPlatformAbacResolver = {
  async hasActiveConsentedSupportSession() {
    return false;
  },
  async loadConsentGrant() {
    return null;
  },
  async loadFeatureFlag() {
    return null;
  },
  async loadOnboardingTask() {
    return null;
  },
};
const predicates = buildTenantPlatformAbacPredicates({ resolver, isInCaseload: async () => false });
const TARGET: AbacTarget = {};

function contextFor(roles: readonly string[]): AbacContext {
  return {
    userId: "u-1",
    organizationId: "10000000-0000-4000-8000-000000000001",
    roles: [...roles],
    attributes: {},
  } as unknown as AbacContext;
}

const OWN_ROLE = {
  tenant_platform_baa_steward: "platform_baa_steward",
  tenant_platform_go_live_approver: "platform_go_live_approver",
  tenant_platform_pricing_operator: "platform_pricing_operator",
} as const;

const NOT_THE_ROLE: readonly (readonly string[])[] = [
  ["platform_ops"],
  ["platform_owner"],
  ["platform_admin"],
  ["platform_billing_admin"],
  ["org_admin"],
  ["compliance_officer"],
  [],
];

async function admits(name: string, roles: readonly string[]): Promise<boolean> {
  const predicate = predicates[name];
  if (!predicate) throw new Error(`predicate ${name} is not built`);
  return predicate(contextFor(roles), TARGET);
}

describe("CW-AC-22 predicates", () => {
  it("are listed in the names M34 registers", () => {
    for (const name of [...Object.keys(OWN_ROLE), "tenant_platform_onboarding_staff"]) {
      expect(M34_ABAC_PREDICATES).toContain(name);
      expect(predicates[name]).toBeTypeOf("function");
    }
  });

  for (const [name, role] of Object.entries(OWN_ROLE)) {
    it(`${name} admits ${role} and no other role`, async () => {
      expect(await admits(name, [role])).toBe(true);
      expect(await admits(name, ["registered_nurse", role])).toBe(true);
      for (const roles of NOT_THE_ROLE) {
        expect(await admits(name, roles), roles.join(",")).toBe(false);
      }
    });

    it(`${name} admits a superadmin (the role that stands for every platform role)`, async () => {
      expect(await admits(name, expandSuperadminRoles(["superadmin"]))).toBe(true);
    });
  }

  it("tenant_platform_onboarding_staff admits exactly the four onboarding roles", async () => {
    for (const role of PLATFORM_ONBOARDING_ROLE_KEYS) {
      expect(await admits("tenant_platform_onboarding_staff", [role]), role).toBe(true);
    }
    for (const roles of [
      ["platform_owner"],
      ["platform_admin"],
      ["platform_billing_admin"],
      ["platform_support_t2"],
      ["platform_sales"],
      ["org_admin"],
      [],
    ]) {
      expect(await admits("tenant_platform_onboarding_staff", roles), roles.join(",")).toBe(false);
    }
  });

  it("platform_billing_scope admits the two duty roles that read pricing, and not the BAA steward; the duty roles are outside the six-role set the other role-set predicates read", async () => {
    const billing = buildM35AbacPredicates().platform_billing_scope;
    if (!billing) throw new Error("platform_billing_scope is not built");
    const admits = async (role: string) => Boolean(await billing(contextFor([role]), TARGET));
    expect(await admits("platform_pricing_operator")).toBe(true);
    expect(await admits("platform_go_live_approver")).toBe(true);
    expect(await admits("platform_baa_steward")).toBe(false);
    for (const role of ["platform_ops", "platform_owner", "platform_billing_admin"]) {
      expect(await admits(role), role).toBe(true);
    }
    // the six-role admit-set that M2 (organization lifecycle, cross-tenant reads), M29, M33 and the Claim.MD ops routes read
    for (const role of PLATFORM_DUTY_ROLE_KEYS) {
      expect(PLATFORM_OPS_ROLE_KEYS as readonly string[]).not.toContain(role);
    }
  });

  it("platform_ops keeps its own predicate and is NOT admitted by the three duty predicates", async () => {
    expect(await admits("tenant_lifecycle_platform_ops", ["platform_ops"])).toBe(true);
    for (const role of Object.values(OWN_ROLE)) {
      expect(await admits("tenant_lifecycle_platform_ops", [role]), role).toBe(false);
    }
  });
});
