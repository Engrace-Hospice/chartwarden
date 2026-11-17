import { describe, expect, it, vi } from "vitest";

vi.mock("@chartwarden/tenancy", () => ({
  withOrgContext: async (_db: unknown, _context: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn(_db),
}));

import { stageVerifiedClaimMdEra } from "../claimmd-era-stage";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROVIDER = "22222222-2222-4222-8222-222222222222";

describe("Claim.MD stage legacy envelope guard", () => {
  it("holds when a historical advice row has the same ISA13/ST02 but no GS provenance", async () => {
    const query = {
      from: () => query,
      where: () => query,
      limit: async () => [{ id: "33333333-3333-4333-8333-333333333333" }],
    };
    const tx = {
      execute: vi.fn(async () => undefined),
      select: vi.fn(() => query),
      insert: vi.fn(),
    };
    const cipher = { seal: vi.fn(() => Buffer.from("unused")) };

    const result = await stageVerifiedClaimMdEra({
      tenantDb: tx as never,
      source: {
        inboxId: "44444444-4444-4444-8444-444444444444",
        accountReference: "synthetic-account",
        usage: "test",
        eraId: "1",
        fileIndex: 0,
        digest: "a".repeat(64),
        fileDigest: "b".repeat(64),
        resolutionId: "synthetic-resolution",
        resolutionVersion: 1,
        idempotencyKey: "c".repeat(64),
        contentDigest: "d".repeat(64),
        paymentTraceDigest: null,
        interchangeControlNumber: "000000001",
        interchangeSenderCode: "SENDER",
        interchangeReceiverCode: "RECEIVER",
        functionalGroupControlNumber: "77",
        transactionSetControlNumber: "0001",
        evidenceCodes: ["EXACT_PAYEE_NPI"],
      },
      owner: { organizationId: ORG, providerEntityId: PROVIDER, locationId: null },
      duplicateFacts: { paymentTrace: null, paymentAmount: null, contentDigest: "d".repeat(64) },
      protectedDetails: {},
      protectedCipher: cipher as never,
      protectedKeyId: "synthetic-key",
      verifyCapturedSource: async () => true,
      verifyProviderAndLocation: async () => true,
    });

    expect(result).toEqual({ outcome: "held", reason: "LEGACY_IDENTITY_AMBIGUOUS" });
    expect(tx.select).toHaveBeenCalledOnce();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(cipher.seal).not.toHaveBeenCalled();
  });
});
