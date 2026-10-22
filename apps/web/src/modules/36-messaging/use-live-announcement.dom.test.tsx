import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLiveAnnouncement } from "./use-live-announcement";

afterEach(() => vi.useRealTimers());

let api: ReturnType<typeof useLiveAnnouncement>;
function Harness() {
  api = useLiveAnnouncement();
  return api.region;
}
const tick = () => act(async () => void (await vi.advanceTimersByTimeAsync(60)));

describe("useLiveAnnouncement", () => {
  it("keeps ONE region node and re-announces an identical consecutive message (cleared, then set)", async () => {
    vi.useFakeTimers();
    render(<Harness />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");

    act(() => api.announce("1 new message"));
    expect(region.textContent).toBe(""); // cleared first so the repeat is a change
    await tick();
    expect(region.textContent).toBe("1 new message");

    act(() => api.announce("1 new message"));
    expect(region.textContent).toBe("");
    await tick();
    expect(region.textContent).toBe("1 new message");
    expect(screen.getByRole("status")).toBe(region); // same node across updates
  });

  it("clear() empties the region and cancels a pending announcement (channel switch)", async () => {
    vi.useFakeTimers();
    render(<Harness />);
    const region = screen.getByRole("status");
    act(() => api.announce("2 new messages"));
    act(() => api.clear());
    await tick();
    expect(region.textContent).toBe("");
  });

  it("does not set state after unmount (the pending timer is cleared)", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(window, "clearTimeout");
    const { unmount } = render(<Harness />);
    act(() => api.announce("late"));
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    clearSpy.mockRestore();
  });
});
