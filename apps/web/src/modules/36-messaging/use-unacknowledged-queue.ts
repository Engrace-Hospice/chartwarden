// M36 WP 4.9 (ADR-0076) - reads the supervisor's unacknowledged queue. The first page and "show more" pages are appended; the safety-net
// poll (the thread's own timer: backs off after failures, pauses in a hidden tab, re-reads on focus) re-reads the WHOLE loaded span
// (page after page, so a list the person extended is not shrunk) and a failed refresh keeps the last list and says it may be stale.
// Two tokens keep answers honest: `generation` changes with the filter (and on unmount), so an answer for an old filter is dropped as
// superseded (never a failure); a "show more" answer is applied only if the list it extends is still the one it was asked for, and
// otherwise says so (`moreFailed`) instead of vanishing. A poll waits while a "show more" is in flight, and a "show more" supersedes any
// read already in flight. After a 401/403/404 the poll and retry make no request; changing the filter asks again (the answer may differ).
// Read-only (the supervisor reassign is a separate dialog that calls `refresh` after it saves).
import type {
  AckQueueCounts,
  AckQueueItemDto,
  AckQueueResponse,
  AckQueueStatus,
} from "@chartwarden/types";
import { ACK_QUEUE_LIMIT_DEFAULT, ACK_QUEUE_LIMIT_MAX } from "@chartwarden/types";
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
      /** A refresh could not rebuild the whole loaded span (more than MAX_SPAN_PAGES pages): the list restarted from the top. */
      readonly spanCapped: boolean;
      /** "Show more" failed, or its page no longer fitted the list (a refresh replaced it): ask again. */
      readonly moreFailed: boolean;
    };

const DENIED = new Set([401, 403, 404]);
/** Most pages a refresh chains to rebuild a long span (10 x 100 rows); beyond it the list restarts from the top and says "Show more". */
export const MAX_SPAN_PAGES = 10;
/** A "show more" that has not answered by now is given up on (the client sets no timeout of its own): the button comes back with an alert. */
export const SHOW_MORE_TIMEOUT_MS = 30_000;

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
  const moreToken = useRef(0);
  const retryPending = useRef(false);
  const deniedRef = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  const get = useCallback(
    (cursor: string | undefined, limit: number) =>
      (client as NonNullable<typeof client>).GET("/api/v1/messaging/escalations/unacknowledged", {
        params: { query: queryOf({ status, overdueOnly }, limit, cursor) },
      }),
    [client, status, overdueOnly],
  );

  /** Re-reads at least `target` rows from the top (pages chained by cursor). `false` = a real failure; `undefined` = nothing learned (superseded or skipped). */
  const read = useCallback(
    async (target: number): Promise<boolean | undefined> => {
      if (!client || deniedRef.current) return undefined;
      const gen = generation.current;
      const id = ++seq.current;
      const current = (): boolean =>
        gen === generation.current && id === seq.current && !moreBusy.current;
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
          if (!current()) return undefined; // superseded: not a failure, and not a success either
          if (!data) {
            const code = response?.status ?? 0;
            if (DENIED.has(code)) {
              deniedRef.current = true;
              setView({ status: "denied", signedOut: code === 401 });
              return undefined; // nothing more to ask
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
        if (!last) return undefined;
        const final = last;
        setView((prev) => ({
          status: "ready",
          items,
          counts: final.counts,
          filtered: final.filtered,
          nextCursor: final.next_cursor,
          stale: false,
          // Still capped while the list sits at the cap and more remain: a restart from the top must not make the note vanish.
          spanCapped:
            final.next_cursor !== null &&
            (items.length < target ||
              (prev.status === "ready" &&
                prev.spanCapped &&
                items.length >= MAX_SPAN_PAGES * ACK_QUEUE_LIMIT_MAX)),
          // a refresh does not wipe the "show more" alert: only asking again (or a new filter) does
          moreFailed: prev.status === "ready" && prev.moreFailed,
        }));
        return true;
      } catch {
        if (!current()) return undefined;
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
    moreToken.current += 1;
    retryPending.current = false;
    deniedRef.current = false;
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
    () => (moreBusy.current ? Promise.resolve(undefined) : read(loadedCount())),
    [read, loadedCount],
  );
  useLatestPolling(refresh, false);

  const retry = useCallback(() => {
    // A "show more" is in flight and would discard this read: queue one refresh for when it settles instead of swallowing the click.
    if (moreBusy.current) {
      retryPending.current = true;
      return;
    }
    setView((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    void read(loadedCount());
  }, [read, loadedCount]);

  const showMore = useCallback(async () => {
    const current = viewRef.current;
    if (!client || current.status !== "ready" || !current.nextCursor || moreBusy.current) return;
    const gen = generation.current;
    const token = ++moreToken.current;
    const asked = current.nextCursor;
    moreBusy.current = true;
    seq.current += 1; // supersede any read already in flight: it must not overwrite the page about to be appended
    setBusyMore(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The length the list has once this settles (known here, not read back from a render): what a queued refresh must ask for.
    let settledLength = current.items.length;
    try {
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), SHOW_MORE_TIMEOUT_MS);
      });
      const answer = await Promise.race([get(asked, ACK_QUEUE_LIMIT_DEFAULT), timeout]);
      if (gen !== generation.current || token !== moreToken.current) return; // another filter owns the screen / given up on
      const data = answer?.data;
      if (data) {
        settledLength = current.items.length + (data as AckQueueResponse).items.length;
      }
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
          spanCapped: false,
          moreFailed: false,
        };
      });
    } catch {
      if (gen === generation.current && token === moreToken.current) {
        setView((prev) => (prev.status === "ready" ? { ...prev, moreFailed: true } : prev));
      }
    } finally {
      clearTimeout(timer);
      if (gen === generation.current && token === moreToken.current) {
        moreBusy.current = false;
        setBusyMore(false);
        if (retryPending.current) {
          retryPending.current = false;
          void read(settledLength);
        }
      }
    }
  }, [client, get, read]);

  return { view, retry, refresh: retry, showMore, busyMore };
}
