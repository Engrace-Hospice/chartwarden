// WP 3.6 - the IDG discussions of a care-team channel. Read-only. The route answers `enabled:false` when the tenant has
// IDG discussions off (useFeatureFlag is never loaded in the real app), so that answer is the gate: the section hides.
import { useApiClient } from "@wardenx/ui";
import { useEffect, useState } from "react";
import type { Message } from "./messaging-types";

export type IdgDiscussionsState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "disabled" }
  | { kind: "ready"; discussions: readonly Message[] };

export function useIdgDiscussions(channelId: string): IdgDiscussionsState {
  const client = useApiClient();
  const [state, setState] = useState<IdgDiscussionsState>({ kind: "loading" });
  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const { data } = await client.GET("/api/v1/messaging/channels/{id}/idg-discussions", {
          params: { path: { id: channelId } },
        });
        if (!current) return;
        if (!data) setState({ kind: "error" });
        else if (data.enabled !== true) setState({ kind: "disabled" });
        else setState({ kind: "ready", discussions: (data.discussions ?? []) as Message[] });
      } catch {
        if (current) setState({ kind: "error" });
      }
    })();
    return () => {
      current = false;
    };
  }, [client, channelId]);
  return state;
}
