// M36 WP 3.7 - the caller's chart proposals (list) and the actions on them. No optimistic state: a row only changes
// when the server's answer replaces it. Action enablement comes from `allowed_actions` only.
import type {
  ChartPromotionDto,
  ChartPromotionTargetKind,
  ChartPromotionTargetModule,
} from "@chartwarden/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { refreshPromotions, useOptionalApiClient } from "./use-promotions-enabled";

export type PromotionStatusFilter = "active" | "closed";

export type PromotionsView =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly promotions: readonly ChartPromotionDto[] };

export function usePromotions(filter: PromotionStatusFilter) {
  const client = useOptionalApiClient();
  // The view remembers which filter it answered, so a filter switch reads as loading and never shows the other
  // filter's rows (Open rows with live Withdraw buttons under Closed).
  const [answer, setAnswer] = useState<{
    readonly filter: PromotionStatusFilter;
    readonly view: PromotionsView;
  } | null>(null);
  const view: PromotionsView =
    answer && answer.filter === filter ? answer.view : { status: "loading" };
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the manual re-read trigger
  useEffect(() => {
    if (!client) return;
    let current = true;
    client
      .GET("/api/v1/messaging/chart-promotions", { params: { query: { status: filter } } })
      .then(({ data }) => {
        if (!current) return;
        setAnswer({
          filter,
          view: data
            ? { status: "ready", promotions: data.enabled === true ? data.promotions : [] }
            : { status: "error" },
        });
      })
      .catch(() => {
        if (current) setAnswer({ filter, view: { status: "error" } });
      });
    return () => {
      current = false;
    };
  }, [client, filter, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { view, reload };
}

export type PromotionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number | undefined; readonly code: string | undefined };

interface RawAnswer<T> {
  readonly data?: T;
  readonly error?: { readonly error?: { readonly code?: string } };
  readonly response?: { readonly status: number };
}

const NETWORK_FAILURE: PromotionResult<never> = { ok: false, status: undefined, code: undefined };

function toResult<T>(answer: RawAnswer<T>): PromotionResult<T> {
  if (answer.data !== undefined) return { ok: true, data: answer.data };
  return { ok: false, status: answer.response?.status, code: answer.error?.error?.code };
}

export interface ProposeBody {
  readonly target_module: ChartPromotionTargetModule;
  readonly target_kind: ChartPromotionTargetKind;
}

export interface PromotionActions {
  readonly propose: (
    channelId: string,
    messageId: string,
    body: ProposeBody,
  ) => Promise<PromotionResult<{ promotion: ChartPromotionDto; created: boolean }>>;
  readonly withdraw: (id: string) => Promise<PromotionResult<{ promotion: ChartPromotionDto }>>;
}

export function usePromotionActions(): PromotionActions {
  const client = useOptionalApiClient();
  return useMemo(
    () => ({
      propose: (channelId, messageId, body) =>
        !client
          ? Promise.resolve(NETWORK_FAILURE)
          : client
              .POST("/api/v1/messaging/channels/{id}/messages/{messageId}/chart-promotions", {
                params: { path: { id: channelId, messageId } },
                body,
              })
              .then(
                (answer) => {
                  refreshPromotions(client);
                  return toResult(answer);
                },
                () => NETWORK_FAILURE,
              ),
      withdraw: (id) =>
        !client
          ? Promise.resolve(NETWORK_FAILURE)
          : client
              .POST("/api/v1/messaging/chart-promotions/{promotionId}/withdraw", {
                params: { path: { promotionId: id } },
              })
              .then(
                (answer) => {
                  refreshPromotions(client);
                  return toResult(answer);
                },
                () => NETWORK_FAILURE,
              ),
    }),
    [client],
  );
}
