// Focus follows only the conversation the user picked on a narrow screen, once; it never leaks to a later activeId
// change (realtime refresh, deep link, new conversation).
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFocusThreadAfterPick } from "./use-focus-thread-after-pick";

function setup(narrow = true, withHeading = true) {
  const heading = document.createElement("h2");
  heading.tabIndex = -1;
  document.body.append(heading);
  const headingRef = { current: withHeading ? heading : null };
  const hook = renderHook(
    ({ activeId }: { activeId: string | null }) => {
      const pick = useFocusThreadAfterPick({
        activeId,
        narrow,
        headingRef,
        setActiveId: () => {},
      });
      return pick;
    },
    { initialProps: { activeId: null as string | null } },
  );
  return { heading, hook, headingRef };
}

describe("useFocusThreadAfterPick", () => {
  it("focuses the heading when the picked conversation becomes active on a narrow screen", () => {
    const { heading, hook } = setup();
    act(() => hook.result.current("a"));
    hook.rerender({ activeId: "a" });
    expect(document.activeElement).toBe(heading);
  });

  it("does not focus on a wide layout", () => {
    const { heading, hook } = setup(false);
    act(() => hook.result.current("a"));
    hook.rerender({ activeId: "a" });
    expect(document.activeElement).not.toBe(heading);
  });

  it("does not arm when the picked id is already active, so a later change cannot steal focus", () => {
    const { heading, hook } = setup();
    hook.rerender({ activeId: "a" });
    act(() => hook.result.current("a"));
    hook.rerender({ activeId: "b" });
    expect(document.activeElement).not.toBe(heading);
  });

  it("is disarmed when a different conversation becomes active than the one picked", () => {
    const { heading, hook } = setup();
    act(() => hook.result.current("a"));
    hook.rerender({ activeId: "b" });
    hook.rerender({ activeId: "a" });
    expect(document.activeElement).not.toBe(heading);
  });

  it("is disarmed when the picked thread never mounted (no heading), not left pending", () => {
    const { heading, hook, headingRef } = setup(true, false);
    act(() => hook.result.current("a"));
    hook.rerender({ activeId: "a" });
    headingRef.current = heading;
    hook.rerender({ activeId: "b" });
    expect(document.activeElement).not.toBe(heading);
  });
});
