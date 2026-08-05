import { describe, expect, it } from "vitest";
import { type X12WorkerHttpRequest, createX12WorkerClient } from "./client";

const submitter = {
  organizationId: "org-1",
  providerEntityId: "provider-1",
  submitterId: "submitter-1",
  jurisdiction: "ngs_j6" as const,
};

describe("LiveX12WorkerClient", () => {
  it("posts an 837I request and validates the generated envelope", async () => {
    let request: X12WorkerHttpRequest | undefined;
    const client = createX12WorkerClient({
      http: {
        async request(input) {
          request = input;
          return {
            status: 200,
            body: {
              fileContents: "ISA*...~",
              interchangeControlNumber: "000000001",
              transactionSetControlNumber: "0001",
            },
          };
        },
      },
    });

    const result = await client.generate837i({
      submitter,
      claimId: "claim-1",
      claimControlNumber: "control-1",
      claimDocument: { totalCents: 12500 },
    });

    expect(request?.path).toBe("/generate-837i");
    expect(result).toMatchObject({ ok: true, data: { interchangeControlNumber: "000000001" } });
  });

  it("fails closed on malformed or unavailable sidecar responses", async () => {
    const malformed = createX12WorkerClient({
      http: { request: async () => ({ status: 200, body: { fileContents: "" } }) },
    });
    await expect(
      malformed.parse999({ organizationId: "org-1", rawAcknowledgment: "ISA*...~" }),
    ).resolves.toMatchObject({ ok: false, degraded: { code: "X12_WORKER_INVALID_RESPONSE" } });

    const unavailable = createX12WorkerClient({
      http: { request: async () => Promise.reject(new Error("secret endpoint detail")) },
    });
    await expect(
      unavailable.parse277ca({ organizationId: "org-1", rawAcknowledgment: "ISA*...~" }),
    ).resolves.toEqual({
      ok: false,
      degraded: { code: "X12_WORKER_NOT_WIRED", reason: "x12-worker transport unavailable" },
    });
  });
});
