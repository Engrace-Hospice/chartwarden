// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrollWithinWorkspace, useWorkspaceScrolling } from "../use-hope-workspace-scrolling";
import { stubProperty } from "./workspace-test-kit";

// How the workspace moves its own scroll position: one scroller that knows about the sticky jump bar, and the show-all
// scroll-spy that has to keep up with the groups the screen currently shows.

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const ZERO = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };

/** A pane (`.wx-patient-workspace-body`) holding one target, each with the geometry jsdom does not compute. */
function paneWith(target: { top: number; bottom: number }, paneHeight = 600) {
  const pane = document.createElement("div");
  pane.className = "wx-patient-workspace-body";
  const element = document.createElement("div");
  pane.append(element);
  document.body.append(pane);
  const scrollTo = vi.fn();
  restores.push(stubProperty(Element.prototype, "scrollTo", scrollTo));
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this === element)
      return { ...ZERO, ...target, height: target.bottom - target.top } as DOMRect;
    if (this === pane) return { ...ZERO, bottom: paneHeight, height: paneHeight } as DOMRect;
    return ZERO as DOMRect;
  });
  return { element, scrollTo };
}

describe("scrollWithinWorkspace", () => {
  it("does not throw where there is no pane and the environment has no scrollIntoView (jsdom)", () => {
    restores.push(stubProperty(Element.prototype, "scrollIntoView", undefined));
    const lone = document.createElement("div");
    document.body.append(lone);
    expect(() => scrollWithinWorkspace(lone, "center")).not.toThrow();
    expect(() => scrollWithinWorkspace(lone, "nearest")).not.toThrow();
  });

  it("falls back to the element's own scrollIntoView, with the block asked for, when there is no pane", () => {
    const scrollIntoView = vi.fn();
    restores.push(stubProperty(Element.prototype, "scrollIntoView", scrollIntoView));
    const lone = document.createElement("div");
    document.body.append(lone);
    scrollWithinWorkspace(lone, "nearest");
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest" });
  });

  it("start: puts the target just below the sticky jump bar", () => {
    const { element, scrollTo } = paneWith({ top: 300, bottom: 400 });
    scrollWithinWorkspace(element, "start");
    expect(scrollTo).toHaveBeenCalledWith({ top: 228, behavior: "smooth" });
  });

  it("center: puts the target in the middle of the pane", () => {
    const { element, scrollTo } = paneWith({ top: 500, bottom: 600 });
    scrollWithinWorkspace(element, "center");
    expect(scrollTo).toHaveBeenCalledWith({ top: 250, behavior: "smooth" });
  });

  it.each([
    ["is under the jump bar", { top: 20, bottom: 120 }, -52],
    ["is below the bottom edge", { top: 500, bottom: 700 }, 100],
    ["is taller than the room below the jump bar (its top wins)", { top: 100, bottom: 800 }, 28],
  ])("nearest: moves a target that %s the shortest way into view", (_case, target, top) => {
    const { element, scrollTo } = paneWith(target);
    scrollWithinWorkspace(element, "nearest");
    expect(scrollTo).toHaveBeenCalledWith({ top, behavior: "smooth" });
  });

  it("nearest: leaves a target that is fully in view where it is", () => {
    const { element, scrollTo } = paneWith({ top: 72, bottom: 600 });
    scrollWithinWorkspace(element, "nearest");
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe("the show-all scroll-spy", () => {
  /** Records what each observer was asked to watch, and when it was let go. */
  function stubObserver() {
    const observers: Array<{ observed: Element[]; disconnected: boolean }> = [];
    class FakeObserver {
      readonly record = { observed: [] as Element[], disconnected: false };
      constructor() {
        observers.push(this.record);
      }
      observe(node: Element): void {
        this.record.observed.push(node);
      }
      disconnect(): void {
        this.record.disconnected = true;
      }
    }
    restores.push(stubProperty(globalThis, "IntersectionObserver", FakeObserver));
    return observers;
  }

  function group(key: string): HTMLElement {
    const node = document.createElement("div");
    node.dataset.hopeGroup = key;
    document.body.append(node);
    return node;
  }

  function mount(initialWorkspace: object | null) {
    // Stable across renders, as the screen's state setters are: a fresh function per render would re-run the effect by itself.
    const workspaceRef = { current: document.createElement("div") };
    const [setPendingItemFocus, setPendingScroll, setSpy] = [vi.fn(), vi.fn(), vi.fn()];
    return renderHook(
      ({ workspace }: { workspace: object | null }) =>
        useWorkspaceScrolling({
          workspace,
          workspaceRef,
          activeSection: "J",
          groupBySection: {},
          navMode: "all",
          pendingItemFocus: null,
          setPendingItemFocus,
          pendingScroll: null,
          setPendingScroll,
          setSpy,
        }),
      { initialProps: { workspace: initialWorkspace } },
    );
  }

  it("observes a group that appears after the workspace is re-read (a saved answer triggers the follow-up group)", () => {
    const observers = stubObserver();
    group("J:symptoms");
    const view = mount({ version: 1 });
    expect(observers).toHaveLength(1);
    expect(observers[0]?.observed).toHaveLength(1);

    // An answer is saved: the screen re-reads the workspace (a new object) and a new group is on the page.
    const followUp = group("J:sfv");
    view.rerender({ workspace: { version: 2 } });

    expect(observers[0]?.disconnected).toBe(true);
    expect(observers).toHaveLength(2);
    expect(observers[1]?.observed).toContain(followUp);
    expect(observers[1]?.observed).toHaveLength(2);
  });

  it("observes nothing until the workspace is loaded", () => {
    const observers = stubObserver();
    group("J:symptoms");
    mount(null);
    expect(observers).toHaveLength(0);
  });
});
