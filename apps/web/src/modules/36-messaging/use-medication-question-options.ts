// M36 WP 3.10 - who a medication question in this channel would go to, and whether the entry is on at all. `enabled`
// comes ONLY from the options route (useFeatureFlag is never loaded in the real app). Fails closed: any error, 401, 403,
// 404 or an unexpected shape reads as hidden. A monotonic request id drops a late answer for a channel the person has
// left. The server stays the authority: with the flag off its POST answers 404.
import type { MedicationQuestionOptions } from "@wardenx/types";
import { useApiClient } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";

export type EnabledOptions = Extract<MedicationQuestionOptions, { readonly enabled: true }>;
export type MedicationQuestionOptionsState =
  | { readonly status: "hidden" }
  | { readonly status: "ready"; readonly options: EnabledOptions };

const HIDDEN: MedicationQuestionOptionsState = { status: "hidden" };

/** `skip` avoids any read (a channel that cannot carry a medication question). */
export function useMedicationQuestionOptions(
  channelId: string,
  skip: boolean,
): MedicationQuestionOptionsState {
  const client = useApiClient();
  const [answer, setAnswer] = useState<{
    readonly channelId: string;
    readonly state: MedicationQuestionOptionsState;
  }>({ channelId, state: HIDDEN });
  const latest = useRef(0);
  useEffect(() => {
    latest.current += 1;
    const requestId = latest.current;
    setAnswer({ channelId, state: HIDDEN });
    if (skip) return;
    const settle = (next: MedicationQuestionOptionsState): void => {
      if (requestId === latest.current) setAnswer({ channelId, state: next });
    };
    // Deferred a tick so a client that throws (not just rejects) also fails closed.
    void Promise.resolve()
      .then(() =>
        client.GET("/api/v1/messaging/channels/{id}/medication-questions/options", {
          params: { path: { id: channelId } },
        }),
      )
      .then(
        (result) => {
          const data = result?.data;
          settle(
            data && data.enabled === true && data.patient_linked
              ? { status: "ready", options: data }
              : HIDDEN,
          );
        },
        () => settle(HIDDEN),
      );
    return () => {
      latest.current += 1;
    };
  }, [client, channelId, skip]);
  // An answer belongs to the channel it was read for: the render right after a switch never shows the old one.
  return answer.channelId === channelId && !skip ? answer.state : HIDDEN;
}
