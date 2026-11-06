import { describe, expect, it } from "vitest";
import { claimMdIdentityResolutionEnabled, claimMdInboxKeyRingFromEnv } from "./config";

const b64 = Buffer.alloc(32, 7).toString("base64url");

describe("Claim.MD resolver runtime config", () => {
  it("requires an explicit true switch and fails closed on malformed values", () => {
    expect(claimMdIdentityResolutionEnabled({})).toBe(false);
    expect(claimMdIdentityResolutionEnabled({ CLAIMMD_IDENTITY_RESOLUTION_ENABLED: "1" })).toBe(false);
    expect(claimMdIdentityResolutionEnabled({ CLAIMMD_IDENTITY_RESOLUTION_ENABLED: "yes" })).toBe(false);
    expect(claimMdIdentityResolutionEnabled({ CLAIMMD_IDENTITY_RESOLUTION_ENABLED: " TRUE " })).toBe(true);
  });

  it("parses only a complete key ring with active 32-byte keys", () => {
    expect(claimMdInboxKeyRingFromEnv({ CLAIMMD_RESPONSE_INBOX_KEYRING: JSON.stringify({ activeId: "k2", keys: { k1: b64, k2: b64 } }) }))
      .toMatchObject({ activeId: "k2" });
    expect(claimMdInboxKeyRingFromEnv({ CLAIMMD_RESPONSE_INBOX_KEYRING: JSON.stringify({ activeId: "absent", keys: { k1: b64 } }) })).toBeNull();
    expect(claimMdInboxKeyRingFromEnv({ CLAIMMD_RESPONSE_INBOX_KEYRING: JSON.stringify({ activeId: "k1", keys: { k1: "short" } }) })).toBeNull();
    expect(claimMdInboxKeyRingFromEnv({ CLAIMMD_RESPONSE_INBOX_KEYRING: "not-json" })).toBeNull();
  });
});
