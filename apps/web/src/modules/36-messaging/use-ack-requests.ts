// M36 WP 4.2 - the acknowledgment requests of one patient care-team channel, and the two explicit actions on them. A token drops a
// late answer for a channel the person has left; a load failure that is transient (thrown, no response, 408, 5xx, 429) KEEPS the
// last good requests of this channel and marks them possibly out of date; 401/403 say so; only 404 shows nothing. An action
// that fails with no answer is INDETERMINATE: the list is re-read and the person is told it may not have been saved. The busy
// flag is held until the reload after an action has settled, so a second click cannot overlap it. The list is re-read when the
// channel's messages change, when the window regains focus, and on a modest interval while any request is still open. The
// server stays the authority on every action. Nothing here runs on open or read.
import type { AckRequestDto } from "@wardenx/types";
import { useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACK_CHANGED_TEXT,
  ACK_CLOSE_NOT_QUALIFIED_TEXT,
  ACK_FAILED_TEXT,
  ACK_GONE_TEXT,
  ACK_INDETERMINATE_TEXT,
  ACK_INVALID_TEXT,
  ACK_NOT_PERMITTED_TEXT,
  ACK_NOT_QUALIFIED_TEXT,
  ACK_SAVED_CLOSED_TEXT,
  ACK_SAVED_TAKEN_TEXT,
  ACK_SIGN_IN_TEXT,
  ACK_TOO_MANY_TEXT,
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
export type AckListStatus =
  | "loading"
  | "ready"
  | "transient"
  | "throttled"
  | "signin"
  | "forbidden"
  | "hidden";

/** While any request is still waiting the list is re-read this often (display refresh only; nothing escalates from here). */
export const ACK_POLL_MS = 60_000;
const OPEN_STATUSES = new Set(["pending", "escalated", "failed_unreachable"]);
const KEEPS_LAST_GOOD: ReadonlySet<AckListStatus> = new Set(["transient", "throttled"]);

interface Loaded {
  readonly channelId: string;
  readonly status: AckListStatus;
  readonly requests: readonly AckRequestDto[];
}

interface Busy {
  readonly channelId: string;
  readonly requestId: string;
}

const codeOf = (error: unknown): string | undefined => {
  const e = error as { error?: { code?: string }; code?: string } | undefined;
  return e?.error?.code ?? e?.code;
};

const listStatusOf = (status: number | undefined, hasData: boolean): AckListStatus => {
  if (status === undefined) return hasData ? "ready" : "transient";
  if (status === 404) return "hidden";
  if (status === 401) return "signin";
  if (status === 403) return "forbidden";
  if (status === 429) return "throttled";
  return status >= 400 ? "transient" : "ready";
};

/** The words for a failed action; `null` is never returned for a failure. */
function failureText(action: AckAction, status: number | undefined, error: unknown): string {
  if (status === undefined || status === 408 || status >= 500) return ACK_INDETERMINATE_TEXT;
  if (status === 429) return ACK_TOO_MANY_TEXT;
  if (status === 401) return ACK_SIGN_IN_TEXT;
  if (status === 403) {
    if (codeOf(error) !== "ACK_NOT_QUALIFIED") return ACK_NOT_PERMITTED_TEXT;
    return action === "resolve" ? ACK_CLOSE_NOT_QUALIFIED_TEXT : ACK_NOT_QUALIFIED_TEXT;
  }
  if (status === 404) return ACK_GONE_TEXT;
  if (status === 409) return ACK_CHANGED_TEXT;
  if (status === 422) return ACK_INVALID_TEXT;
  return ACK_FAILED_TEXT;
}

export function useAckRequests(channelId: string, enabled: boolean, refreshKey?: string | null) {
  const client = useApiClient() as unknown as AckClient;
  const [loaded, setLoaded] = useState<Loaded>({ channelId, status: "loading", requests: [] });
  const [busy, setBusy] = useState<Busy | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusRequestId, setFocusRequestId] = useState<string | null>(null);
  const latest = useRef(0);
  const epoch = useRef(0);
  const busyRef = useRef<Busy | null>(null);
  const channelRef = useRef(channelId);
  channelRef.current = channelId;

  const load = useCallback(async (): Promise<void> => {
    latest.current += 1;
    const token = latest.current;
    const settle = (status: AckListStatus, requests: readonly AckRequestDto[] = []): void => {
      if (token !== latest.current) return;
      setLoaded((prev) => {
        const keep = KEEPS_LAST_GOOD.has(status) && prev.channelId === channelId;
        return { channelId, status, requests: keep ? prev.requests : requests };
      });
    };
    try {
      const result = await client.GET("/api/v1/messaging/channels/{id}/escalations", {
        params: { path: { id: channelId } },
      });
      const status = listStatusOf(result?.response?.status, Boolean(result?.data));
      if (status !== "ready") return settle(status);
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
      epoch.current += 1;
    };
  }, [enabled, load]);

  // Re-read when the channel's message list changes (a new message id), but not on the first render or a channel switch.
  const lastRefresh = useRef({ channelId, refreshKey });
  useEffect(() => {
    const previous = lastRefresh.current;
    lastRefresh.current = { channelId, refreshKey };
    if (!enabled || previous.channelId !== channelId || previous.refreshKey === refreshKey) return;
    void load();
  }, [enabled, channelId, refreshKey, load]);

  useEffect(() => {
    if (!enabled) return;
    const onFocus = (): void => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, load]);

  const current = loaded.channelId === channelId && enabled ? loaded : null;
  const anyOpen = (current?.requests ?? []).some((r) => OPEN_STATUSES.has(r.status));
  useEffect(() => {
    if (!enabled || !anyOpen) return;
    const timer = setInterval(() => {
      if (!busyRef.current) void load();
    }, ACK_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, anyOpen, load]);

  const act = useCallback(
    async (requestId: string, action: AckAction): Promise<void> => {
      if (busyRef.current?.channelId === channelRef.current) return;
      const mine: Busy = { channelId: channelRef.current, requestId };
      busyRef.current = mine;
      const startedEpoch = epoch.current;
      setBusy(mine);
      setNotice(null);
      const release = (): void => {
        if (busyRef.current === mine) busyRef.current = null;
        setBusy((b) => (b === mine ? null : b));
      };
      let outcome: string | null = null;
      try {
        const path =
          action === "acknowledge"
            ? "/api/v1/messaging/escalations/{id}/acknowledge"
            : "/api/v1/messaging/escalations/{id}/resolve";
        const result = await client.POST(path, { params: { path: { id: requestId } }, body: {} });
        const status = result?.response?.status;
        if (result?.error || status === undefined || status >= 400) {
          outcome = failureText(action, status, result?.error);
        }
      } catch {
        outcome = ACK_INDETERMINATE_TEXT;
      }
      // The person may have left this channel (even to come back) while the call was in flight: its notice and reload
      // belong to the old visit.
      if (epoch.current !== startedEpoch) return release();
      const saved = action === "acknowledge" ? ACK_SAVED_TAKEN_TEXT : ACK_SAVED_CLOSED_TEXT;
      setNotice(outcome ?? saved);
      try {
        await load();
      } finally {
        if (epoch.current === startedEpoch && !outcome) setFocusRequestId(requestId);
        release();
      }
    },
    [client, load],
  );

  const clearFocus = useCallback(() => setFocusRequestId(null), []);
  return {
    status: (current?.status ?? "loading") as AckListStatus,
    requests: current?.requests ?? [],
    busyId: busy?.channelId === channelId ? busy.requestId : null,
    notice,
    focusRequestId,
    clearFocus,
    act,
    reload: load,
  };
}
