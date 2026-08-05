import { describe, expect, it } from "vitest";
import { createNgsJ6PortalClient } from "./ngs-j6";

const submitter = {
  organizationId: "org-1",
  providerEntityId: "provider-1",
  submitterId: "submitter-1",
  jurisdiction: "ngs_j6" as const,
};

describe("NgsJ6PortalClient", () => {
  it("submits a file through the injected authenticated transport", async () => {
    const requests: string[] = [];
    const client = createNgsJ6PortalClient({
      async request(input) {
        requests.push(input.path);
        return {
          status: 202,
          body: { portalSubmissionId: "portal-1", acceptedAt: "2026-08-04T12:00:00.000Z" },
        };
      },
    });

    const result = await client.submitFile({
      submitter,
      claimId: "claim-1",
      fileContents: "ISA*...~",
    });
    expect(requests).toEqual(["/submissions"]);
    expect(result).toMatchObject({ ok: true, data: { portalSubmissionId: "portal-1" } });
  });

  it("does not expose transport errors", async () => {
    const client = createNgsJ6PortalClient({
      request: async () => Promise.reject(new Error("credential=do-not-leak")),
    });
    await expect(client.pollStatus({ submitter, portalSubmissionId: "portal-1" })).resolves.toEqual(
      {
        ok: false,
        degraded: { code: "MAC_PORTAL_NOT_WIRED", reason: "ngs_j6 portal transport unavailable" },
      },
    );
  });
});
