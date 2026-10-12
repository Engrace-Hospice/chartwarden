// WP 2.2: jump-to-parent. Scroll to and focus a message of the channel timeline; if it is not loaded, reuse the
// anchored-page read the notification deep link uses (`anchorMessageId`: a page that ends at that message) and show
// that ONE contiguous page, with a "Back to latest" control, rather than merging two pages with a hole between them.
//
// What a read should do is a REQUEST (`ReadView`), captured by the read when it is issued. A new request replaces the
// object, so a read already in flight can tell it is stale (its view is no longer the current one), discards itself and
// lets the queued re-read carry the new request. Flags consumed by "whichever read finishes first" cannot do that.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import type { Message } from "./messaging-types";

const NOTICE_MS = 4_000;

/** How the thread's latest-page read should behave. Replaced (never mutated) to issue a new request. */
export interface ReadView {
  readonly token: number;
  /** A message a user jump wants the page to end at; null = the newest page (or the route anchor). */
  readonly anchor: string | null;
  /** The response is the whole list (a jump, or back to latest), not a merge into the current one. */
  readonly replace: boolean;
}

export const INITIAL_READ_VIEW: ReadView = { token: 0, anchor: null, replace: false };

interface JumpInput {
  timelineRef: RefObject<HTMLDivElement | null>;
  messages: Message[] | null;
  /** The route-supplied anchor (notification deep link); a jump or "back to latest" supersedes it. */
  routeAnchorRef: MutableRefObject<string | null>;
  initialScrollPending: MutableRefObject<boolean>;
  nearBottomRef: MutableRefObject<boolean>;
  viewRef: MutableRefObject<ReadView>;
  /** Once the user has jumped, the route anchor must stop pulling the timeline back to itself. */
  jumpedRef: MutableRefObject<boolean>;
}

export function useJumpToMessage({
  timelineRef,
  messages,
  routeAnchorRef,
  initialScrollPending,
  nearBottomRef,
  viewRef,
  jumpedRef,
}: JumpInput) {
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [browsingHistory, setBrowsingHistory] = useState(false);
  const [anchorMissing, setAnchorMissing] = useState(false);
  const pendingFocusRef = useRef<string | null>(null);
  /** The thread points this at "read the latest (or requested) page now, or right after the one in flight". */
  const reloadRef = useRef<() => void>(() => {});

  const request = useCallback(
    (anchor: string | null, replace: boolean): void => {
      viewRef.current = { token: viewRef.current.token + 1, anchor, replace };
    },
    [viewRef],
  );

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

  // The anchored page just rendered: the message jumped to is now in the DOM, or it is not on that page at all (then
  // stop waiting for it: the replace has been applied once the request no longer asks for one).
  useLayoutEffect(() => {
    if (messages === null) return;
    focusPendingRow();
    if (pendingFocusRef.current && !viewRef.current.replace) pendingFocusRef.current = null;
  }, [messages, focusPendingRow, viewRef]);

  useEffect(() => {
    if (!highlightId) return;
    const timer = window.setTimeout(() => setHighlightId(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [highlightId]);

  useEffect(() => {
    if (!anchorMissing) return;
    const timer = window.setTimeout(() => setAnchorMissing(false), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [anchorMissing]);

  const jumpToMessage = useCallback(
    (messageId: string): void => {
      jumpedRef.current = true;
      pendingFocusRef.current = messageId;
      setHighlightId(messageId);
      setAnchorMissing(false);
      const onScreen = timelineRef.current?.querySelector(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      if (onScreen) {
        focusPendingRow();
        return;
      }
      request(messageId, true);
      setBrowsingHistory(true);
      reloadRef.current();
    },
    [focusPendingRow, timelineRef, jumpedRef, request],
  );

  const backToLatest = useCallback((): void => {
    routeAnchorRef.current = null;
    jumpedRef.current = false;
    initialScrollPending.current = true;
    nearBottomRef.current = true;
    request(null, true);
    setBrowsingHistory(false);
    setHighlightId(null);
    reloadRef.current();
  }, [initialScrollPending, nearBottomRef, routeAnchorRef, jumpedRef, request]);

  /** The route supplied a different anchor: any jump is over, and the new anchor is read as it always was. */
  const routeAnchorChanged = useCallback(
    (wasBrowsing: boolean): void => {
      jumpedRef.current = false;
      pendingFocusRef.current = null;
      request(null, wasBrowsing);
      setBrowsingHistory(false);
      setHighlightId(null);
      setAnchorMissing(false);
    },
    [jumpedRef, request],
  );

  /** The page a jump asked for could not be read (the message is gone): back to the newest page, with a notice. */
  const anchorGone = useCallback((): void => {
    pendingFocusRef.current = null;
    request(null, false);
    setBrowsingHistory(false);
    setHighlightId(null);
    setAnchorMissing(true);
  }, [request]);

  /** A different channel: forget any jump. */
  const reset = useCallback((): void => {
    setHighlightId(null);
    setBrowsingHistory(false);
    setAnchorMissing(false);
    request(null, false);
    pendingFocusRef.current = null;
    jumpedRef.current = false;
  }, [request, jumpedRef]);

  return {
    highlightId,
    browsingHistory,
    anchorMissing,
    reloadRef,
    jumpToMessage,
    backToLatest,
    routeAnchorChanged,
    anchorGone,
    reset,
  };
}
