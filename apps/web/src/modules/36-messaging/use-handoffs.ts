// M36 WP 3.5 - the caller's handoffs (list) and the actions on one. No optimistic state: a row only changes when the
// server's answer replaces it, and a refusal leaves it untouched. Action enablement comes from `allowed_actions` only.
import type { HandoffDto } from "@wardenx/types";
import { useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";

export type HandoffScope = "incoming" | "outgoing";
export type HandoffStateFilter = "active" | "closed";

export type HandoffsView =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | {
      readonly status: "ready";
      readonly enabled: boolean;
      readonly handoffs: readonly HandoffDto[];
    };

export type HandoffsSource = ReturnType<typeof useHandoffs>;

/** `skip` leaves the list unread (the caller is borrowing another source, or the tenant has handoffs off). */
export function useHandoffs(scope: HandoffScope, state: HandoffStateFilter, skip = false) {
  const client = useApiClient();
  const [view, setView] = useState<HandoffsView>({ status: "loading" });
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the manual re-read trigger
  useEffect(() => {
    if (skip) return;
    let current = true;
    setView({ status: "loading" });
    client
      .GET("/api/v1/messaging/handoffs", { params: { query: { scope, state } } })
      .then(({ data }) => {
        if (!current) return;
        setView(
          data
            ? {
                status: "ready",
                enabled: data.enabled === true,
                handoffs: data.enabled === true ? data.handoffs : [],
              }
            : { status: "error" },
        );
      })
      .catch(() => {
        if (current) setView({ status: "error" });
      });
    return () => {
      current = false;
    };
  }, [client, scope, state, tick, skip]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { view, reload };
}

export type HandoffResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number | undefined; readonly code: string | undefined };

interface RawAnswer<T> {
  readonly data?: T;
  readonly error?: { readonly error?: { readonly code?: string } };
  readonly response?: { readonly status: number };
}

export const NETWORK_FAILURE: HandoffResult<never> = {
  ok: false,
  status: undefined,
  code: undefined,
};

export function toResult<T>(answer: RawAnswer<T>): HandoffResult<T> {
  if (answer.data !== undefined) return { ok: true, data: answer.data };
  return { ok: false, status: answer.response?.status, code: answer.error?.error?.code };
}

export interface HandoffActions {
  readonly get: (id: string) => Promise<HandoffResult<{ handoff: HandoffDto }>>;
  readonly accept: (
    id: string,
    itemIds: readonly string[],
  ) => Promise<HandoffResult<{ handoff: HandoffDto }>>;
  /** `itemIds` omitted declines every pending item. */
  readonly decline: (
    id: string,
    itemIds?: readonly string[],
  ) => Promise<HandoffResult<{ handoff: HandoffDto }>>;
  readonly cancel: (id: string) => Promise<HandoffResult<{ handoff: HandoffDto }>>;
}

export function useHandoffActions(): HandoffActions {
  const client = useApiClient();
  return useMemo(() => {
    const path = (handoffId: string) => ({ params: { path: { handoffId } } });
    return {
      get: (id) =>
        client
          .GET("/api/v1/messaging/handoffs/{handoffId}", path(id))
          .then(toResult, () => NETWORK_FAILURE),
      accept: (id, itemIds) =>
        client
          .POST("/api/v1/messaging/handoffs/{handoffId}/accept", {
            ...path(id),
            body: { item_ids: [...itemIds] },
          })
          .then(toResult, () => NETWORK_FAILURE),
      decline: (id, itemIds) =>
        client
          .POST("/api/v1/messaging/handoffs/{handoffId}/decline", {
            ...path(id),
            body: itemIds ? { item_ids: [...itemIds] } : {},
          })
          .then(toResult, () => NETWORK_FAILURE),
      cancel: (id) =>
        client
          .POST("/api/v1/messaging/handoffs/{handoffId}/cancel", path(id))
          .then(toResult, () => NETWORK_FAILURE),
    };
  }, [client]);
}
