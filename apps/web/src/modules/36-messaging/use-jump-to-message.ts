// WP 2.2: jump-to-parent. Scroll to and focus a message of the channel timeline; if it is not loaded, reuse the
// anchored-page read the notification deep link uses (`anchorMessageId`: a page that ends at that message) and show
// that ONE contiguous page, with a "Back to latest" control, rather than merging two pages with a hole between them.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import type { Message } from "./messaging-types";

const HIGHLIGHT_MS = 4_000;

interface JumpInput {
  timelineRef: RefObject<HTMLDivElement | null>;
  messages: Message[] | null;
  /** The route-supplied anchor (notification deep link); a jump or "back to latest" supersedes it. */
  routeAnchorRef: MutableRefObject<string | null>;
  initialScrollPending: MutableRefObject<boolean>;
  nearBottomRef: MutableRefObject<boolean>;
  /** Read by the thread's latest-page read: when set, it asks the server for the page ending at this message. */
  jumpAnchorRef: MutableRefObject<string | null>;
  /** Read-and-cleared by the thread's latest-page read: take the response as the whole list, do not merge. */
  replaceNextRef: MutableRefObject<boolean>;
  /** Once the user has jumped, the route anchor must stop pulling the timeline back to itself. */
  jumpedRef: MutableRefObject<boolean>;
}

export function useJumpToMessage({
  timelineRef,
  messages,
  routeAnchorRef,
  initialScrollPending,
  nearBottomRef,
  jumpAnchorRef,
  replaceNextRef,
  jumpedRef,
}: JumpInput) {
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [browsingHistory, setBrowsingHistory] = useState(false);
  const pendingFocusRef = useRef<string | null>(null);
  /** The thread points this at "read the latest page now (or right after the one in flight)". */
  const reloadRef = useRef<() => void>(() => {});

  const focusPendingRow = useCallback((): void => {
    const id = pendingFocusRef.current;
    if (!id) return;
    const row = timelineRef.current?.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(id)}"]`,
    );
    if (!row) return;
    pendingFocusRef.current = null;
    row.scrollIntoView({ block: "center" });
    row.focus({ preventScroll: true });
  }, [timelineRef]);

  // The anchored page just rendered: the message jumped to is now in the DOM.
  useLayoutEffect(() => {
    if (messages !== null) focusPendingRow();
  }, [messages, focusPendingRow]);

  useEffect(() => {
    if (!highlightId) return;
    const timer = window.setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlightId]);

  const jumpToMessage = useCallback(
    (messageId: string): void => {
      jumpedRef.current = true;
      pendingFocusRef.current = messageId;
      setHighlightId(messageId);
      const onScreen = timelineRef.current?.querySelector(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      if (onScreen) {
        focusPendingRow();
        return;
      }
      jumpAnchorRef.current = messageId;
      replaceNextRef.current = true;
      setBrowsingHistory(true);
      reloadRef.current();
    },
    [focusPendingRow, timelineRef, jumpAnchorRef, replaceNextRef, jumpedRef],
  );

  const backToLatest = useCallback((): void => {
    jumpAnchorRef.current = null;
    routeAnchorRef.current = null;
    replaceNextRef.current = true;
    initialScrollPending.current = true;
    nearBottomRef.current = true;
    setBrowsingHistory(false);
    setHighlightId(null);
    reloadRef.current();
  }, [initialScrollPending, nearBottomRef, routeAnchorRef, jumpAnchorRef, replaceNextRef]);

  /** A different channel: forget any jump. */
  const reset = useCallback((): void => {
    setHighlightId(null);
    setBrowsingHistory(false);
    jumpAnchorRef.current = null;
    replaceNextRef.current = false;
    pendingFocusRef.current = null;
    jumpedRef.current = false;
  }, [jumpAnchorRef, replaceNextRef, jumpedRef]);

  return {
    highlightId,
    browsingHistory,
    reloadRef,
    jumpToMessage,
    backToLatest,
    reset,
  };
}
