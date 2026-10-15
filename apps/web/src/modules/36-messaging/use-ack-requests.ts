// M36 WP 4.2 - the acknowledgment requests of one patient care-team channel, and the two explicit actions on them. A monotonic
// token drops a late answer for a channel the person has left; a TRANSIENT load failure (thrown, no response, 5xx) shows a retry,
// a DEFINITIVE one (403/404) shows nothing. An action that fails with no answer is INDETERMINATE: the list is re-read and the
// person is told it may not have been saved. The server stays the authority on every action. Nothing here runs on open or read.
import type { AckRequestDto } from "@wardenx/types";
import { useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACK_CHANGED_TEXT,
  ACK_GONE_TEXT,
  ACK_INDETERMINATE_TEXT,
  ACK_NOT_QUALIFIED_TEXT,
} from "./ack-wording";

/** The two calls this hook makes, typed loosely: the generated path union makes the full client type too deep to instantiate here. */
interface AckClient {
  GET(
    path: string,
    init: { params: { path: { id: string } } },
  ): Promise<{
    data?: { requests?: AckRequestDto[] };
    error?: unknown;
    response?: { status: number };
  }>;
  POST(
    path: string,
    init: { params: { path: { id: string } }; body: Record<string, never> },
  ): Promise<{ error?: unknown; response?: { status: number } }>;
}

export type AckAction = "acknowledge" | "resolve";
export type AckListStatus = "loading" | "ready" | "transient" | "hidden";

interface Loaded {
  readonly channelId: string;
  readonly status: AckListStatus;
  readonly requests: readonly AckRequestDto[];
}

const codeOf = (error: unknown): string | undefined => {
  const e = error as { error?: { code?: string }; code?: string } | undefined;
  return e?.error?.code ?? e?.code;
};

export function useAckRequests(channelId: string, enabled: boolean) {
  const client = useApiClient() as unknown as AckClient;
  const [loaded, setLoaded] = useState<Loaded>({ channelId, status: "loading", requests: [] });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(0);
  const busy = useRef(false);
  const channelRef = useRef(channelId);
  channelRef.current = channelId;

  const load = useCallback(async (): Promise<void> => {
    latest.current += 1;
    const token = latest.current;
    const settle = (status: AckListStatus, requests: readonly AckRequestDto[] = []): void => {
      if (token === latest.current) setLoaded({ channelId, status, requests });
    };
    try {
      const result = await client.GET("/api/v1/messaging/channels/{id}/escalations", {
        params: { path: { id: channelId } },
      });
      const status = result?.response?.status;
      if (status === 401 || status === 403 || status === 404) return settle("hidden");
      if ((status === undefined && !result?.data) || (status !== undefined && status >= 400)) {
        return settle("transient");
      }
      settle("ready", (result?.data?.requests ?? []) as readonly AckRequestDto[]);
    } catch {
      settle("transient");
    }
  }, [client, channelId]);

  useEffect(() => {
    if (!enabled) return;
    setNotice(null);
    void load();
    return () => {
      latest.current += 1;
    };
  }, [enabled, load]);

  const act = useCallback(
    async (requestId: string, action: AckAction): Promise<void> => {
      if (busy.current) return;
      busy.current = true;
      const startedFor = channelRef.current;
      setBusyId(requestId);
      setNotice(null);
      let outcome: string | null = null;
      try {
        const path =
          action === "acknowledge"
            ? "/api/v1/messaging/escalations/{id}/acknowledge"
            : "/api/v1/messaging/escalations/{id}/resolve";
        const result = await client.POST(path, { params: { path: { id: requestId } }, body: {} });
        const status = result?.response?.status;
        if (!result?.error && status !== undefined && status < 400) {
          // fall through to the reload: the server's answer is the state
        } else if (status === undefined || status >= 500) {
          outcome = ACK_INDETERMINATE_TEXT;
        } else if (status === 403 && codeOf(result?.error) === "ACK_NOT_QUALIFIED") {
          outcome = ACK_NOT_QUALIFIED_TEXT;
        } else if (status === 409) {
          outcome = ACK_CHANGED_TEXT;
        } else {
          outcome = ACK_GONE_TEXT;
        }
      } catch {
        outcome = ACK_INDETERMINATE_TEXT;
      } finally {
        busy.current = false;
        setBusyId(null);
      }
      // The person may have left this channel while the call was in flight: its notice and reload belong to the old one.
      if (channelRef.current !== startedFor) return;
      setNotice(outcome);
      await load();
    },
    [client, load],
  );

  // An answer belongs to the channel it was read for: the render right after a switch never shows the old one.
  const current = loaded.channelId === channelId && enabled ? loaded : null;
  return {
    status: (current?.status ?? "loading") as AckListStatus,
    requests: current?.requests ?? [],
    busyId,
    notice,
    act,
    reload: load,
  };
}
