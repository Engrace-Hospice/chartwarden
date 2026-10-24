import { afterEach, describe, expect, it, vi } from "vitest";
import { medicaidClaimFactsPort } from "../medicaid-claim-facts";

const ORG = "org-1";
const ok = {
  claimContext: async () => ({
    serviceState: "ZZ",
    mcoId: null,
    providerEntityId: "pe-1",
    patientId: "patient-1",
  }),
};

afterEach(() => vi.restoreAllMocks());

describe("medicaidClaimFactsPort", () => {
  it("resolves provider entity and patient through one seam call", async () => {
    const facts = await medicaidClaimFactsPort(ORG, () => ok).byId({}, "c1");
    expect(facts).toEqual({ id: "c1", providerEntityId: "pe-1", patientId: "patient-1" });
  });
  it("is null when the claim is absent", async () => {
    const view = () => ({ claimContext: async () => null });
    expect(await medicaidClaimFactsPort(ORG, view).byId({}, "c1")).toBeNull();
  });
  it("logs ids only and rethrows when the seam fails (an outage is not 'not found')", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const view = () => ({
      claimContext: async () => {
        throw new Error("seam denied");
      },
    });
    await expect(medicaidClaimFactsPort(ORG, view).byId({}, "c1")).rejects.toThrow("seam denied");
    const line = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, string>;
    expect(line).toMatchObject({ level: "warn", organizationId: ORG, claimId: "c1" });
  });
});
