import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { transportUpload } from "./clearinghouse-submission";

const x12 = readFileSync(new URL("../../../../../../packages/x12-837-client/src/clearinghouse/__fixtures__/stedi-claim.x12", import.meta.url), "utf8");
const context = { organizationId: "00000000-0000-4000-8000-000000000001", providerEntityId: "00000000-0000-4000-8000-000000000002",
  payerId: "payer-context-is-not-used-as-evidence", correlationId: "correlation-synthetic", usage: "test" as const, billingNpi: "1234567893" };

function makeTransport(order: string[], reserve: (input: unknown) => Promise<string> = async () => "evidence-synthetic") {
  return {
    binding: { vendor: "claimmd", transport: { submitClaim: vi.fn(async () => {
      order.push("upload");
      return { ok: true as const, data: { clearinghouseSubmissionId: "claim-synthetic", idempotencyKey: "k", controlNumber: "WXHOSP0001", receivedAt: new Date().toISOString(), replayed: false } };
    }), submitNotice: vi.fn() } },
    contexts: { contextFor: async () => context, providerEntitiesFor: async () => [] },
    claimMdEvidence: { accountReference: "acct-synthetic", usage: "test" as const,
      reserve: async (input: unknown) => { order.push("reserve"); return reserve(input); },
      observe: async () => { order.push("observe"); } },
  } as never;
}

describe("M23 Claim.MD evidence boundary", () => {
  const request = { organizationId: context.organizationId, providerEntityId: context.providerEntityId, kind: "claim_837i" as const,
    x12, controlNumber: "WXHOSP0001", claimId: "00000000-0000-4000-8000-000000000003",
    submissionId: "00000000-0000-4000-8000-000000000004", attemptIndex: 0 };

  it("commits evidence before upload and appends the receipt afterward", async () => {
    const order: string[] = [];
    const result = await transportUpload(makeTransport(order))(request);
    expect(result.accepted).toBe(true);
    expect(order).toEqual(["reserve", "upload", "observe"]);
  });

  it("fails closed before upload when evidence reservation fails", async () => {
    const order: string[] = [];
    const upload = transportUpload(makeTransport(order, async (_input: unknown) => { throw new Error("storage unavailable"); }));
    await expect(upload(request)).rejects.toThrow(/Claim\.MD|claim/i);
    expect(order).toEqual(["reserve"]);
  });
});
