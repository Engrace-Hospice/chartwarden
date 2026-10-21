// M36 WP 3.8 - the lifecycle review queue (list) and the two decisions on one item. No optimistic state: a row only
// changes when the server's answer replaces it (the list re-reads). Action enablement comes from `allowed_actions` only.
import type { ReviewItemDto, TaskCloseReason } from "@chartwarden/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalApiClient } from "./use-handoffs-enabled";

export type ReviewStateFilter = "open" | "resolved";

export type ReviewView =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  /** 401/403/404: the viewer may not use the queue (or it is off): the tab goes away, fail closed. */
  | { readonly status: "denied" }
  | {
      readonly status: "ready";
      readonly enabled: boolean;
      readonly items: readonly ReviewItemDto[];
    };

export type ReviewSource = ReturnType<typeof useReviewItems>;

const DENIED = new Set([401, 403, 404]);

/** `skip` leaves the list unread (the tab is not shown). */
export function useReviewItems(state: ReviewStateFilter, skip = false) {
  const client = useOptionalApiClient();
  // The answer remembers which state it belongs to, so a switch reads as loading and never shows the other state's rows
  // (Open rows with live buttons under Resolved).
  const [answer, setAnswer] = useState<{
    readonly state: ReviewStateFilter;
    readonly view: ReviewView;
  } | null>(null);
  const view: ReviewView = answer && answer.state === state ? answer.view : { status: "loading" };
  const [tick, setTick] = useState(0);
  const latest = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the manual re-read trigger
  useEffect(() => {
    if (skip || !client) return;
    // Monotonic request id: only the newest request may write, so a slow older answer never overwrites a newer one.
    const id = ++latest.current;
    const write = (next: ReviewView): void => {
      if (id === latest.current) setAnswer({ state, view: next });
    };
    client
      .GET("/api/v1/messaging/review-items", { params: { query: { state } } })
      .then(({ data, response }) => {
        if (data)
          write({
            status: "ready",
            enabled: data.enabled === true,
            items: data.enabled === true ? data.items : [],
          });
        else write(DENIED.has(response?.status ?? 0) ? { status: "denied" } : { status: "error" });
      })
      .catch(() => write({ status: "error" }));
    return () => {
      latest.current += 1;
    };
  }, [client, state, tick, skip]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { view, reload };
}

export type ReviewActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number | undefined; readonly code: string | undefined };

interface RawAnswer {
  readonly data?: unknown;
  readonly error?: { readonly error?: { readonly code?: string } };
  readonly response?: { readonly status: number };
}

const NETWORK_FAILURE: ReviewActionResult = { ok: false, status: undefined, code: undefined };

function toResult(answer: RawAnswer): ReviewActionResult {
  if (answer.data !== undefined) return { ok: true };
  return { ok: false, status: answer.response?.status, code: answer.error?.error?.code };
}

export interface ReviewActions {
  readonly reassign: (reviewItemId: string, toUserId: string) => Promise<ReviewActionResult>;
  readonly close: (reviewItemId: string, reason: TaskCloseReason) => Promise<ReviewActionResult>;
}

export function useReviewActions(): ReviewActions {
  const client = useOptionalApiClient();
  return useMemo(() => {
    const path = (reviewItemId: string) => ({ params: { path: { reviewItemId } } });
    return {
      reassign: (reviewItemId, toUserId) =>
        !client
          ? Promise.resolve(NETWORK_FAILURE)
          : client
              .POST("/api/v1/messaging/review-items/{reviewItemId}/reassign", {
                ...path(reviewItemId),
                body: { to_user_id: toUserId },
              })
              .then(toResult, () => NETWORK_FAILURE),
      close: (reviewItemId, reason) =>
        !client
          ? Promise.resolve(NETWORK_FAILURE)
          : client
              .POST("/api/v1/messaging/review-items/{reviewItemId}/close", {
                ...path(reviewItemId),
                body: { reason },
              })
              .then(toResult, () => NETWORK_FAILURE),
    };
  }, [client]);
}
