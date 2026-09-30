// useLiveRefresh — visibility-aware polling for the live IDG surface (fake timers).
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextDelay, useLiveRefresh } from "./use-live-refresh";

let hidden = false;
function setHidden(v: boolean): void {
  hidden = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("nextDelay", () => {
  it("doubles per failure and caps", () => {
    expect(nextDelay(10_000, 0, 60_000)).toBe(10_000);
    expect(nextDelay(10_000, 1, 60_000)).toBe(20_000);
    expect(nextDelay(10_000, 2, 60_000)).toBe(40_000);
    expect(nextDelay(10_000, 5, 60_000)).toBe(60_000);
  });
});

describe("useLiveRefresh", () => {
  it("polls every interval while enabled and reports the last update", async () => {
    const refresh = vi.fn(async () => undefined);
    const { result } = renderHook(() => useLiveRefresh({ enabled: true, refresh }));
    expect(refresh).not.toHaveBeenCalled();
    await advance(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.lastUpdatedAt).not.toBeNull();
    await advance(10_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("never polls when disabled (non-live meeting)", async () => {
    const refresh = vi.fn(async () => undefined);
    renderHook(() => useLiveRefresh({ enabled: false, refresh }));
    await advance(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("pauses while hidden and refreshes immediately when visible again", async () => {
    const refresh = vi.fn(async () => undefined);
    renderHook(() => useLiveRefresh({ enabled: true, refresh }));
    await advance(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => setHidden(true));
    await advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => setHidden(false));
    await advance(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    await advance(10_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("refreshes immediately on window focus", async () => {
    const refresh = vi.fn(async () => undefined);
    renderHook(() => useLiveRefresh({ enabled: true, refresh }));
    act(() => void window.dispatchEvent(new Event("focus")));
    await advance(0);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("never overlaps requests", async () => {
    let release: () => void = () => undefined;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderHook(() => useLiveRefresh({ enabled: true, refresh }));
    await advance(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => void window.dispatchEvent(new Event("focus")));
    await advance(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await advance(10_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("backs off on failure and recovers on success", async () => {
    let fail = true;
    const refresh = vi.fn(async () => {
      if (fail) throw new Error("boom");
    });
    const { result } = renderHook(() => useLiveRefresh({ enabled: true, refresh }));
    await advance(10_000); // fail #1 → next in 20s
    expect(result.current.failing).toBe(true);
    await advance(19_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(refresh).toHaveBeenCalledTimes(2); // fail #2 → next in 40s
    fail = false;
    await advance(40_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(result.current.failing).toBe(false);
    await advance(10_000); // back to the base interval
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("aborts the in-flight request on unmount and stops polling", async () => {
    let signal: AbortSignal | null = null;
    const refresh = vi.fn(
      (s: AbortSignal) =>
        new Promise<void>((_, reject) => {
          signal = s;
          s.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const { unmount } = renderHook(() => useLiveRefresh({ enabled: true, refresh }));
    await advance(10_000);
    expect(signal).not.toBeNull();
    unmount();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    await advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops when the meeting leaves live", async () => {
    const refresh = vi.fn(async () => undefined);
    const { rerender } = renderHook(({ on }) => useLiveRefresh({ enabled: on, refresh }), {
      initialProps: { on: true },
    });
    await advance(10_000);
    rerender({ on: false });
    await advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
