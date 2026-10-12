// WP 2.2: which thread panel is open, where focus goes when it closes, the per-thread drafts, and the narrow-screen
// slide-over rules. The panel itself (thread-panel.tsx) is keyed by the root id, so it holds no state across threads;
// anything that must survive a switch (the drafts) lives here.
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

function isNarrowScreen(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches;
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

  const openThread = useCallback((id: string, opener: HTMLElement): void => {
    openerRef.current = opener;
    setRootId(id);
  }, []);

  const closeThread = useCallback(
    (restoreFocus = true): void => {
      const opener = openerRef.current;
      const closing = rootId;
      openerRef.current = null;
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
  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.toggleAttribute("inert", rootId !== null && isNarrowScreen());
    return () => timeline.removeAttribute("inert");
  }, [rootId, timelineRef]);

  /** A different channel. */
  const reset = useCallback((): void => {
    setRootId(null);
    openerRef.current = null;
    draftsRef.current.clear();
  }, []);

  return { rootId, openThread, closeThread, showInConversation, draftsRef, reset };
}
