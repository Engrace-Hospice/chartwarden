import { describe, expect, it } from "vitest";
import { type GatewayHttpRequest, createM23LaunchGateway } from "./launch-gateway";

const config = {
  x12BaseUrl: "https://x12.invalid",
  x12BearerToken: "x12-token",
  macBaseUrl: "https://mac.invalid",
  macBearerToken: "mac-token",
  timeoutMs: 5000,
};

const CLAIM_DOCUMENT = {
  claimId: "claim-1",
  claimControlNumber: "control-1",
  tob: "811",
  serviceFrom: "2026-03-01",
  serviceTo: "2026-03-20",
  dischargeCodes: {
    patientStatus: "40",
    conditionCodes: [],
    occurrenceCodes: [{ code: "55", date: "2026-03-20" }],
  },
} as const;

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
      claimDocument: CLAIM_DOCUMENT,
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
    // The discharge claim codes reach the gateway in the generate-837i body (CL103 / HI*BG / HI*BH source).
    expect((seen[0]?.body as { claimDocument?: unknown }).claimDocument).toEqual(CLAIM_DOCUMENT);
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
        claimDocument: CLAIM_DOCUMENT,
      }),
    ).rejects.toThrow("invalid generation response");
  });
});
