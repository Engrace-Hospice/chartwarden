import type { AbacContext } from "@chartwarden/auth";
import { describe, expect, it, vi } from "vitest";
import { type ReadingM24AbacResolver, buildM24AbacPredicates } from "./abac-predicates";

const preparationId = "11111111-1111-4111-8111-111111111111";
const providerEntityId = "22222222-2222-4222-8222-222222222222";
const patientId = "33333333-3333-4333-8333-333333333333";
const orgId = "44444444-4444-4444-8444-444444444444";

const baseContext: AbacContext = {
  organizationId: orgId,
  userId: "55555555-5555-4555-8555-555555555555",
  roles: ["billing_manager"],
  providerEntityIds: [providerEntityId],
  locationIds: [],
  attributes: {},
};

const resolver: ReadingM24AbacResolver = {
  async loadClaim() {
    return null;
  },
  async loadArrangementPe() {
    return null;
  },
  async loadRbDayPe() {
    return null;
  },
  async loadResultRuleKey() {
    return null;
  },
  async loadChcPreparationScope() {
    return { providerEntityId, patientId };
  },
};

describe("M24 CHC preparation patient/provider ABAC", () => {
  it("requires the stored provider scope and patient caseload, with the shared org-wide role exception", async () => {
    const isInCaseload = vi.fn(async () => false);
    const predicate = buildM24AbacPredicates({ resolver, isInCaseload })
      .medicaid_chc_pricing_preparation_in_scope!;
    const target = { medicaidChcPricingPreparationId: preparationId };

    await expect(predicate(baseContext, target)).resolves.toBe(false);
    expect(isInCaseload).toHaveBeenCalledWith({
      organizationId: orgId,
      userId: baseContext.userId,
      patientId,
    });

    isInCaseload.mockResolvedValue(true);
    await expect(predicate(baseContext, target)).resolves.toBe(true);
    await expect(predicate({ ...baseContext, providerEntityIds: [] }, target)).resolves.toBe(false);

    isInCaseload.mockClear();
    await expect(predicate({ ...baseContext, roles: ["org_admin"] }, target)).resolves.toBe(true);
    expect(isInCaseload).not.toHaveBeenCalled();
  });
});
