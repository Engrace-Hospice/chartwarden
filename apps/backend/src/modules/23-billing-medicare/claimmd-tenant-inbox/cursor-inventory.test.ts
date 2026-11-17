import { describe, expect, it } from "vitest";
import { classifyLegacyTenantClaimMdCursor } from "./cursor-inventory";

describe("tenant Claim.MD historical cursor inventory", () => {
  it("preserves each provider/stage coordinate and never derives an account cursor from their numeric maximum", () => {
    const updatedAt = new Date("2026-11-01T00:00:00Z");
    const first = classifyLegacyTenantClaimMdCursor({
      organizationId: "org-a",
      providerEntityId: "provider-a",
      vendor: "claimmd@tenant",
      usage: "production",
      kind: "ack_999",
      cursor: "900",
      version: 4,
      updatedAt,
    });
    const second = classifyLegacyTenantClaimMdCursor({
      organizationId: "org-a",
      providerEntityId: "provider-b",
      vendor: "claimmd@tenant",
      usage: "production",
      kind: "ack_277ca",
      cursor: "120",
      version: 2,
      updatedAt,
    });
    expect(first).toMatchObject({
      accountIdentityId: null,
      comparableWithOtherLegacyCoordinates: false,
      classification: "legacy_only",
      currentPollerOwner: "runTransportAckPull",
      lastSuccessfulProcessingAt: null,
      cursor: "900",
    });
    expect(second).toMatchObject({
      accountIdentityId: null,
      comparableWithOtherLegacyCoordinates: false,
      classification: "legacy_only",
      currentPollerOwner: "runTransportAckPull",
      lastSuccessfulProcessingAt: null,
      cursor: "120",
    });
  });

  it("excludes other vendors and malformed legacy coordinates", () => {
    expect(
      classifyLegacyTenantClaimMdCursor({
        organizationId: "o",
        providerEntityId: "p",
        vendor: "stedi",
        usage: "production",
        kind: "ack_999",
        cursor: "1",
        version: 1,
        updatedAt: new Date(),
      }),
    ).toBeNull();
    expect(
      classifyLegacyTenantClaimMdCursor({
        organizationId: "o",
        providerEntityId: "p",
        vendor: "claimmd@tenant",
        usage: "unknown",
        kind: "ack_999",
        cursor: "1",
        version: 1,
        updatedAt: new Date(),
      }),
    ).toBeNull();
  });
});
