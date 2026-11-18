import { describe, expect, it } from "vitest";
import {
  claimMdEraM25SerializationKey,
  classifyClaimMdEraCrossSourceDuplicate,
} from "../claimmd-era-duplicate";

const base = {
  rawFileDigest: "a".repeat(64),
  interchangeControlNumber: "000000001",
  transactionSetControlNumber: "0001",
  paymentTrace: "TRACE-SYNTH",
  paymentAmount: "125.00",
  contentDigest: "b".repeat(64),
};

describe("BIL-1.4.1B cross-source duplicate classification", () => {
  it("uses a shared transaction-lock identity for legacy M25 receive and account-scoped staging", () => {
    const identity = {
      organizationId: "tenant-a",
      providerEntityId: "provider-a",
      paymentTrace: "TRACE-SYNTH",
      interchangeControlNumber: "000000001",
      transactionSetControlNumber: "0001",
    };
    expect(claimMdEraM25SerializationKey(identity)).toBe(claimMdEraM25SerializationKey(identity));
    expect(claimMdEraM25SerializationKey({ ...identity, paymentTrace: null })).toContain(
      "ISA:::000000001|GS:|ST:0001",
    );
    expect(claimMdEraM25SerializationKey({ ...identity, organizationId: "tenant-b" })).not.toBe(
      claimMdEraM25SerializationKey(identity),
    );
  });

  it("keeps a reused ST02 distinct when its GS06 changes", () => {
    const identity = {
      organizationId: "tenant-a",
      providerEntityId: "provider-a",
      paymentTrace: null,
      interchangeControlNumber: "000000001",
      functionalGroupControlNumber: "77",
      transactionSetControlNumber: "0001",
    };
    expect(claimMdEraM25SerializationKey(identity)).not.toBe(
      claimMdEraM25SerializationKey({ ...identity, functionalGroupControlNumber: "78" }),
    );
  });

  it("recognizes exact API/manual re-import only from identical source bytes and envelope controls", () => {
    expect(classifyClaimMdEraCrossSourceDuplicate(base, [base])).toBe("exact_duplicate");
    expect(
      classifyClaimMdEraCrossSourceDuplicate(base, [{ ...base, rawFileDigest: "c".repeat(64) }]),
    ).toBe("possible_duplicate");
  });

  it("holds reused trace and amount without merging or creating another independently postable record", () => {
    expect(
      classifyClaimMdEraCrossSourceDuplicate(base, [
        {
          ...base,
          rawFileDigest: "c".repeat(64),
          interchangeControlNumber: "000000002",
          transactionSetControlNumber: "0002",
        },
      ]),
    ).toBe("possible_duplicate");
  });

  it("does not infer a duplicate from amount alone or merge distinct remittances", () => {
    expect(
      classifyClaimMdEraCrossSourceDuplicate(base, [
        {
          ...base,
          rawFileDigest: "c".repeat(64),
          interchangeControlNumber: "000000002",
          transactionSetControlNumber: "0002",
          paymentTrace: null,
        },
      ]),
    ).toBe("distinct");
    expect(
      classifyClaimMdEraCrossSourceDuplicate(
        { ...base, paymentAmount: "126.00", paymentTrace: null },
        [
          {
            ...base,
            paymentTrace: null,
            interchangeControlNumber: "000000002",
            transactionSetControlNumber: "0002",
          },
        ],
      ),
    ).toBe("distinct");
  });
});
