import { describe, expect, it } from "vitest";
import { medicaidClaimFactsPort } from "../medicaid-claim-facts";

const ORG = "org-1";
const ok = {
  claimContext: async () => ({ serviceState: "ZZ", mcoId: null, providerEntityId: "pe-1" }),
  patientIdForClaim: async () => "patient-1",
};

describe("medicaidClaimFactsPort", () => {
  it("resolves provider entity and patient through the seam", async () => {
    const facts = await medicaidClaimFactsPort(ORG, () => ok).byId({}, "c1");
    expect(facts).toEqual({ id: "c1", providerEntityId: "pe-1", patientId: "patient-1" });
  });
  it("is null when the claim is absent", async () => {
    const view = () => ({ ...ok, claimContext: async () => null });
    expect(await medicaidClaimFactsPort(ORG, view).byId({}, "c1")).toBeNull();
  });
  it("is null when the patient cannot be resolved", async () => {
    const view = () => ({ ...ok, patientIdForClaim: async () => null });
    expect(await medicaidClaimFactsPort(ORG, view).byId({}, "c1")).toBeNull();
  });
  it("fails closed when the seam throws (deny-stub / not registered)", async () => {
    const view = () => {
      throw new Error("seam denied");
    };
    expect(await medicaidClaimFactsPort(ORG, view).byId({}, "c1")).toBeNull();
  });
});
