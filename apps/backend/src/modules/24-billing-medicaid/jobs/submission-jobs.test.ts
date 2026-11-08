import { describe, expect, it, vi } from "vitest";
import { runClaimPoll } from "./submission-jobs";

describe("M24 claim poll route readiness", () => {
  it("does not resolve credentials or call a state adapter for an uncertified route", async () => {
    const claim = {
      id: "11111111-1111-4111-8111-111111111111",
      organizationId: "22222222-2222-4222-8222-222222222222",
      providerEntityId: "33333333-3333-4333-8333-333333333333",
      serviceState: "OR",
      mcoId: null,
      state: "POLLING",
    };
    const submission = {
      result: "pending_async",
      vendorTransactionId: "synthetic-transaction-reference",
    };
    let selects = 0;
    const tx = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit: async () => (selects++ === 0 ? [claim] : [submission]),
                };
              },
            };
          },
        };
      },
    };
    const adapterForState = vi.fn();
    const resolveCredentials = vi.fn();

    await runClaimPoll(
      tx as never,
      {
        now: () => new Date("2026-11-08T00:00:00.000Z"),
        adapters: { adapterForState },
        credentials: { resolve: resolveCredentials },
      } as never,
      {
        organizationId: claim.organizationId,
        claimId: claim.id,
        submissionId: "44444444-4444-4444-8444-444444444444",
      },
    );

    expect(selects).toBe(2);
    expect(adapterForState).not.toHaveBeenCalled();
    expect(resolveCredentials).not.toHaveBeenCalled();
  });
});
