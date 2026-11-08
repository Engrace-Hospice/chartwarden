import { describe, expect, it } from "vitest";
import { createClaimMdEvidenceCipher } from "./cipher";

const org = "00000000-0000-4000-8000-000000000001";
const provider = "00000000-0000-4000-8000-000000000002";
const evidence = "00000000-0000-4000-8000-000000000003";
const key = Buffer.alloc(32, 7);

describe("Claim.MD submission evidence cipher", () => {
  it("round-trips a TIN under evidence-bound authenticated data", async () => {
    const cipher = createClaimMdEvidenceCipher({
      dekForOrg: async () => ({ version: "synthetic-v1", key }),
      dekForOrgVersion: async () => ({ version: "synthetic-v1", key }),
    });
    const sealed = await cipher.seal({
      evidenceId: evidence,
      organizationId: org,
      providerEntityId: provider,
      attemptKey: "attempt-synthetic",
      tin: "123456789",
    });
    expect(sealed).not.toContain("123456789");
    await expect(
      cipher.open({
        evidenceId: evidence,
        organizationId: org,
        providerEntityId: provider,
        attemptKey: "attempt-synthetic",
        sealed,
      }),
    ).resolves.toBe("123456789");
    await expect(
      cipher.open({
        evidenceId: "00000000-0000-4000-8000-000000000004",
        organizationId: org,
        providerEntityId: provider,
        attemptKey: "attempt-synthetic",
        sealed,
      }),
    ).rejects.toThrow();
  });
  it("binds notice TIN ciphertext to a separate notice evidence domain", async () => {
    const cipher = createClaimMdEvidenceCipher({
      dekForOrg: async () => ({ version: "synthetic-v1", key }),
      dekForOrgVersion: async () => ({ version: "synthetic-v1", key }),
    });
    const sealed = await cipher.seal({
      evidenceId: evidence,
      organizationId: org,
      providerEntityId: provider,
      attemptKey: "notice-attempt-synthetic",
      tin: "987654321",
      recordKind: "notice",
    });
    await expect(
      cipher.open({
        evidenceId: evidence,
        organizationId: org,
        providerEntityId: provider,
        attemptKey: "notice-attempt-synthetic",
        sealed,
        recordKind: "notice",
      }),
    ).resolves.toBe("987654321");
    await expect(
      cipher.open({
        evidenceId: evidence,
        organizationId: org,
        providerEntityId: provider,
        attemptKey: "notice-attempt-synthetic",
        sealed,
      }),
    ).rejects.toThrow();
  });
});
