// WP 2.12 presence + typing for one open conversation: heartbeat (POST), typing marker (POST) and a jittered poll (GET).
//
// Nothing is requested, and nothing renders, while the tenant flag `messaging.presence_enabled` is off (the default). A 403
// (flag turned off, access ended) or 404 from any call stops this conversation's presence for good; a transient error backs
// off. Hidden tabs make no requests. Names come from the channel's own member list (the presence read returns ids only).
import { BACKGROUND_REQUEST_HEADERS, useApiClient, useFeatureFlag } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import { type LoopOutcome, startPresenceLoop } from "./presence-loop";
import {
  HEARTBEAT_INTERVAL_MS,
  POLL_INTERVAL_MS,
  PRESENCE_FLAG_KEY,
  TYPING_THROTTLE_MS,
  displayNameFor,
} from "./presence-utils";

export interface PresenceView {
  /** False while the flag is off or presence has been stopped for this conversation: render nothing. */
  readonly active: boolean;
  /** Names of the OTHER people currently present, in the order the server listed them. */
  readonly onlineNames: readonly string[];
  /** Names of the OTHER people currently typing. */
  readonly typingNames: readonly string[];
}

const NONE: PresenceView = { active: false, onlineNames: [], typingNames: [] };
const STOP_STATUSES = new Set([403, 404]);

interface Snapshot {
  readonly present: readonly string[];
  readonly typing: readonly string[];
}
const EMPTY: Snapshot = { present: [], typing: [] };

/**
 * The tenant flag, defaulting to OFF when no FeatureFlagProvider is mounted (the shell always mounts one; a bare
 * conversation render, e.g. in a test or a preview, must simply show no presence rather than throw).
 */
function usePresenceFlag(): boolean {
  try {
    // The context read happens before the provider check throws, so hook order is unchanged either way.
    return useFeatureFlag(PRESENCE_FLAG_KEY);
  } catch {
    return false;
  }
}

export function usePresence(input: {
  channelId: string;
  meId: string;
  draft: string;
}): PresenceView {
  const { channelId, meId, draft } = input;
  const client = useApiClient();
  const flagOn = usePresenceFlag();
  const [stoppedChannel, setStoppedChannel] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const active = flagOn && stoppedChannel !== channelId;
  const lastTypingAt = useRef(0);

  useEffect(() => {
    setSnapshot(EMPTY);
    setNames(new Map());
    lastTypingAt.current = 0;
    if (!active) return;
    let cancelled = false;
    const halt = (): void => {
      if (!cancelled) setStoppedChannel(channelId);
    };
    const path = { id: channelId };

    // Names: the channel's own member list (display names the viewer may already see). Best effort.
    void client
      .GET("/api/v1/messaging/channels/{id}", {
        params: { path },
        headers: BACKGROUND_REQUEST_HEADERS,
      })
      .then(({ data }) => {
        if (cancelled || !data) return;
        const members = (data as { members?: { userId: string; displayName: string | null }[] })
          .members;
        setNames(
          new Map(
            (members ?? []).flatMap((m) => (m.displayName ? [[m.userId, m.displayName]] : [])),
          ),
        );
      })
      .catch(() => undefined);

    const outcomeOf = (status: number | undefined, failed: boolean): LoopOutcome =>
      status !== undefined && STOP_STATUSES.has(status) ? "stop" : failed ? "error" : "ok";

    const stopHeartbeat = startPresenceLoop(
      async () => {
        const { error, response } = await client.POST("/api/v1/messaging/channels/{id}/presence", {
          params: { path },
          body: {},
          headers: BACKGROUND_REQUEST_HEADERS,
        });
        return outcomeOf(response?.status, Boolean(error));
      },
      HEARTBEAT_INTERVAL_MS,
      halt,
    );
    const stopPoll = startPresenceLoop(
      async () => {
        const { data, error, response } = await client.GET(
          "/api/v1/messaging/channels/{id}/presence",
          { params: { path }, headers: BACKGROUND_REQUEST_HEADERS },
        );
        if (!cancelled && data) setSnapshot({ present: data.present, typing: data.typing });
        return outcomeOf(response?.status, Boolean(error));
      },
      POLL_INTERVAL_MS,
      halt,
    );
    return () => {
      cancelled = true;
      stopHeartbeat();
      stopPoll();
    };
  }, [active, channelId, client]);

  // Typing: while the composer holds text, tell the server at most every TYPING_THROTTLE_MS (it throttles too).
  useEffect(() => {
    if (!active || draft.trim() === "" || document.hidden) return;
    const now = Date.now();
    if (now - lastTypingAt.current < TYPING_THROTTLE_MS) return;
    lastTypingAt.current = now;
    void client
      .POST("/api/v1/messaging/channels/{id}/presence", {
        params: { path: { id: channelId } },
        body: { typing: true },
      })
      .then(({ response }) => {
        if (response && STOP_STATUSES.has(response.status)) setStoppedChannel(channelId);
      })
      .catch(() => undefined);
  }, [active, channelId, client, draft]);

  if (!active) return NONE;
  const others = (ids: readonly string[]): string[] =>
    ids.filter((id) => id !== meId).map((id) => displayNameFor(names, id));
  return { active, onlineNames: others(snapshot.present), typingNames: others(snapshot.typing) };
}
