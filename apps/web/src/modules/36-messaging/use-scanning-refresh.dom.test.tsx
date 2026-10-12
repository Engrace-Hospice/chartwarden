import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScanningRefresh } from "./use-scanning-refresh";

const MINUTE = 60_000;
const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

describe("useScanningRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops for good once a permanently scanning file outlives the time budget", async () => {
    const refresh = vi.fn();
    renderHook(() => useScanningRefresh("a", refresh, "dm-1"));
    await advance(11 * MINUTE);
    const settled = refresh.mock.calls.length;
    expect(settled).toBeGreaterThan(3);
    await advance(30 * MINUTE);
    expect(refresh).toHaveBeenCalledTimes(settled);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts the budget only when the set of scanning ids changes", async () => {
    const refresh = vi.fn();
    const { rerender } = renderHook(({ key }) => useScanningRefresh(key, refresh, "dm-1"), {
      initialProps: { key: "a" },
    });
    await advance(9 * MINUTE);
    rerender({ key: "a" });
    rerender({ key: "a,b" });
    await advance(5 * MINUTE);
    const afterRestart = refresh.mock.calls.length;
    await advance(MINUTE);
    expect(refresh.mock.calls.length).toBeGreaterThan(afterRestart);
  });

  it("stops when the channel changes and nothing is scanning there", async () => {
    const refresh = vi.fn();
    const { rerender } = renderHook(
      ({ key, channel }) => useScanningRefresh(key, refresh, channel),
      { initialProps: { key: "a", channel: "dm-1" } },
    );
    await advance(6_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender({ key: "", channel: "dm-2" });
    expect(vi.getTimerCount()).toBe(0);
    await advance(5 * MINUTE);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops on unmount", async () => {
    const refresh = vi.fn();
    const { unmount } = renderHook(() => useScanningRefresh("a", refresh, "dm-1"));
    await advance(6_000);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(5 * MINUTE);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not spend the budget while the tab is hidden, so polling resumes when the user comes back", async () => {
    const refresh = vi.fn();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    renderHook(() => useScanningRefresh("a", refresh, "dm-1"));
    await advance(15 * MINUTE);
    expect(refresh).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    await advance(MINUTE);
    expect(refresh).toHaveBeenCalled();
    hidden.mockRestore();
  });

  it("skips the read while the document is hidden but keeps the schedule", async () => {
    const refresh = vi.fn();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    renderHook(() => useScanningRefresh("a", refresh, "dm-1"));
    await advance(MINUTE);
    expect(refresh).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    await advance(MINUTE);
    expect(refresh).toHaveBeenCalled();
  });
});
