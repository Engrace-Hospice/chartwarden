// WP 2.7b: the org-wide message search read. Whole words and word beginnings only (the server's blind-token index).
// Debounced; every request has an AbortController that a newer query, a close or an unmount cancels, so a slow reply for
// an older query can never replace a newer one. The query text lives ONLY in the caller's component state and in the
// request itself: it is never written to storage, a URL, a log or an analytics call.
import { useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiErrorMessage } from "./messaging-utils";

export const GLOBAL_SEARCH_DEBOUNCE_MS = 300;
/** The server's tokenizer drops words shorter than this. */
export const GLOBAL_SEARCH_MIN_CHARS = 3;
const PAGE_SIZE = 25;

export type GlobalSearchFailure =
  | { readonly kind: "off" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "rate-limited"; readonly retryAfterSeconds: number | null }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "offline" }
  | { readonly kind: "other" };

export interface GlobalSearchHit {
  readonly messageId: string;
  readonly channelId: string;
  readonly authorDisplayName: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly archived: boolean;
}

export interface GlobalSearchState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly results: readonly GlobalSearchHit[];
  readonly nextCursor: string | null;
  readonly scanCapped: boolean;
  readonly refine: boolean;
  readonly loadingMore: boolean;
  readonly failure: GlobalSearchFailure | null;
  /** A failed "Load more": the loaded results stay on screen. */
  readonly moreFailure: GlobalSearchFailure | null;
}

const IDLE: GlobalSearchState = {
  status: "idle",
  results: [],
  nextCursor: null,
  scanCapped: false,
  refine: false,
  loadingMore: false,
  failure: null,
  moreFailure: null,
};

/** A page appended after the first can repeat a message the index returned earlier; keep the first occurrence. */
function appendUnique(
  current: readonly GlobalSearchHit[],
  incoming: readonly GlobalSearchHit[],
): readonly GlobalSearchHit[] {
  const seen = new Set(current.map((hit) => hit.messageId));
  return [...current, ...incoming.filter((hit) => !seen.has(hit.messageId))];
}

export const isGlobalSearchable = (query: string): boolean =>
  query.trim().length >= GLOBAL_SEARCH_MIN_CHARS;

function retryAfterOf(response: Response | undefined): number | null {
  const raw = response?.headers?.get?.("Retry-After");
  const seconds = raw === null || raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

export function failureOf(
  status: number | undefined,
  error: unknown,
  response?: Response,
): GlobalSearchFailure {
  if (status === 403) return { kind: "off" };
  if (status === 429) return { kind: "rate-limited", retryAfterSeconds: retryAfterOf(response) };
  if (status === 503) return { kind: "unavailable" };
  if (status === 422) {
    return { kind: "invalid", message: apiErrorMessage(error, "That search cannot be run.") };
  }
  return { kind: "other" };
}

export function useGlobalSearch(query: string, enabled: boolean) {
  const client = useApiClient();
  const [state, setState] = useState<GlobalSearchState>(IDLE);
  const [retryTick, setRetryTick] = useState(0);
  // Once the server says search is not turned on, stop asking on every keystroke (the page remounts per organisation).
  const [refused, setRefused] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const cursorRef = useRef<string | null>(null);
  cursorRef.current = state.nextCursor;

  const run = useCallback(
    async (text: string, cursor: string | undefined, controller: AbortController) => {
      const fail = (failure: GlobalSearchFailure): void => {
        if (controller.signal.aborted) return;
        if (failure.kind === "off") setRefused(true);
        setState((s) =>
          cursor
            ? { ...s, loadingMore: false, moreFailure: failure }
            : { ...IDLE, status: "error", failure },
        );
      };
      try {
        const { data, error, response } = await client.GET("/api/v1/messaging/search", {
          params: { query: { q: text, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) } },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (error || !data) return fail(failureOf(response?.status, error, response));
        setState((s) => ({
          status: "ready",
          results: cursor ? appendUnique(s.results, data.results) : data.results,
          nextCursor: data.nextCursor ?? null,
          scanCapped: data.scanCapped,
          refine: data.refine,
          loadingMore: false,
          failure: null,
          moreFailure: null,
        }));
      } catch {
        // An aborted request is a superseded one (fail() ignores it); anything else is a network failure.
        fail({ kind: "offline" });
      }
    },
    [client],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `retryTick` re-issues the same search on demand
  useEffect(() => {
    if (!enabled) {
      // Closing the panel forgets a refusal: reopening asks the server again.
      setRefused(false);
      setState(IDLE);
      return;
    }
    if (!isGlobalSearchable(query)) {
      setState(IDLE);
      return;
    }
    if (refused) {
      setState({ ...IDLE, status: "error", failure: { kind: "off" } });
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ ...IDLE, status: "loading" });
    const timer = window.setTimeout(
      () => void run(query.trim(), undefined, controller),
      GLOBAL_SEARCH_DEBOUNCE_MS,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, enabled, refused, run, retryTick]);

  const loadMore = useCallback((): void => {
    const cursor = cursorRef.current;
    const controller = controllerRef.current;
    if (!cursor || !controller || controller.signal.aborted) return;
    setState((s) => ({ ...s, loadingMore: true, moreFailure: null }));
    void run(query.trim(), cursor, controller);
  }, [query, run]);

  const retry = useCallback((): void => setRetryTick((n) => n + 1), []);
  return { state, retry, loadMore };
}
