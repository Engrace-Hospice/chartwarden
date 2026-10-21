// M36 WP 4.1 - who an urgent clinical message in this channel could go to, and whether the mode is on at all. `enabled` comes
// ONLY from the options route (useFeatureFlag is never loaded in the real app). A DEFINITIVE "no" (enabled:false, no patient,
// 401/403/404) reads as hidden; a TRANSIENT failure (thrown, no response, 5xx) is retried with the SBAR policy's backoff and
// reads as "unavailable", so a clinician is told rather than silently left without the button. `reload` re-reads (the dialog
// calls it on open so the list is fresh). A monotonic request id drops a late answer for a channel the person has left. The
// server stays the authority: with the flag off its POST answers 404.
import type { UrgentMessageOptions } from "@chartwarden/types";
import { useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { POLICY_RETRY_DELAYS_MS } from "./use-sbar-policy";

export type EnabledUrgentOptions = Extract<UrgentMessageOptions, { readonly enabled: true }>;
export type UrgentOptionsState =
  | { readonly status: "hidden" }
  | { readonly status: "unavailable" }
  /** Every retry failed: the person is told, and `reload` (a Retry button) starts over. */
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly options: EnabledUrgentOptions };

const HIDDEN: UrgentOptionsState = { status: "hidden" };

/** `skip` avoids any read (a channel that cannot carry an urgent clinical message). */
export function useUrgentOptions(
  channelId: string,
  skip: boolean,
): UrgentOptionsState & { readonly reload: () => void } {
  const client = useApiClient();
  const [answer, setAnswer] = useState<{
    readonly channelId: string;
    readonly state: UrgentOptionsState;
  }>({ channelId, state: HIDDEN });
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the manual re-read trigger
  useEffect(() => {
    latest.current += 1;
    const requestId = latest.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (skip) return;
    const settle = (next: UrgentOptionsState): void => {
      if (requestId === latest.current) setAnswer({ channelId, state: next });
    };
    const attempt = (retry: number): void => {
      const transient = (): void => {
        // Keep a list that was already on screen; otherwise say "unavailable" while retrying with backoff.
        if (requestId !== latest.current) return;
        setAnswer((current) =>
          current.channelId === channelId && current.state.status === "ready"
            ? current
            : { channelId, state: { status: "unavailable" } },
        );
        const delay = POLICY_RETRY_DELAYS_MS[retry];
        if (delay !== undefined) {
          timer = setTimeout(() => attempt(retry + 1), delay);
          return;
        }
        setAnswer((current) =>
          current.channelId === channelId && current.state.status === "ready"
            ? current
            : { channelId, state: { status: "failed" } },
        );
      };
      // Deferred a tick so a client that throws (not just rejects) is treated as transient too.
      void Promise.resolve()
        .then(() =>
          client.GET("/api/v1/messaging/channels/{id}/urgent-messages/options", {
            params: { path: { id: channelId } },
          }),
        )
        .then((result) => {
          if (requestId !== latest.current) return;
          const status = result?.response?.status;
          if (status === undefined && !result?.data) return transient();
          if (status !== undefined && status >= 500) return transient();
          const data = result?.data;
          settle(
            data && data.enabled === true && data.patient_linked
              ? { status: "ready", options: data }
              : HIDDEN,
          );
        }, transient);
    };
    attempt(0);
    return () => {
      latest.current += 1;
      clearTimeout(timer);
    };
  }, [client, channelId, skip, tick]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  // An answer belongs to the channel it was read for: the render right after a switch never shows the old one.
  const state = answer.channelId === channelId && !skip ? answer.state : HIDDEN;
  return { ...state, reload };
}
