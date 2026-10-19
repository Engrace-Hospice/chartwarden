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
  // The stored view remembers its channel, so a channel switch reads as loading while a reload of the SAME channel keeps the last answer
  // on screen (the control, its dialog and its live region are not unmounted by a re-read).
  const [stored, setStored] = useState<{
    readonly channelId: string;
    readonly view: SnoozeView;
  } | null>(null);
  const view: SnoozeView =
    stored && stored.channelId === channelId ? stored.view : { status: "loading" };
  const setView = useCallback(
    (next: SnoozeView) => setStored({ channelId, view: next }),
    [channelId],
  );
  /** A failed RE-read keeps the last good view (only a 404 turns the feature off); a failed first read is an error. */
  const keepReadyOr = useCallback(
    (next: SnoozeView) =>
      setStored((prev) =>
        prev && prev.channelId === channelId && prev.view.status === "ready"
          ? prev
          : { channelId, view: next },
      ),
    [channelId],
  );
  const [tick, setTick] = useState(0);
  const generation = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the manual re-read trigger
  useEffect(() => {
    if (!client) return;
    const mine = ++generation.current;
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
        } else if (answer.response?.status === 404) setView({ status: "off" });
        else keepReadyOr({ status: "error" });
      })
      .catch(() => {
        if (mine === generation.current) keepReadyOr({ status: "error" });
      });
    return () => {
      generation.current += 1;
    };
  }, [client, channelId, tick, setView, keepReadyOr]);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  const toResult = useCallback(
    (answer: RawAnswer, next: SnoozeDto | null, started: number): SnoozeResult => {
      if (answer.data === undefined) {
        return { ok: false, status: answer.response?.status, code: answer.error?.error?.code };
      }
      // A channel switch or a newer read since the write started owns the view; this answer must not overwrite it.
      if (next && started === generation.current) setView({ status: "ready", snooze: next });
      return { ok: true };
    },
    [setView],
  );

  const snooze = useCallback(
    async (durationMinutes: number, idempotencyKey?: string): Promise<SnoozeResult> => {
      if (!client) return NETWORK_FAILURE;
      const started = generation.current;
      try {
        const answer = await client.PUT("/api/v1/messaging/channels/{id}/snooze", {
          params: {
            path: { id: channelId },
            header: { "Idempotency-Key": idempotencyKey ?? crypto.randomUUID() },
          },
          body: { duration_minutes: durationMinutes },
        });
        return toResult(answer, answer.data ?? null, started);
      } catch {
        return NETWORK_FAILURE;
      }
    },
    [client, channelId, toResult],
  );

  const clear = useCallback(async (): Promise<SnoozeResult> => {
    if (!client) return NETWORK_FAILURE;
    const started = generation.current;
    try {
      const answer = await client.DELETE("/api/v1/messaging/channels/{id}/snooze", {
        params: { path: { id: channelId } },
      });
      return toResult(
        answer,
        { channel_id: channelId, snoozed_until: null, snoozable: true },
        started,
      );
    } catch {
      return NETWORK_FAILURE;
    }
  }, [client, channelId, toResult]);

  return { view, reload, snooze, clear };
}
