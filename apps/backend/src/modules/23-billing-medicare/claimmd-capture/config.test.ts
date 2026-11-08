import { describe, expect, it } from "vitest";
import { claimMdResponseCaptureEnabled, shouldRunLegacyClaimMdAckPoll } from "./config";

describe("Claim.MD response capture configuration", () => {
  it("is disabled unless the exact explicit opt-in is set", () => {
    for (const value of [undefined, "", "TRUE", " true", "1", "yes", "false"]) {
      expect(claimMdResponseCaptureEnabled({ CLAIMMD_RESPONSE_CAPTURE_ENABLED: value })).toBe(
        false,
      );
    }
    expect(claimMdResponseCaptureEnabled({ CLAIMMD_RESPONSE_CAPTURE_ENABLED: "true" })).toBe(true);
  });
});

describe("Claim.MD legacy acknowledgment poll coordination", () => {
  it("disables only provider-scoped Claim.MD polling while account capture is active", () => {
    expect(shouldRunLegacyClaimMdAckPoll({ captureActive: true, vendor: "claimmd" })).toBe(false);
    expect(shouldRunLegacyClaimMdAckPoll({ captureActive: true, vendor: "stedi" })).toBe(true);
    expect(shouldRunLegacyClaimMdAckPoll({ captureActive: true, vendor: null })).toBe(true);
    expect(shouldRunLegacyClaimMdAckPoll({ captureActive: false, vendor: "claimmd" })).toBe(true);
  });

  it("also disables the legacy poller when account-wide acknowledgment dispatch is active", () => {
    expect(
      shouldRunLegacyClaimMdAckPoll({
        captureActive: false,
        dispatcherActive: true,
        vendor: "claimmd",
      }),
    ).toBe(false);
    expect(
      shouldRunLegacyClaimMdAckPoll({
        captureActive: false,
        dispatcherActive: true,
        vendor: "stedi",
      }),
    ).toBe(true);
  });
});
