import { describe, expect, it, vi } from "vitest";
import { createClaimMdAckDispatcher } from "./service";

describe("Claim.MD acknowledgment delivery failures", () => {
  it("retries a missing or unreadable event without letting it block the rest of a batch", async () => {
    const first = { eventId: "00000000-0000-4000-8000-000000000001", leaseToken: "one", attemptNumber: 1 };
    const second = { eventId: "00000000-0000-4000-8000-000000000002", leaseToken: "two", attemptNumber: 1 };
    const retry = vi.fn(async () => {});
    const dispatcher = createClaimMdAckDispatcher({ db: {} as never, mode: "shadow",
      evidenceCipher: {} as never, commercialOutbox: {} as never,
      source: { claim: async () => [first, second], load: async (lease) => {
        if (lease.eventId === first.eventId) throw new Error("sensitive source failure");
        return null;
      }, complete: vi.fn(async () => true), retry } });
    expect(await dispatcher.runOnce()).toEqual({ recorded: 0, duplicates: 0, failures: 2 });
    expect(retry).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenCalledWith(first, "SOURCE_UNAVAILABLE");
    expect(retry).toHaveBeenCalledWith(second, "SOURCE_UNAVAILABLE");
  });
});
