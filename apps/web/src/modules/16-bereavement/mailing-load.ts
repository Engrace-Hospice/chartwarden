// apps/web/src/modules/16-bereavement — the two read hooks the mailing screens share. Both keep the rules PR 1 settled for an
// oversight-only surface:
//   - a 403 is "this reader may not see it": state `hidden`, and the screen renders NOTHING (no error, no skeleton, no hint it exists);
//   - any other failure is said (the screen announces it) and, once something is on screen, never replaces it;
//   - a refetch (a poll, a filter change, a reload after a write, "Load more") never unmounts or blanks what is already shown.
// A response that a newer request superseded (or that arrives after an unmount) is dropped.
import { useCallback, useEffect, useRef, useState } from "react";
import { type CursorPage, errorMessage } from "./bereavement-api";

/** What every read helper in bereavement-api.ts answers with. */
export interface Fetched<T> {
  readonly data: T | null;
  readonly error: unknown;
  readonly status: number;
}

const FORBIDDEN = 403;

/** One value, read once and reloadable. */
export type Loaded<T> =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error"; message: string; status: number }
  | { kind: "ready"; data: T; notice: string | null; refreshing: boolean };

export function useLoaded<T>(
  fetcher: () => Promise<Fetched<T>>,
  failure: string,
): {
  state: Loaded<T>;
  reload: () => Promise<boolean>;
  /** Replace the value with a newer one the caller already holds (the answer of a write), without a second read. */
  adopt: (data: T) => void;
  /** Change the value on screen from the value on screen (a write answered for one part of it). */
  patch: (update: (prev: T) => T) => void;
} {
  const [state, setState] = useState<Loaded<T>>({ kind: "loading" });
  const latest = useRef(0);

  /** Resolves true when the value on screen is now current. */
  const reload = useCallback(async (): Promise<boolean> => {
    const mine = ++latest.current;
    setState((prev) => (prev.kind === "ready" ? { ...prev, refreshing: true } : prev));
    const { data, error, status } = await fetcher();
    if (mine !== latest.current) return false;
    if (error || data === null) {
      if (status === FORBIDDEN) {
        setState({ kind: "hidden" });
        return false;
      }
      const message = errorMessage(error, failure);
      setState((prev) =>
        prev.kind === "ready"
          ? { ...prev, notice: message, refreshing: false }
          : { kind: "error", message, status },
      );
      return false;
    }
    setState({ kind: "ready", data, notice: null, refreshing: false });
    return true;
  }, [fetcher, failure]);

  useEffect(() => {
    void reload();
    return () => {
      latest.current += 1;
    };
  }, [reload]);

  const adopt = useCallback((data: T): void => {
    latest.current += 1; // any read still in flight is older than this answer
    setState({ kind: "ready", data, notice: null, refreshing: false });
  }, []);

  const patch = useCallback((update: (prev: T) => T): void => {
    latest.current += 1;
    setState((prev) =>
      prev.kind === "ready"
        ? { kind: "ready", data: update(prev.data), notice: null, refreshing: false }
        : prev,
    );
  }, []);

  return { state, reload, adopt, patch };
}

/** A cursor-paginated list: the first page, then "Load more" appends. `P` is the page envelope (it may carry extra fields). */
export type Paged<T, P extends CursorPage<T> = CursorPage<T>> =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      rows: T[];
      hasMore: boolean;
      notice: string | null;
      /** A reload or a "Load more" is in flight: the rows below stay on screen. */
      busy: boolean;
      /** The newest page as the server sent it, for envelope fields beyond the rows (`redactedCategories`). */
      last: P;
    };

export function usePagedList<T, P extends CursorPage<T> = CursorPage<T>>(
  fetchPage: (cursor: string | null) => Promise<Fetched<P>>,
  failure: string,
): {
  state: Paged<T, P>;
  reload: () => Promise<boolean>;
  loadMore: () => Promise<boolean>;
} {
  const [state, setState] = useState<Paged<T, P>>({ kind: "loading" });
  const latest = useRef(0);
  const cursorRef = useRef<string | null>(null);

  const run = useCallback(
    async (cursor: string | null): Promise<boolean> => {
      const mine = ++latest.current;
      setState((prev) => (prev.kind === "ready" ? { ...prev, busy: true } : prev));
      const { data, error, status } = await fetchPage(cursor);
      if (mine !== latest.current) return false;
      if (error || data === null) {
        if (status === FORBIDDEN) {
          setState({ kind: "hidden" });
          return false;
        }
        const message = errorMessage(error, failure);
        setState((prev) =>
          prev.kind === "ready"
            ? { ...prev, notice: message, busy: false }
            : { kind: "error", message },
        );
        return false;
      }
      const rows = Array.isArray(data.data) ? data.data : [];
      cursorRef.current = data.next_cursor;
      setState((prev) => ({
        kind: "ready",
        rows: cursor !== null && prev.kind === "ready" ? [...prev.rows, ...rows] : rows,
        hasMore: data.has_more,
        notice: null,
        busy: false,
        last: data,
      }));
      return true;
    },
    [fetchPage, failure],
  );

  useEffect(() => {
    void run(null);
    return () => {
      latest.current += 1;
    };
  }, [run]);

  const reload = useCallback(() => run(null), [run]);
  const loadMore = useCallback(async (): Promise<boolean> => {
    const cursor = cursorRef.current;
    return cursor === null ? false : run(cursor);
  }, [run]);

  return { state, reload, loadMore };
}
