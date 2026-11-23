import { afterEach, describe, expect, it, vi } from "vitest";
import { medicaidClaimFactsPort, medicaidEraEnrollmentEvidence } from "../medicaid-claim-facts";

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

describe("medicaid ERA enrollment seam", () => {
  it("reads account evidence only for the server-selected organization and provider entity", async () => {
    const view = vi.fn(async (organizationId: string, providerEntityId: string) => [
      {
        organizationId,
        providerEntityId,
        vendor: "claimmd" as const,
        accountReference: "synthetic-test-account",
        environment: "test" as const,
        canonicalPayerId: "payer-id",
        programId: "classification-id",
        payerIdentifier: "synthetic-payer-id",
        billingNpi: "1234567893",
        billingTin: null,
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
        evidenceReference: "approval:synthetic-era-enrollment",
        verifiedAt: "2026-01-01T00:00:00.000Z",
        evidenceFreshUntil: "2026-12-31T00:00:00.000Z",
      },
    ]);
    await expect(
      medicaidEraEnrollmentEvidence("org-1", "provider-1", () => ({ eraEnrollmentEvidence: view })),
    ).resolves.toMatchObject([
      { organizationId: "org-1", providerEntityId: "provider-1", environment: "test" },
    ]);
    expect(view).toHaveBeenCalledWith("org-1", "provider-1");
  });
});
