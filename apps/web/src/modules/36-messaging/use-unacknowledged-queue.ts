// M36 WP 4.9 (ADR-0076) - reads the supervisor's unacknowledged queue. The first page and "show more" pages are appended; the safety-net
// poll (the thread's own timer: backs off after failures, pauses in a hidden tab, re-reads on focus) re-reads the loaded span in ONE
// call (at most the server's maximum), so rows already on screen are refreshed rather than lost, and a failed refresh keeps the last
// list and says it may be stale. A monotonic request id lets only the newest answer write. Read-only.
import type {
  AckQueueCounts,
  AckQueueItemDto,
  AckQueueResponse,
  AckQueueStatus,
} from "@wardenx/types";
import { ACK_QUEUE_LIMIT_DEFAULT, ACK_QUEUE_LIMIT_MAX } from "@wardenx/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalApiClient } from "./use-handoffs-enabled";
import { useLatestPolling } from "./use-latest-polling";

export interface QueueFilter {
  readonly status: AckQueueStatus | "all";
  readonly overdueOnly: boolean;
}

export type QueueView =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  /** 401/403/404: the viewer may not use the queue; fail closed and offer no retry. */
  | { readonly status: "denied"; readonly signedOut: boolean }
  | {
      readonly status: "ready";
      readonly items: readonly AckQueueItemDto[];
      readonly counts: AckQueueCounts;
      readonly filtered: boolean;
      readonly nextCursor: string | null;
      /** The last refresh or "show more" failed; the list is the last good one. */
      readonly stale: boolean;
      readonly moreFailed: boolean;
    };

const DENIED = new Set([401, 403, 404]);

const queryOf = (filter: QueueFilter, limit: number, cursor?: string) => ({
  limit,
  ...(filter.status !== "all" ? { status: filter.status } : {}),
  ...(filter.overdueOnly ? { overdue: true } : {}),
  ...(cursor ? { cursor } : {}),
});

export function useUnacknowledgedQueue(filter: QueueFilter) {
  const client = useOptionalApiClient();
  const [view, setView] = useState<QueueView>({ status: "loading" });
  const [busyMore, setBusyMore] = useState(false);
  const latest = useRef(0);
  const loaded = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;

  const read = useCallback(
    async (limit: number): Promise<boolean> => {
      if (!client) return false;
      const id = ++latest.current;
      try {
        const { data, response } = await client.GET(
          "/api/v1/messaging/escalations/unacknowledged",
          {
            params: { query: queryOf(filter, limit) },
          },
        );
        if (id !== latest.current) return true;
        if (data) {
          loaded.current = data.items.length;
          const page = data as AckQueueResponse;
          setView({
            status: "ready",
            items: page.items,
            counts: page.counts,
            filtered: page.filtered,
            nextCursor: page.next_cursor,
            stale: false,
            moreFailed: false,
          });
          return true;
        }
        const code = response?.status ?? 0;
        if (DENIED.has(code)) setView({ status: "denied", signedOut: code === 401 });
        else
          setView((prev) =>
            prev.status === "ready" ? { ...prev, stale: true } : { status: "error" },
          );
        return false;
      } catch {
        if (id === latest.current)
          setView((prev) =>
            prev.status === "ready" ? { ...prev, stale: true } : { status: "error" },
          );
        return false;
      }
    },
    [client, filter],
  );

  // A new filter starts from a clean slate: the other filter's rows are never shown under this one.
  useEffect(() => {
    setView({ status: "loading" });
    loaded.current = 0;
    void read(ACK_QUEUE_LIMIT_DEFAULT);
    return () => {
      latest.current += 1;
    };
  }, [read]);

  const refresh = useCallback(
    () => read(Math.min(ACK_QUEUE_LIMIT_MAX, Math.max(ACK_QUEUE_LIMIT_DEFAULT, loaded.current))),
    [read],
  );
  useLatestPolling(refresh, false);

  const retry = useCallback(() => {
    setView((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    void read(ACK_QUEUE_LIMIT_DEFAULT);
  }, [read]);

  const showMore = useCallback(async () => {
    const current = viewRef.current;
    if (!client || current.status !== "ready" || !current.nextCursor || busyMore) return;
    const id = ++latest.current;
    setBusyMore(true);
    try {
      const { data } = await client.GET("/api/v1/messaging/escalations/unacknowledged", {
        params: { query: queryOf(filter, ACK_QUEUE_LIMIT_DEFAULT, current.nextCursor) },
      });
      if (id !== latest.current) return;
      if (!data) {
        setView({ ...current, moreFailed: true });
        return;
      }
      const page = data as AckQueueResponse;
      loaded.current = current.items.length + page.items.length;
      setView({
        ...current,
        items: [...current.items, ...page.items],
        counts: page.counts,
        nextCursor: page.next_cursor,
        stale: false,
        moreFailed: false,
      });
    } catch {
      if (id === latest.current) setView({ ...current, moreFailed: true });
    } finally {
      setBusyMore(false);
    }
  }, [client, filter, busyMore]);

  return { view, retry, showMore, busyMore };
}
