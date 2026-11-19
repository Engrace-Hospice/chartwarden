// A countdown printed from the client's clock ("Due in 3h") must keep moving while a screen sits open, so the hook that supplies "now"
// ticks. Synthetic times only.
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNow } from "../use-now";

afterEach(() => vi.useRealTimers());

describe("useNow", () => {
  it("moves forward on its interval, and stops when its screen goes away", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T12:00:00.000Z"));
    const { result, unmount } = renderHook(() => useNow(60_000));
    const start = result.current.getTime();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.getTime()).toBe(start + 60_000);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
