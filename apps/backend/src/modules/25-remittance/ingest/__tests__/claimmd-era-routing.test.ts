import { describe, expect, it } from "vitest";
import { claimMdEraRuntimeConfig, shouldRunLegacyClaimMdEraPull } from "../claimmd-era-config";
import {
  type EraProviderIdentity,
  decideClaimMdEraDuplicate,
  resolveClaimMdEraArtifact,
  resolveClaimMdEraPayee,
} from "../claimmd-era-routing";

const providers: EraProviderIdentity[] = [
  {
    organizationId: "tenant-a",
    providerEntityId: "provider-a1",
    npi: "1000000001",
    taxId: "120000001",
  },
  {
    organizationId: "tenant-a",
    providerEntityId: "provider-a2",
    npi: "1000000002",
    taxId: "120000001",
  },
  {
    organizationId: "tenant-b",
    providerEntityId: "provider-b1",
    npi: "2000000001",
    taxId: "220000001",
  },
];

describe("BIL-1.4 payee routing", () => {
  it("requires exact NPI and verifies a supplied shared TIN", () => {
    expect(resolveClaimMdEraPayee({ npi: "1000000002", taxId: "120000001" }, providers)).toEqual({
      kind: "verified",
      organizationId: "tenant-a",
      providerEntityId: "provider-a2",
    });
    expect(resolveClaimMdEraPayee({ npi: null, taxId: "120000001" }, providers)).toEqual({
      kind: "held",
      reason: "PAYEE_IDENTITY_AMBIGUOUS",
    });
    expect(resolveClaimMdEraPayee({ npi: "1000000002", taxId: "990000001" }, providers)).toEqual({
      kind: "held",
      reason: "PAYEE_IDENTITY_CONFLICT",
    });
  });

  it("holds a whole artifact with provider/tenant conflicts", () => {
    expect(
      resolveClaimMdEraArtifact(
        [
          {
            fileIndex: 0,
            transactionSetControlNumber: "001",
            payee: { npi: "1000000001", taxId: "120000001" },
          },
          {
            fileIndex: 0,
            transactionSetControlNumber: "002",
            payee: { npi: "2000000001", taxId: "220000001" },
          },
        ],
        providers,
      ),
    ).toEqual({ kind: "held", reason: "MIXED_PROVIDER_OR_TENANT" });
  });

  it("holds check trace and amount lookalikes instead of merging them", () => {
    const old = {
      sourceDigest: "a",
      interchangeControlNumber: "1",
      transactionSetControlNumber: "1",
      paymentTraceDigest: "trace",
      paymentAmountMinor: 500n,
    };
    expect(
      decideClaimMdEraDuplicate({ ...old, sourceDigest: "b", interchangeControlNumber: "2" }, [
        old,
      ]),
    ).toBe("possible_duplicate_hold");
    expect(decideClaimMdEraDuplicate(old, [old])).toBe("exact_duplicate");
  });
});

describe("BIL-1.4 independent runtime gates", () => {
  it("defaults all independent stages off and never infers one flag from another", () => {
    expect(claimMdEraRuntimeConfig({})).toEqual({
      captureEnabled: false,
      deliveryEnabled: false,
      ownershipResolutionEnabled: false,
      controlledPostingEnabled: false,
      autoPostEnabled: false,
    });
    expect(
      claimMdEraRuntimeConfig({ CLAIMMD_ERA_OWNERSHIP_RESOLUTION_ENABLED: "true" })
        .ownershipResolutionEnabled,
    ).toBe(true);
    expect(claimMdEraRuntimeConfig({ CLAIMMD_ERA_M25_DELIVERY_ENABLED: "true" })).toMatchObject({
      deliveryEnabled: true,
      captureEnabled: false,
      ownershipResolutionEnabled: false,
      autoPostEnabled: false,
    });
    expect(claimMdEraRuntimeConfig({ CLAIMMD_ERA_CAPTURE_ENABLED: "true" })).toMatchObject({
      captureEnabled: true,
      deliveryEnabled: false,
      ownershipResolutionEnabled: false,
    });
    expect(
      claimMdEraRuntimeConfig({ CLAIMMD_ERA_M25_DELIVERY_ENABLED: "TRUE" }).deliveryEnabled,
    ).toBe(false);
    expect(() => claimMdEraRuntimeConfig({ CLAIMMD_ERA_AUTO_POST_ENABLED: "true" })).toThrow();
  });
  it("cuts off only the legacy Claim.MD reader when the new capture/delivery is enabled", () => {
    expect(
      shouldRunLegacyClaimMdEraPull({
        vendor: "claimmd",
        captureEnabled: true,
        deliveryEnabled: false,
      }),
    ).toBe(false);
    expect(
      shouldRunLegacyClaimMdEraPull({
        vendor: "stedi",
        captureEnabled: true,
        deliveryEnabled: false,
      }),
    ).toBe(true);
    expect(
      shouldRunLegacyClaimMdEraPull({
        vendor: "claimmd",
        captureEnabled: false,
        deliveryEnabled: false,
      }),
    ).toBe(true);
  });
});
