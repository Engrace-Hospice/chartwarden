// WP 2.7a: the in-conversation search read. Debounced, generation-guarded (a slow reply for an older query never
// replaces a newer one), cleared on a channel change. The query text only ever goes to the server as the request;
// it is not kept anywhere beyond this component's state.
import { useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "./messaging-types";
import { apiErrorMessage } from "./messaging-utils";

export const SEARCH_DEBOUNCE_MS = 300;
export const SEARCH_MIN_CHARS = 2;
const DAY_MS = 86_400_000;

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
}

const IDLE: SearchState = {
  status: "idle",
  results: [],
  nextCursor: null,
  scanCapped: false,
  scanned: 0,
  loadingMore: false,
  error: null,
};

export const hasFilters = (filters: SearchFilters): boolean =>
  filters.sender !== "" || filters.after !== "" || filters.before !== "" || filters.hasAttachment;

/** The first character count the server accepts is 2; one character is a hint, not a request. */
export const isSearchable = (query: string, filters: SearchFilters): boolean => {
  const text = query.trim();
  return text.length >= SEARCH_MIN_CHARS || (text.length === 0 && hasFilters(filters));
};

function localDayStart(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

function queryFor(query: string, filters: SearchFilters, cursor?: string) {
  const text = query.trim();
  return {
    ...(text ? { q: text } : {}),
    ...(filters.sender ? { senderUserId: filters.sender } : {}),
    ...(filters.after ? { from: localDayStart(filters.after).toISOString() } : {}),
    // "Before" is a whole day: the window ends at the start of the next one.
    ...(filters.before
      ? { to: new Date(localDayStart(filters.before).getTime() + DAY_MS).toISOString() }
      : {}),
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
          setState((s) => ({
            ...s,
            status: "error",
            loadingMore: false,
            error: apiErrorMessage(error, "This conversation could not be searched."),
          }));
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
        }));
      } catch {
        if (generation !== generationRef.current) return;
        setState((s) => ({
          ...s,
          status: "error",
          loadingMore: false,
          error: "This conversation could not be searched.",
        }));
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
    setState((s) => ({ ...s, loadingMore: true }));
    void run(cursor, generationRef.current);
  }, [run]);

  const retry = useCallback((): void => setRetryTick((tick) => tick + 1), []);

  return { state, loadMore, retry };
}
