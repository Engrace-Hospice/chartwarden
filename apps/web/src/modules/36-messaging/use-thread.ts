// WP 2.2: the data half of the thread side panel. One root message and its direct replies, read through
// GET /channels/:id/messages/:messageId/thread (oldest reply first, keyset-paged). Permissions are the channel's: a
// thread the viewer may no longer read is the same "unavailable" answer as a thread that never existed.
import { BACKGROUND_REQUEST_HEADERS, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Message } from "./messaging-types";
import { mergeMessages } from "./messaging-utils";

const THREAD_PAGE_SIZE = 50;

/** What a realtime hint said changed (ids only). `null` ids = "something may have changed" (a reconnect). */
export interface LiveHint {
  readonly seq: number;
  readonly messageId: string | null;
  readonly parentMessageId: string | null;
}

export type ThreadStatus = "loading" | "ready" | "unavailable" | "failed";

export interface ThreadState {
  readonly status: ThreadStatus;
  readonly root: Message | null;
  readonly replies: readonly Message[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly refreshFailed: boolean;
  readonly reload: () => void;
  readonly loadMore: () => void;
  /**
   * Show a reply the server just accepted. Returns false when it was NOT inserted: with replies still unloaded
   * (`hasMore`) it would sit after a gap, so it is left for "Load more replies" or the next read.
   */
  readonly addSent: (reply: Message) => boolean;
}

/** A thread the viewer cannot read answers exactly like one that does not exist (403/404). */
function isUnavailable(status: number | undefined): boolean {
  return status === 403 || status === 404;
}

export function useThread(
  channelId: string,
  rootId: string,
  liveHint: LiveHint | null,
): ThreadState {
  const client = useApiClient();
  const [status, setStatus] = useState<ThreadStatus>("loading");
  const [root, setRoot] = useState<Message | null>(null);
  const [replies, setReplies] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const generationRef = useRef(0);
  const repliesRef = useRef<Message[]>([]);
  const pagedBeyondFirstRef = useRef(false);
  const inFlightRef = useRef(false);
  const rereadRef = useRef(false);

  const read = useCallback(
    async (background: boolean): Promise<void> => {
      if (inFlightRef.current) {
        rereadRef.current = true;
        return;
      }
      inFlightRef.current = true;
      const generation = generationRef.current;
      try {
        const { data, error, response } = await client.GET(
          "/api/v1/messaging/channels/{id}/messages/{messageId}/thread",
          {
            params: {
              path: { id: channelId, messageId: rootId },
              query: { limit: THREAD_PAGE_SIZE },
            },
            ...(background ? { headers: BACKGROUND_REQUEST_HEADERS } : {}),
          },
        );
        if (generation !== generationRef.current) return;
        if (error || !data) {
          if (isUnavailable(response?.status)) setStatus("unavailable");
          else if (background) setRefreshFailed(true);
          else setStatus("failed");
          return;
        }
        const merged = mergeMessages(repliesRef.current, data.replies as Message[]);
        repliesRef.current = merged;
        setRoot(data.root as Message);
        setReplies(merged);
        // Replies beyond the first page were loaded on request: a first-page refresh must not forget their cursor.
        if (!pagedBeyondFirstRef.current)
          setCursor((data.nextCursor as string | undefined) ?? null);
        setRefreshFailed(false);
        setStatus("ready");
      } catch {
        // A rejected request (network down): a failed first load offers Retry; a failed refresh keeps what is shown.
        if (generation !== generationRef.current) return;
        if (background) setRefreshFailed(true);
        else setStatus("failed");
      } finally {
        if (generation === generationRef.current) {
          inFlightRef.current = false;
          if (rereadRef.current) {
            rereadRef.current = false;
            void read(true);
          }
        }
      }
    },
    [channelId, client, rootId],
  );

  // A different thread starts from nothing; the previous thread's late reply is dropped by the generation.
  useEffect(() => {
    generationRef.current += 1;
    repliesRef.current = [];
    pagedBeyondFirstRef.current = false;
    inFlightRef.current = false;
    rereadRef.current = false;
    setStatus("loading");
    setRoot(null);
    setReplies([]);
    setCursor(null);
    setLoadingMore(false);
    setRefreshFailed(false);
    void read(false);
    return () => {
      generationRef.current += 1;
    };
  }, [read]);

  // A hint that concerns this thread (a reply to it, or a change to its root), or a reconnect, re-reads it.
  const handledSeq = useRef(liveHint?.seq ?? 0);
  useEffect(() => {
    if (!liveHint || liveHint.seq === handledSeq.current) return;
    handledSeq.current = liveHint.seq;
    const concernsThread =
      (liveHint.messageId === null && liveHint.parentMessageId === null) ||
      liveHint.parentMessageId === rootId ||
      liveHint.messageId === rootId;
    if (concernsThread) void read(true);
  }, [liveHint, read, rootId]);

  const loadMore = useCallback((): void => {
    if (!cursor || loadingMore) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    void (async () => {
      try {
        const { data, error } = await client.GET(
          "/api/v1/messaging/channels/{id}/messages/{messageId}/thread",
          {
            params: {
              path: { id: channelId, messageId: rootId },
              query: { limit: THREAD_PAGE_SIZE, cursor },
            },
          },
        );
        if (generation !== generationRef.current) return;
        if (error || !data) {
          setRefreshFailed(true);
          return;
        }
        pagedBeyondFirstRef.current = true;
        const merged = mergeMessages(repliesRef.current, data.replies as Message[]);
        repliesRef.current = merged;
        setReplies(merged);
        setCursor((data.nextCursor as string | undefined) ?? null);
      } catch {
        if (generation === generationRef.current) setRefreshFailed(true);
      } finally {
        if (generation === generationRef.current) setLoadingMore(false);
      }
    })();
  }, [channelId, client, cursor, loadingMore, rootId]);

  const hasMoreRef = useRef(false);
  useLayoutEffect(() => {
    hasMoreRef.current = cursor !== null;
  }, [cursor]);
  const addSent = useCallback((reply: Message): boolean => {
    const bump = (current: Message | null): Message | null =>
      current
        ? { ...current, replyCount: (current.replyCount ?? 0) + 1, lastReplyAt: reply.createdAt }
        : current;
    setRoot(bump);
    if (hasMoreRef.current) return false;
    const merged = mergeMessages(repliesRef.current, [reply]);
    repliesRef.current = merged;
    setReplies(merged);
    return true;
  }, []);

  return {
    status,
    root,
    replies,
    hasMore: cursor !== null,
    loadingMore,
    refreshFailed,
    reload: () => void read(false),
    loadMore,
    addSent,
  };
}
