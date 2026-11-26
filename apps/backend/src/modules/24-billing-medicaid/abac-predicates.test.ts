import type { AbacContext, AbacTarget } from "@chartwarden/auth";
import { describe, expect, it, vi } from "vitest";
import {
  type ReadingM24AbacDeps,
  type ReadingM24AbacResolver,
  buildM24AbacPredicates,
} from "./abac-predicates";

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

describe("M24 CHC preparation ABAC fails closed", () => {
  const otherPatientId = "66666666-6666-4666-8666-666666666666";
  const otherProviderEntityId = "77777777-7777-4777-8777-777777777777";
  const target = { medicaidChcPricingPreparationId: preparationId };

  type ScopeFacts = { providerEntityId: string; patientId: string } | null;
  type CaseloadCheck = NonNullable<ReadingM24AbacDeps["isInCaseload"]>;
  const predicateFor = (
    facts: ScopeFacts,
    isInCaseload: CaseloadCheck = vi.fn(async () => true),
  ) => {
    const loadChcPreparationScope = vi.fn(async () => facts);
    const predicate = buildM24AbacPredicates({
      resolver: { ...resolver, loadChcPreparationScope },
      isInCaseload,
    }).medicaid_chc_pricing_preparation_in_scope!;
    return { predicate, loadChcPreparationScope, isInCaseload };
  };

  it("loads the scope under the actor's organization and the target's preparation id", async () => {
    const { predicate, loadChcPreparationScope } = predicateFor({ providerEntityId, patientId });

    await predicate(baseContext, target);

    expect(loadChcPreparationScope).toHaveBeenCalledTimes(1);
    expect(loadChcPreparationScope).toHaveBeenCalledWith(
      { organizationId: orgId, userId: baseContext.userId },
      preparationId,
    );
  });

  it("allows the patient's own session without consulting the caseload", async () => {
    const { predicate, isInCaseload } = predicateFor({ providerEntityId, patientId });
    const context = { ...baseContext, attributes: { sessionPatientId: patientId } };

    await expect(predicate(context, target)).resolves.toBe(true);
    expect(isInCaseload).not.toHaveBeenCalled();
  });

  it("denies a session bound to a different patient when the caseload does not include the patient", async () => {
    const { predicate, isInCaseload } = predicateFor(
      { providerEntityId, patientId },
      vi.fn(async () => false),
    );
    const context = { ...baseContext, attributes: { sessionPatientId: otherPatientId } };

    await expect(predicate(context, target)).resolves.toBe(false);
    expect(isInCaseload).toHaveBeenCalledTimes(1);
  });

  const badTargets: readonly (readonly [string, AbacTarget])[] = [
    ["is missing", {}],
    ["is an empty string", { medicaidChcPricingPreparationId: "" }],
    ["is not a string", { medicaidChcPricingPreparationId: 42 }],
  ];

  it.each(badTargets)(
    "denies without any lookup when the preparation id %s",
    async (_label, badTarget) => {
      const { predicate, loadChcPreparationScope, isInCaseload } = predicateFor({
        providerEntityId,
        patientId,
      });

      await expect(predicate(baseContext, badTarget)).resolves.toBe(false);
      expect(loadChcPreparationScope).not.toHaveBeenCalled();
      expect(isInCaseload).not.toHaveBeenCalled();
    },
  );

  it("denies when the resolver finds no preparation, even for an org-wide role", async () => {
    const { predicate, isInCaseload } = predicateFor(null);
    const context = { ...baseContext, roles: ["org_admin"] };

    await expect(predicate(context, target)).resolves.toBe(false);
    expect(isInCaseload).not.toHaveBeenCalled();
  });

  it("denies when the caseload lookup throws", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("caseload store unavailable");
    });
    const { predicate } = predicateFor({ providerEntityId, patientId }, throwing);

    await expect(predicate(baseContext, target)).resolves.toBe(false);
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it("denies when no caseload provider is bound", async () => {
    const predicate = buildM24AbacPredicates({
      resolver: {
        ...resolver,
        loadChcPreparationScope: async () => ({ providerEntityId, patientId }),
      },
    }).medicaid_chc_pricing_preparation_in_scope!;

    await expect(predicate(baseContext, target)).resolves.toBe(false);
  });

  it("denies a session with no user id even when the caseload would allow it", async () => {
    const { predicate, isInCaseload } = predicateFor({ providerEntityId, patientId });
    const context = { ...baseContext, userId: "" };

    await expect(predicate(context, target)).resolves.toBe(false);
    expect(isInCaseload).not.toHaveBeenCalled();
  });

  const allowingContexts: readonly (readonly [string, AbacContext])[] = [
    ["a caseload hit", baseContext],
    ["an org-wide role", { ...baseContext, roles: ["org_admin"] }],
    ["the patient's own session", { ...baseContext, attributes: { sessionPatientId: patientId } }],
  ];

  it.each(allowingContexts)(
    "denies %s when the preparation's provider entity is outside the actor's scope",
    async (_label, context) => {
      const { predicate, isInCaseload } = predicateFor({
        providerEntityId: otherProviderEntityId,
        patientId,
      });

      await expect(predicate(context, target)).resolves.toBe(false);
      expect(isInCaseload).not.toHaveBeenCalled();
    },
  );
});
