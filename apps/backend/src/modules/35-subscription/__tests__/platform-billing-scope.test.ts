/**
 * ADMIN-T02 — `platform_billing_scope` admits the newly-registered platform-ops roles (§4.7 / §4.8).
 *
 * The role-catalog binding (packages/auth) is only half the fix: the M35 `platform_billing_scope` ABAC
 * predicate must actually admit a caller carrying one of those roles, and its admit-set must stay in
 * lock-step with the catalog. This test exercises the real predicate resolver (not a parallel copy) and
 * pins that `PLATFORM_BILLING_ROLES` is re-derived from `PLATFORM_OPS_ROLE_KEYS` so the two never drift.
 */
import type { AbacContext } from "@wardenx/auth";
import { PLATFORM_OPS_ROLE_KEYS } from "@wardenx/auth";
import { describe, expect, it } from "vitest";
import { buildM35AbacPredicates } from "../abac-predicates";

const ctx = (roles: readonly string[]): AbacContext => ({
  organizationId: "org-1",
  userId: "user-1",
  roles,
  providerEntityIds: [],
  locationIds: [],
  attributes: {},
});

const platformBillingScope = buildM35AbacPredicates().platform_billing_scope;

describe("ADMIN-T02 platform_billing_scope (§4.8)", () => {
  it("admits a platform_billing_admin (the §5.2 surface is reachable, not 403-for-all)", async () => {
    expect(await platformBillingScope(ctx(["platform_billing_admin"]), {})).toBe(true);
  });

  it("admits every registered platform-ops role", async () => {
    for (const role of PLATFORM_OPS_ROLE_KEYS) {
      expect(await platformBillingScope(ctx([role]), {})).toBe(true);
    }
  });

  it("denies a tenant caller carrying no platform-ops role (fail-closed)", async () => {
    expect(await platformBillingScope(ctx(["org_admin", "billing_admin"]), {})).toBe(false);
    expect(await platformBillingScope(ctx([]), {})).toBe(false);
  });
});
