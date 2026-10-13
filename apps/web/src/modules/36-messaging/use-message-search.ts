// WP 2.7a: the in-conversation search read. Debounced, generation-guarded (a slow reply for an older query never
// replaces a newer one), cleared on a channel change. The query text only ever goes to the server as the request;
// it is not kept anywhere beyond this component's state.
import { useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "./messaging-types";
import { apiErrorMessage } from "./messaging-utils";

export const SEARCH_DEBOUNCE_MS = 300;
export const SEARCH_MIN_CHARS = 2;

export interface SearchFilters {
  /** A user id, or "" for anyone. */
  readonly sender: string;
  /** Local calendar dates (yyyy-mm-dd) or "". */
  readonly after: string;
  readonly before: string;
  readonly hasAttachment: boolean;
}

export const NO_FILTERS: SearchFilters = {
  sender: "",
  after: "",
  before: "",
  hasAttachment: false,
};

export interface SearchState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly results: readonly Message[];
  readonly nextCursor: string | null;
  readonly scanCapped: boolean;
  /** Bodies examined across every page of this search so far. */
  readonly scanned: number;
  readonly loadingMore: boolean;
  readonly error: string | null;
  /** A "show more" that failed: the results already loaded stay, this is the inline error beside them. */
  readonly moreError: string | null;
}

const IDLE: SearchState = {
  status: "idle",
  results: [],
  nextCursor: null,
  scanCapped: false,
  scanned: 0,
  loadingMore: false,
  error: null,
  moreError: null,
};

export const hasFilters = (filters: SearchFilters): boolean =>
  filters.sender !== "" || filters.after !== "" || filters.before !== "" || filters.hasAttachment;

/** "After" a day that comes later than "Before": nothing can match, so it is not sent. (yyyy-mm-dd sorts as dates.) */
export const isRangeInverted = (filters: SearchFilters): boolean =>
  filters.after !== "" && filters.before !== "" && filters.after > filters.before;

/** The first character count the server accepts is 2; one character is a hint, not a request. */
export const isSearchable = (query: string, filters: SearchFilters): boolean => {
  if (isRangeInverted(filters)) return false;
  const text = query.trim();
  return text.length >= SEARCH_MIN_CHARS || (text.length === 0 && hasFilters(filters));
};

function localDayStart(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

function nextLocalDayStart(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d! + 1);
}

export function queryFor(query: string, filters: SearchFilters, cursor?: string) {
  const text = query.trim();
  return {
    ...(text ? { q: text } : {}),
    ...(filters.sender ? { senderUserId: filters.sender } : {}),
    ...(filters.after ? { from: localDayStart(filters.after).toISOString() } : {}),
    // "Before" is a whole calendar day: the window ends at the start of the next one (not +24h: a DST day is 23 or 25).
    ...(filters.before ? { to: nextLocalDayStart(filters.before).toISOString() } : {}),
    ...(filters.hasAttachment ? { hasAttachment: true } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

interface UseMessageSearchInput {
  readonly channelId: string;
  readonly enabled: boolean;
  readonly query: string;
  readonly filters: SearchFilters;
}

export function useMessageSearch({ channelId, enabled, query, filters }: UseMessageSearchInput) {
  const client = useApiClient();
  const [state, setState] = useState<SearchState>(IDLE);
  const [retryTick, setRetryTick] = useState(0);
  const generationRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const run = useCallback(
    async (cursor: string | undefined, generation: number): Promise<void> => {
      try {
        const { data, error } = await client.GET("/api/v1/messaging/channels/{id}/search", {
          params: { path: { id: channelId }, query: queryFor(query, filters, cursor) },
        });
        if (generation !== generationRef.current) return;
        if (error || !data) {
          const message = apiErrorMessage(error, "This conversation could not be searched.");
          // A failed "show more" keeps what is already on screen; only a failed first page is a full error.
          setState((s) =>
            cursor
              ? { ...s, loadingMore: false, moreError: message }
              : { ...s, status: "error", loadingMore: false, error: message },
          );
          return;
        }
        const incoming = (data.results ?? []) as Message[];
        setState((s) => ({
          status: "ready",
          results: cursor ? [...s.results, ...incoming] : incoming,
          nextCursor: data.nextCursor ?? null,
          scanCapped: data.scanCapped,
          scanned: (cursor ? s.scanned : 0) + data.scanned,
          loadingMore: false,
          error: null,
          moreError: null,
        }));
      } catch {
        if (generation !== generationRef.current) return;
        const message = "This conversation could not be searched.";
        setState((s) =>
          cursor
            ? { ...s, loadingMore: false, moreError: message }
            : { ...s, status: "error", loadingMore: false, error: message },
        );
      }
    },
    [client, channelId, query, filters],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `retryTick` re-issues the same search on demand
  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    if (!enabled || !isSearchable(query, filters)) {
      setState(IDLE);
      return;
    }
    setState({ ...IDLE, status: "loading" });
    const timer = window.setTimeout(() => void run(undefined, generation), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, query, filters, run, retryTick]);

  const loadMore = useCallback((): void => {
    const cursor = stateRef.current.nextCursor;
    if (!cursor || stateRef.current.loadingMore) return;
    setState((s) => ({ ...s, loadingMore: true, moreError: null }));
    void run(cursor, generationRef.current);
  }, [run]);

  const retry = useCallback((): void => setRetryTick((tick) => tick + 1), []);

  return { state, loadMore, retry };
}
