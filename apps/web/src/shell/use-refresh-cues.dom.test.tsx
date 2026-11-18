// The one shared rule for background re-reads: a timer, window focus and the tab becoming visible cue a read, only while the tab is
// visible, and the latest callback is the one that runs. Synthetic only.
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRefreshCues } from "./use-refresh-cues";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useRefreshCues", () => {
  it("cues on the interval, on focus and when the tab becomes visible", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const cue = vi.fn();
    renderHook(() => useRefreshCues(cue, 60_000));

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(cue).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(cue).toHaveBeenCalledTimes(2);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(cue).toHaveBeenCalledTimes(3);
  });

  it("stays silent while the tab is hidden", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const cue = vi.fn();
    renderHook(() => useRefreshCues(cue, 60_000));

    act(() => {
      vi.advanceTimersByTime(120_000);
      window.dispatchEvent(new Event("focus"));
    });

    expect(cue).not.toHaveBeenCalled();
  });

  it("runs the latest callback without restarting its timer, and stops when unmounted", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ cue }) => useRefreshCues(cue, 60_000), {
      initialProps: { cue: first },
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    rerender({ cue: second });
    act(() => {
      vi.advanceTimersByTime(30_000); // the interval started once: it is still the first minute
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("has no timer at all when the interval is null, but still cues on focus", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const cue = vi.fn();
    renderHook(() => useRefreshCues(cue, null));
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(cue).toHaveBeenCalledTimes(1);
  });
});
