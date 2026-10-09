// GAP-038 - the pure decisions inside the cap-day replay. The paging, emission and reversal behaviour is proven
// live in `apps/backend/__tests__/gap-038-cap-day-backfill.live.test.ts`.
import { describe, expect, it } from "vitest";
import { isHospiceLocRevenueCode } from "../outbox-consumers/claim-line-finalized";
import {
  REPLAY_DEFAULT_PAGE_SIZE,
  REPLAY_MAX_PAGE_SIZE,
  claimStillHoldsPayment,
  clampReplayPageSize,
} from "../services/line-finalized-replay";

describe("clampReplayPageSize", () => {
  it("defaults when unset or not finite", () => {
    expect(clampReplayPageSize(undefined)).toBe(REPLAY_DEFAULT_PAGE_SIZE);
    expect(clampReplayPageSize(Number.NaN)).toBe(REPLAY_DEFAULT_PAGE_SIZE);
  });
  it("clamps into [1, max] and floors", () => {
    expect(clampReplayPageSize(0)).toBe(1);
    expect(clampReplayPageSize(-5)).toBe(1);
    expect(clampReplayPageSize(7.9)).toBe(7);
    expect(clampReplayPageSize(10_000)).toBe(REPLAY_MAX_PAGE_SIZE);
  });
});

describe("claimStillHoldsPayment", () => {
  it.each(["paid", "partial_paid"] as const)("%s still holds a payment", (state) => {
    expect(claimStillHoldsPayment(state)).toBe(true);
  });
  it.each(["replaced", "voided", "ack_accepted", "denied"] as const)(
    "%s no longer holds a payment (its days must come out)",
    (state) => {
      expect(claimStillHoldsPayment(state)).toBe(false);
    },
  );
});

describe("isHospiceLocRevenueCode", () => {
  it("accepts the four level-of-care codes and nothing else", () => {
    for (const code of ["0651", "0652", "0655", "0656"])
      expect(isHospiceLocRevenueCode(code)).toBe(true);
    expect(isHospiceLocRevenueCode("0250")).toBe(false);
  });
});
