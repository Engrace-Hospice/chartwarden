// apps/web/src/modules/10-hope — how the assessment workspace moves its own scroll position and focus: to the item an issue
// link names, back to the top for a new section or group, to a group a show-all jump asked for, and the show-all
// scroll-spy that tracks which group is at the top. Lifted out of the screen unchanged; it only touches the DOM and the
// few pieces of navigation state the screen hands it.
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useEffect } from "react";

/**
 * The pane that actually scrolls the workspace content: the body above 1200px, the whole
 * `.wx-patient-workspace` below it (the body grows to its content there). Falls back to the body.
 */
function workspaceScroller(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight)
      return node;
    if (node.classList.contains("wx-patient-workspace")) break;
  }
  return element.closest<HTMLElement>(".wx-patient-workspace-body");
}

/** The sticky jump bar covers this much of the top of the pane: a target scrolled under it is not in view. */
const JUMP_BAR_CLEARANCE_PX = 72;

/**
 * How far to scroll the pane so `rect` (the target, in viewport coordinates) is where `block` says, relative to the pane.
 * `start` puts it just below the sticky jump bar; `center` in the middle of the pane; `nearest` leaves it alone when it
 * is already fully in view below the jump bar, and otherwise moves it the shortest way in.
 */
function scrollOffset(
  block: "start" | "center" | "nearest",
  rect: DOMRect,
  paneRect: DOMRect,
): number {
  const top = rect.top - paneRect.top;
  if (block === "start") return top - JUMP_BAR_CLEARANCE_PX;
  if (block === "center") return top - (paneRect.height - rect.height) / 2;
  const bottom = rect.bottom - paneRect.top;
  const fits = rect.height <= paneRect.height - JUMP_BAR_CLEARANCE_PX;
  if (top < JUMP_BAR_CLEARANCE_PX || !fits) return top - JUMP_BAR_CLEARANCE_PX;
  return bottom > paneRect.height ? bottom - paneRect.height : 0;
}

/**
 * Scrolls the workspace pane — not the window — so the app shell (top bar, banner) never shifts.
 * `scrollIntoView` scrolls every scrollable ancestor, including the document. Exported so every scroll to something in the
 * workspace goes through the one place that knows about the sticky jump bar.
 */
export function scrollWithinWorkspace(
  element: HTMLElement,
  block: "start" | "center" | "nearest",
): void {
  const pane = workspaceScroller(element);
  if (!pane) {
    // Optional: not every environment implements it (jsdom does not), and a scroll that cannot happen is not a failure.
    element.scrollIntoView?.({ behavior: "smooth", block });
    return;
  }
  const offset = scrollOffset(block, element.getBoundingClientRect(), pane.getBoundingClientRect());
  if (offset === 0) return;
  pane.scrollTo({ top: pane.scrollTop + offset, behavior: "smooth" });
}

interface ScrollingInputs {
  /** The loaded workspace, or null. Its identity changes with every re-read, which is when the groups on screen may have changed. */
  readonly workspace: object | null;
  readonly workspaceRef: RefObject<HTMLDivElement>;
  readonly activeSection: string;
  readonly groupBySection: Record<string, string>;
  readonly navMode: "guided" | "all";
  readonly pendingItemFocus: string | null;
  readonly setPendingItemFocus: Dispatch<SetStateAction<string | null>>;
  readonly pendingScroll: string | null;
  readonly setPendingScroll: Dispatch<SetStateAction<string | null>>;
  readonly setSpy: Dispatch<SetStateAction<{ section: string; group: string } | null>>;
}

export function useWorkspaceScrolling(inputs: ScrollingInputs): void {
  const { workspace, workspaceRef, activeSection, groupBySection, navMode } = inputs;
  const { pendingItemFocus, setPendingItemFocus, pendingScroll, setPendingScroll, setSpy } = inputs;

  useEffect(() => {
    if (!pendingItemFocus) {
      return;
    }

    const timeout = window.setTimeout(() => {
      // Checkbox tiles are anchored by their 5-char stem ("hope-item-A1005"), not the item code.
      const element =
        document.getElementById(`hope-item-${pendingItemFocus}`) ??
        document.getElementById(`hope-item-${pendingItemFocus.slice(0, 5)}`);

      if (!element) {
        return;
      }

      scrollWithinWorkspace(element, "center");

      if (element instanceof HTMLElement) {
        element.focus({
          preventScroll: true,
        });
      }

      setPendingItemFocus(null);
    }, 50);

    return () => window.clearTimeout(timeout);
    // pendingItemFocus alone is the trigger: the issue-link handler sets it in the same batched
    // update as activeSection, so the target section is already committed when the timer fires.
  }, [pendingItemFocus, setPendingItemFocus]);
  // A new section starts at its top (unless an issue link is about to scroll to a specific item).
  // biome-ignore lint/correctness/useExhaustiveDependencies: section/group changes are the intentional trigger.
  useEffect(() => {
    if (pendingItemFocus || pendingScroll) return;
    if (navMode === "all" && activeSection !== "Review") return;
    if (workspaceRef.current) workspaceScroller(workspaceRef.current)?.scrollTo({ top: 0 });
  }, [activeSection, groupBySection, navMode]);

  // Show-all: jump to a section/group once it is rendered.
  useEffect(() => {
    if (!pendingScroll) return;
    const timeout = window.setTimeout(() => {
      const target = document.getElementById(pendingScroll);
      if (target) scrollWithinWorkspace(target, "start");
      setPendingScroll(null);
    }, 30);
    return () => window.clearTimeout(timeout);
  }, [pendingScroll, setPendingScroll]);

  // Show-all scroll-spy: track the topmost visible group; groups scrolled past count as visited. Re-run on every re-read
  // of the workspace: a group can appear after an answer is saved (the follow-up group once J2051 triggers), and one that
  // was never observed would be missing from the jump bar and the sub-navigation highlight.
  useEffect(() => {
    if (navMode !== "all" || activeSection === "Review" || workspace === null) return;
    const root = workspaceRef.current ? workspaceScroller(workspaceRef.current) : null;
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-hope-group]"));
    if (!nodes.length || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<HTMLElement>();
    let last: string | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          if (entry.isIntersecting) visible.add(el);
          else visible.delete(el);
        }
        const top = nodes.find((node) => visible.has(node));
        const value = top?.dataset.hopeGroup;
        // Passing a group while scrolling does not count as visiting it: marking it would insert
        // error text above the scroll target mid-scroll and push the target down.
        if (!value || value === last) return;
        last = value;
        const [section, group] = value.split(":");
        setSpy({ section: section ?? "", group: group ?? "" });
      },
      { root, rootMargin: "-120px 0px -55% 0px" },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [activeSection, navMode, workspace, workspaceRef, setSpy]);
}
