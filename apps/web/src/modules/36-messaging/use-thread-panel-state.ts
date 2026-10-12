// WP 2.2: which thread panel is open, where focus goes when it closes, the per-thread drafts, and the narrow-screen
// slide-over rules. The panel itself (thread-panel.tsx) is keyed by the root id, so it holds no state across threads;
// anything that must survive a switch (the drafts) lives here.
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

const NARROW_QUERY = "(max-width: 760px)";

function isNarrowScreen(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
}

interface PanelStateInput {
  timelineRef: RefObject<HTMLDivElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  jumpToMessage: (messageId: string) => void;
}

export function useThreadPanelState({ timelineRef, textareaRef, jumpToMessage }: PanelStateInput) {
  const [rootId, setRootId] = useState<string | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  /** Unsent reply text per thread: switching threads never discards a draft. */
  const draftsRef = useRef(new Map<string, string>());
  /**
   * Roots with a reply being sent. Lives here, not in the panel, because the panel can be closed and reopened while
   * the request is still in flight: the reopened panel must hold Send for that root or it would send the text again.
   */
  const [sendingRoots, setSendingRoots] = useState<ReadonlySet<string>>(new Set());
  const beginSend = useCallback((id: string): void => {
    setSendingRoots((current) => new Set(current).add(id));
  }, []);
  const endSend = useCallback((id: string): void => {
    setSendingRoots((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  const openThread = useCallback((id: string, opener: HTMLElement): void => {
    openerRef.current = opener;
    setRootId(id);
  }, []);

  const closeThread = useCallback(
    (restoreFocus = true): void => {
      const opener = openerRef.current;
      const closing = rootId;
      openerRef.current = null;
      // The timeline is inert behind a slide-over. Lift that NOW: the focus move that follows (a jump, the opener) runs
      // before React would re-run the effect below, and a browser will not focus inside an inert subtree.
      timelineRef.current?.removeAttribute("inert");
      setRootId(null);
      if (!restoreFocus) return;
      // The opener, else any other control that opens the same thread, else the timeline, else the composer.
      window.requestAnimationFrame(() => {
        const sameThread = closing
          ? timelineRef.current?.querySelector<HTMLElement>(
              `[data-thread-opener="${CSS.escape(closing)}"]`,
            )
          : null;
        const target = opener?.isConnected ? opener : (sameThread ?? timelineRef.current);
        (target ?? textareaRef.current)?.focus();
      });
    },
    [rootId, timelineRef, textareaRef],
  );

  /** "Show in conversation": on a narrow screen the panel covers the timeline, so it closes first. */
  const showInConversation = useCallback(
    (id: string): void => {
      if (isNarrowScreen()) closeThread(false);
      jumpToMessage(id);
    },
    [closeThread, jumpToMessage],
  );

  // A slide-over hides the timeline behind it: keep it out of the tab order and the accessibility tree meanwhile.
  // Re-evaluated when the screen is resized or rotated, not decided once.
  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || rootId === null) return;
    const query =
      typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY) : undefined;
    const apply = (): void => {
      timeline.toggleAttribute("inert", isNarrowScreen());
    };
    apply();
    // Older engines only have addListener/removeListener.
    if (query?.addEventListener) query.addEventListener("change", apply);
    else query?.addListener?.(apply);
    return () => {
      if (query?.removeEventListener) query.removeEventListener("change", apply);
      else query?.removeListener?.(apply);
      timeline.removeAttribute("inert");
    };
  }, [rootId, timelineRef]);

  /** A different channel. */
  const reset = useCallback((): void => {
    setRootId(null);
    openerRef.current = null;
    draftsRef.current.clear();
  }, []);

  return {
    rootId,
    openThread,
    closeThread,
    showInConversation,
    draftsRef,
    sendingRoots,
    beginSend,
    endSend,
    reset,
  };
}
