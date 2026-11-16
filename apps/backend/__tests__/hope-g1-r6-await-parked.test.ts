// apps/backend/__tests__/hope-g1-r6-await-parked.test.ts — the live suites' "is the statement parked on the lock yet" poll
// THROWS when it never is (a loop that fell through released the holder before the call queued: the ordering the test exists to
// prove was silently dropped, or a later assertion failed with a message about something else). Unit-tested here because the
// live suites are not run with every change. (class: swallowed-failure.)
import { describe, expect, it, vi } from "vitest";
import { PARKED_POLL_ATTEMPTS, PARKED_POLL_INTERVAL_MS, awaitParked } from "./_hope-busy-within";

describe("awaitParked", () => {
  it("returns as soon as the statement is seen parked, without sleeping again", async () => {
    const sleep = vi.fn(async () => undefined);
    const isParked = vi.fn(async () => true);

    await awaitParked(isParked, "the call", sleep);

    expect(isParked).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("keeps polling, one interval apart, until the statement parks", async () => {
    const sleep = vi.fn(async () => undefined);
    const isParked = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    await awaitParked(isParked, "the call", sleep);

    expect(isParked).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[PARKED_POLL_INTERVAL_MS], [PARKED_POLL_INTERVAL_MS]]);
  });

  it("throws, naming what it waited for, when the statement never parks (it does not fall through)", async () => {
    const sleep = vi.fn(async () => undefined);
    const isParked = vi.fn(async () => false);

    const failure = awaitParked(isParked, "recordSfv on the SFV row", sleep);

    await expect(failure).rejects.toThrow(
      "recordSfv on the SFV row never became blocked on a lock",
    );
    expect(isParked).toHaveBeenCalledTimes(PARKED_POLL_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(PARKED_POLL_ATTEMPTS - 1);
  });

  it("a poll that itself fails is not swallowed", async () => {
    const broken = new Error("pg_stat_activity unreachable");

    await expect(
      awaitParked(
        async () => {
          throw broken;
        },
        "the call",
        async () => undefined,
      ),
    ).rejects.toBe(broken);
  });
});
