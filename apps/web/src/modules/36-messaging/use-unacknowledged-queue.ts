// M36 WP 4.9 (ADR-0076) - reads the supervisor's unacknowledged queue. The first page and "show more" pages are appended; the safety-net
// poll (the thread's own timer: backs off after failures, pauses in a hidden tab, re-reads on focus) re-reads the WHOLE loaded span
// (page after page, so a list the person extended is not shrunk) and a failed refresh keeps the last list and says it may be stale.
// Two tokens keep answers honest: `generation` changes with the filter (and on unmount), so an answer for an old filter is dropped as
// superseded (never a failure); a "show more" answer is applied only if the list it extends is still the one it was asked for, and
// otherwise says so (`moreFailed`) instead of vanishing. A poll waits while a "show more" is in flight. A 401/403/404 stops all
// further reads. Read-only.
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
      /** The last refresh failed; the list is the last good one. */
      readonly stale: boolean;
      /** "Show more" failed, or its page no longer fitted the list (a refresh replaced it): ask again. */
      readonly moreFailed: boolean;
    };

const DENIED = new Set([401, 403, 404]);
/** Most pages a refresh chains to rebuild a long span (10 x 100 rows); beyond it the list restarts from the top and says "Show more". */
const MAX_SPAN_PAGES = 10;

const queryOf = (filter: QueueFilter, limit: number, cursor?: string) => ({
  limit,
  ...(filter.status !== "all" ? { status: filter.status } : {}),
  ...(filter.overdueOnly ? { overdue: true } : {}),
  ...(cursor ? { cursor } : {}),
});

export function useUnacknowledgedQueue({ status, overdueOnly }: QueueFilter) {
  const client = useOptionalApiClient();
  const [view, setView] = useState<QueueView>({ status: "loading" });
  const [busyMore, setBusyMore] = useState(false);
  const generation = useRef(0);
  const seq = useRef(0);
  const moreBusy = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  const get = useCallback(
    (cursor: string | undefined, limit: number) =>
      (client as NonNullable<typeof client>).GET("/api/v1/messaging/escalations/unacknowledged", {
        params: { query: queryOf({ status, overdueOnly }, limit, cursor) },
      }),
    [client, status, overdueOnly],
  );

  /** Re-reads at least `target` rows from the top (pages chained by cursor). Returns false only for a real failure. */
  const read = useCallback(
    async (target: number): Promise<boolean> => {
      if (!client || viewRef.current.status === "denied") return true;
      const gen = generation.current;
      const id = ++seq.current;
      const current = (): boolean => gen === generation.current && id === seq.current;
      try {
        let items: AckQueueItemDto[] = [];
        let last: AckQueueResponse | null = null;
        let cursor: string | undefined;
        for (let page = 0; page < MAX_SPAN_PAGES; page += 1) {
          const want = Math.min(
            ACK_QUEUE_LIMIT_MAX,
            Math.max(ACK_QUEUE_LIMIT_DEFAULT, target - items.length),
          );
          const { data, response } = await get(cursor, want);
          if (!current()) return true; // superseded: not a failure
          if (!data) {
            const code = response?.status ?? 0;
            if (DENIED.has(code)) {
              setView({ status: "denied", signedOut: code === 401 });
              return true; // nothing more to ask; stop the back-off
            }
            setView((prev) =>
              prev.status === "ready" ? { ...prev, stale: true } : { status: "error" },
            );
            return false;
          }
          last = data as AckQueueResponse;
          items = [...items, ...last.items];
          cursor = last.next_cursor ?? undefined;
          if (!cursor || items.length >= target) break;
        }
        if (!last) return true;
        const final = last;
        setView({
          status: "ready",
          items,
          counts: final.counts,
          filtered: final.filtered,
          nextCursor: final.next_cursor,
          stale: false,
          moreFailed: false,
        });
        return true;
      } catch {
        if (!current()) return true;
        setView((prev) =>
          prev.status === "ready" ? { ...prev, stale: true } : { status: "error" },
        );
        return false;
      }
    },
    [client, get],
  );

  // A new filter starts from a clean slate: the other filter's rows, in-flight answers and "show more" are all dropped.
  useEffect(() => {
    generation.current += 1;
    moreBusy.current = false;
    setBusyMore(false);
    setView({ status: "loading" });
    void read(1); // one page: the server fills it whenever more exist
    return () => {
      generation.current += 1;
    };
  }, [read]);

  const loadedCount = useCallback((): number => {
    const v = viewRef.current;
    return v.status === "ready" ? v.items.length : 1;
  }, []);

  const refresh = useCallback(
    () => (moreBusy.current ? Promise.resolve(true) : read(loadedCount())),
    [read, loadedCount],
  );
  useLatestPolling(refresh, false);

  const retry = useCallback(() => {
    setView((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    void read(loadedCount());
  }, [read, loadedCount]);

  const showMore = useCallback(async () => {
    const current = viewRef.current;
    if (!client || current.status !== "ready" || !current.nextCursor || moreBusy.current) return;
    const gen = generation.current;
    const asked = current.nextCursor;
    moreBusy.current = true;
    setBusyMore(true);
    try {
      const { data } = await get(asked, ACK_QUEUE_LIMIT_DEFAULT);
      if (gen !== generation.current) return; // another filter owns the screen now
      setView((prev) => {
        if (prev.status !== "ready") return prev;
        // The list moved on (a refresh replaced it): the page no longer extends it. Say so instead of dropping it silently.
        if (!data || prev.nextCursor !== asked) return { ...prev, moreFailed: true };
        const page = data as AckQueueResponse;
        return {
          ...prev,
          items: [...prev.items, ...page.items],
          counts: page.counts,
          nextCursor: page.next_cursor,
          stale: false,
          moreFailed: false,
        };
      });
    } catch {
      if (gen === generation.current) {
        setView((prev) => (prev.status === "ready" ? { ...prev, moreFailed: true } : prev));
      }
    } finally {
      if (gen === generation.current) {
        moreBusy.current = false;
        setBusyMore(false);
      }
    }
  }, [client, get]);

  return { view, retry, showMore, busyMore };
}
