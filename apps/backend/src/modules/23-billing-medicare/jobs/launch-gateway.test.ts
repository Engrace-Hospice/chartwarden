import { describe, expect, it } from "vitest";
import { type GatewayHttpRequest, createM23LaunchGateway } from "./launch-gateway";

const config = {
  x12BaseUrl: "https://x12.invalid",
  x12BearerToken: "x12-token",
  macBaseUrl: "https://mac.invalid",
  macBearerToken: "mac-token",
  timeoutMs: 5000,
};

describe("M23 launch gateway", () => {
  it("submits and parses acknowledgments through a credential-isolated transport", async () => {
    const seen: GatewayHttpRequest[] = [];
    const gateway = createM23LaunchGateway(config, {
      async request(input) {
        seen.push(input);
        if (input.path === "/generate-837i") {
          return { status: 200, body: { x12: "ISA*...~", correlationId: "corr-1" } };
        }
        if (input.path === "/uploads") {
          return { status: 202, body: { accepted: true, generatedFileUri: "s3://claims/one" } };
        }
        return { status: 200, body: [] };
      },
    });
    const generated = await gateway.x12.generate837i({
      organizationId: "org-1",
      claimId: "claim-1",
      claimControlNumber: "control-1",
    });
    const uploaded = await gateway.macPortal.upload({
      organizationId: "org-1",
      providerEntityId: "provider-1",
      kind: "claim_837i",
      x12: generated.x12,
      controlNumber: "control-1",
    });
    expect(uploaded.accepted).toBe(true);
    expect(seen.map((request) => request.bearerToken)).toEqual(["x12-token", "mac-token"]);
  });

  it("rejects malformed gateway output without echoing the body", async () => {
    const gateway = createM23LaunchGateway(config, {
      request: async () => ({ status: 200, body: { secret: "must-not-surface" } }),
    });
    await expect(
      gateway.x12.generate837i({
        organizationId: "org-1",
        claimId: "claim-1",
        claimControlNumber: "control-1",
      }),
    ).rejects.toThrow("invalid generation response");
  });
});
