// apps/backend/__tests__/hope-g2-busy-within.test.ts — the live suites' "parked behind a lock" helper asserts no elapsed bound (a
// 9 s race on a 5 s lock timeout failed a slow CI runner with no code defect, and its test titles claimed a bound that nothing
// asserted), still releases its holder on every path, and never lets a call that never gives up outlive the test.
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOLDER_SAFETY_RELEASE_MS, busyWithin } from "./_hope-busy-within";

const BUSY = Object.assign(new Error("busy"), { code: "M10_RECORD_BUSY", statusCode: 409 });

/** A holder whose statements are recorded; `onRollback` runs when the held lock is let go. */
function fakeHolder(onRollback: () => void = () => {}) {
  const statements: string[] = [];
  return {
    statements,
    query: vi.fn(async (text: string) => {
      statements.push(text);
      if (text === "ROLLBACK") onRollback();
    }),
    end: vi.fn(async () => {
      statements.push("end");
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("busyWithin", () => {
  it("returns the call's refusal however long it took (a slow runner is not a failure) and releases the holder after it settled", async () => {
    vi.useFakeTimers();
    const holder = fakeHolder();
    const call = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(BUSY), 12_000); // past the old 9 s race, well inside the safety release
    });

    const outcome = busyWithin(call, holder);
    await vi.advanceTimersByTimeAsync(12_000);

    await expect(outcome).resolves.toBe("409:M10_RECORD_BUSY");
    expect(holder.statements).toEqual(["ROLLBACK", "end"]);
    expect(vi.getTimerCount()).toBe(0); // the safety timer is cleared once the call settled
  });

  it("returns null for a call that succeeded, and 'undefined:OTHER' when the refusal carries no status or code", async () => {
    const succeeded = await busyWithin(Promise.resolve("ok"), fakeHolder());
    const untyped = await busyWithin(Promise.reject(new Error("boom")), fakeHolder());

    expect(succeeded).toBeNull();
    expect(untyped).toBe("undefined:OTHER");
  });

  it("releases the holder even when the call never gives up, so the call finishes (as a success) instead of parking for ever", async () => {
    vi.useFakeTimers();
    let letGo!: () => void;
    const parked = new Promise<string>((resolve) => {
      letGo = () => resolve("signed");
    });
    const holder = fakeHolder(() => letGo());

    const outcome = busyWithin(parked, holder);
    await vi.advanceTimersByTimeAsync(HOLDER_SAFETY_RELEASE_MS - 1);
    expect(holder.statements).toEqual([]); // not before the safety release
    await vi.advanceTimersByTimeAsync(1);

    await expect(outcome).resolves.toBeNull(); // not a 409: the caller's assertion on it fails, which is the point
    expect(holder.statements[0]).toBe("ROLLBACK");
    expect(holder.statements.at(-1)).toBe("end");
  });
});
