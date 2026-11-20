// WF09 WP3 review fixes — the small hooks behind the memoised panels and the focus after a finalize.
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { type JSX, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAnchorFocus } from "../use-anchor-focus";
import { useLatestCallback } from "../use-latest-callback";
import { useStableValue } from "../use-stable-value";

afterEach(cleanup);

describe("useStableValue", () => {
  it("keeps the same object while its content is unchanged, and gives the new one when it changes", () => {
    const { result, rerender } = renderHook(({ value }) => useStableValue(value), {
      initialProps: { value: { rows: ["a", "b"] } },
    });
    const first = result.current;
    rerender({ value: { rows: ["a", "b"] } });
    expect(result.current).toBe(first);
    rerender({ value: { rows: ["a", "c"] } });
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual({ rows: ["a", "c"] });
  });
});

describe("useLatestCallback", () => {
  it("keeps one identity and runs the callback of the latest render", () => {
    const first = vi.fn(() => "first");
    const second = vi.fn(() => "second");
    const { result, rerender } = renderHook(({ fn }) => useLatestCallback(fn), {
      initialProps: { fn: first as () => string },
    });
    const stable = result.current;
    rerender({ fn: second as () => string });
    expect(result.current).toBe(stable);
    expect(stable()).toBe("second");
    expect(first).not.toHaveBeenCalled();
  });
});

function Host({ initiallyReady }: { initiallyReady: boolean }): JSX.Element {
  const [ready, setReady] = useState(initiallyReady);
  const request = useAnchorFocus("anchor-under-test", ready);
  return (
    <>
      <button type="button" onClick={request}>
        ask
      </button>
      <button type="button" onClick={() => setReady(true)}>
        become ready
      </button>
      {ready ? (
        <section id="anchor-under-test" tabIndex={-1}>
          anchor
        </section>
      ) : null}
    </>
  );
}

describe("useAnchorFocus", () => {
  it("takes focus to the anchor when asked while the screen has it", () => {
    render(<Host initiallyReady />);
    act(() => screen.getByRole("button", { name: "ask" }).click());
    expect(document.getElementById("anchor-under-test")).toHaveFocus();
  });

  it("waits for the screen to have the anchor, then takes focus once", () => {
    render(<Host initiallyReady={false} />);
    act(() => screen.getByRole("button", { name: "ask" }).click());
    expect(document.body).toHaveFocus();
    act(() => screen.getByRole("button", { name: "become ready" }).click());
    const anchor = document.getElementById("anchor-under-test");
    expect(anchor).toHaveFocus();
    (anchor as HTMLElement).blur();
    act(() => screen.getByRole("button", { name: "become ready" }).click());
    expect(anchor).not.toHaveFocus();
  });
});
