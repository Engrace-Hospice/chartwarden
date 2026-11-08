import { describe, expect, it } from "vitest";
import { claimMdAckMode } from "./config";

describe("Claim.MD acknowledgment dispatcher flags", () => {
  it("defaults off and rejects anything but exact true", () => {
    expect(claimMdAckMode({})).toBe("off");
    expect(claimMdAckMode({ CLAIMMD_ACK_DISPATCH_ENABLED: "TRUE" })).toBe("off");
    expect(claimMdAckMode({ CLAIMMD_ACK_SHADOW_ENABLED: "1" })).toBe("off");
  });
  it("keeps shadow and apply separate", () => {
    expect(claimMdAckMode({ CLAIMMD_ACK_SHADOW_ENABLED: "true" })).toBe("shadow");
    expect(claimMdAckMode({ CLAIMMD_ACK_DISPATCH_ENABLED: "true" })).toBe("apply");
    expect(() =>
      claimMdAckMode({ CLAIMMD_ACK_SHADOW_ENABLED: "true", CLAIMMD_ACK_DISPATCH_ENABLED: "true" }),
    ).toThrow("CLAIMMD_ACK_MODE_CONFLICT");
  });
});
