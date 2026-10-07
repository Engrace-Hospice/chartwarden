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
  occurrenceSpans: [{ code: "77", from: "2026-03-01", through: "2026-03-06" }],
} as const;

const ACK_BASE = {
  organizationId: "org-1",
  claimId: "",
  submissionId: "sub-1",
  ackFileUri: "s3://acks/one",
  reasonCodes: [],
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

  it("passes the payer's STC02 / GS04 / ISA09 dates through, and refuses a malformed one", async () => {
    let body: unknown = [];
    const gateway = createM23LaunchGateway(config, {
      request: async () => ({ status: 200, body }),
    });
    body = [
      {
        ...ACK_BASE,
        outcome: "accepted",
        payerClaimControlNumber: "ICN-1",
        statusEffectiveDate: "2026-03-07",
      },
    ];
    expect(await gateway.x12.parse277ca({ macJurisdiction: "ngs_j6", rawFileUri: "u" })).toEqual(
      body,
    );
    body = [
      {
        ...ACK_BASE,
        claimControlNumber: "c",
        accepted: true,
        functionalGroupDate: "2026-03-08",
        interchangeDate: null,
      },
    ];
    expect(await gateway.x12.parse999({ macJurisdiction: "ngs_j6", rawFileUri: "u" })).toEqual(
      body,
    );
    // Pre-date gateways omit the dates entirely: still valid (the notice falls back to our receipt date).
    body = [{ ...ACK_BASE, outcome: "rejected", payerClaimControlNumber: "" }];
    expect(await gateway.x12.parse277ca({ macJurisdiction: "ngs_j6", rawFileUri: "u" })).toEqual(
      body,
    );
    body = [
      {
        ...ACK_BASE,
        outcome: "accepted",
        payerClaimControlNumber: "",
        statusEffectiveDate: "2026-02-30",
      },
    ];
    await expect(
      gateway.x12.parse277ca({ macJurisdiction: "ngs_j6", rawFileUri: "u" }),
    ).rejects.toThrow("invalid 277CA response");
  });
});
