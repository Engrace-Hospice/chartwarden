// M36 WP 4.10 (ADR-0077) - the caller's snooze of ONE conversation. One read per mount of a channel (no polling: the end of a snooze is
// compared with the clock at render, and a snooze ended elsewhere shows on the next visit). The server is the authority on whether the
// conversation can be snoozed: the control follows `snoozable`. A 404 means the feature is off for the tenant (nothing is shown).
import type { SnoozeDto } from "@wardenx/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalApiClient } from "./use-promotions-enabled";

export type SnoozeView =
  | { readonly status: "loading" }
  | { readonly status: "off" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly snooze: SnoozeDto };

export type SnoozeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number | undefined; readonly code: string | undefined };

interface RawAnswer {
  readonly data?: SnoozeDto | { readonly cleared: boolean };
  readonly error?: { readonly error?: { readonly code?: string } };
  readonly response?: { readonly status: number };
}

const NETWORK_FAILURE: SnoozeResult = { ok: false, status: undefined, code: undefined };

export function useChannelSnooze(channelId: string) {
  const client = useOptionalApiClient();
  const [view, setView] = useState<SnoozeView>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const generation = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the manual re-read trigger
  useEffect(() => {
    if (!client) return;
    const mine = ++generation.current;
    setView({ status: "loading" });
    Promise.resolve()
      .then(() =>
        client.GET("/api/v1/messaging/channels/{id}/snooze", {
          params: { path: { id: channelId } },
        }),
      )
      .then((answer) => {
        if (mine !== generation.current) return;
        if (answer.data && typeof answer.data.snoozable === "boolean") {
          setView({ status: "ready", snooze: answer.data });
        } else setView({ status: answer.response?.status === 404 ? "off" : "error" });
      })
      .catch(() => {
        if (mine === generation.current) setView({ status: "error" });
      });
    return () => {
      generation.current += 1;
    };
  }, [client, channelId, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  const toResult = useCallback((answer: RawAnswer, next: SnoozeDto | null): SnoozeResult => {
    if (answer.data === undefined) {
      return { ok: false, status: answer.response?.status, code: answer.error?.error?.code };
    }
    if (next) setView({ status: "ready", snooze: next });
    return { ok: true };
  }, []);

  const snooze = useCallback(
    async (durationMinutes: number): Promise<SnoozeResult> => {
      if (!client) return NETWORK_FAILURE;
      try {
        const answer = await client.PUT("/api/v1/messaging/channels/{id}/snooze", {
          params: {
            path: { id: channelId },
            header: { "Idempotency-Key": crypto.randomUUID() },
          },
          body: { duration_minutes: durationMinutes },
        });
        return toResult(answer, answer.data ?? null);
      } catch {
        return NETWORK_FAILURE;
      }
    },
    [client, channelId, toResult],
  );

  const clear = useCallback(async (): Promise<SnoozeResult> => {
    if (!client) return NETWORK_FAILURE;
    try {
      const answer = await client.DELETE("/api/v1/messaging/channels/{id}/snooze", {
        params: { path: { id: channelId } },
      });
      return toResult(answer, { channel_id: channelId, snoozed_until: null, snoozable: true });
    } catch {
      return NETWORK_FAILURE;
    }
  }, [client, channelId, toResult]);

  return { view, reload, snooze, clear };
}
