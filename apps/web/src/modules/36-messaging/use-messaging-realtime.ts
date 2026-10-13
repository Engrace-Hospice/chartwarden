// ADR-0054: the browser half of the realtime transport. The socket only ever says "something changed" (a hint with
// ids and a cursor, no content); the REST reads stay the record, so a dropped or repeated hint costs latency, never
// correctness. Polling keeps running as the fallback, just slower while the socket is up.
import { useEffect, useRef, useState } from "react";
import { type Socket, io } from "socket.io-client";

/** Mirror of `RealtimeHint` in @wardenx/messaging (the web app does not import that Node-side package). */
export interface MessagingHint {
  readonly kind: string;
  readonly cursor: string;
  readonly ids: {
    readonly channelId: string;
    readonly messageId: string;
    /** Set when the change is to a thread reply (WP 2.2). */
    readonly parentMessageId?: string;
  };
}

export type MessagingSocketFactory = () => Pick<Socket, "on" | "off" | "close">;

const HINT_EVENT = "hint";
const SEEN_CURSORS_MAX = 200;
// Refusals (flag off, rate limit, revoked session) back off hard: polling is already covering the screen.
const RECONNECT_DELAY_MS = 5_000;
const RECONNECT_DELAY_MAX_MS = 300_000;

const defaultFactory: MessagingSocketFactory = () =>
  io({
    path: "/socket.io",
    transports: ["websocket", "polling"],
    reconnectionDelay: RECONNECT_DELAY_MS,
    reconnectionDelayMax: RECONNECT_DELAY_MAX_MS,
  });

function isHint(value: unknown): value is MessagingHint {
  const hint = value as MessagingHint | null;
  return (
    typeof hint?.cursor === "string" &&
    typeof hint.kind === "string" &&
    typeof hint.ids?.channelId === "string"
  );
}

/**
 * Subscribes while mounted. `onHint` fires once per distinct cursor; `onSync` fires on every (re)connect so the caller
 * can reconcile whatever was missed while the socket was down. Returns whether the socket is currently connected.
 */
export function useMessagingRealtime(
  onHint: (hint: MessagingHint) => void,
  onSync: () => void,
  createSocket: MessagingSocketFactory = defaultFactory,
): boolean {
  const [connected, setConnected] = useState(false);
  const handlers = useRef({ onHint, onSync });
  handlers.current = { onHint, onSync };

  useEffect(() => {
    const seen = new Set<string>();
    const socket = createSocket();
    let firstConnect = true;
    const onConnect = (): void => {
      setConnected(true);
      // Cursors may restart with the server; a stale entry must not swallow a fresh hint.
      seen.clear();
      // The screen has just loaded; only a RE-connect can have missed something.
      if (!firstConnect) handlers.current.onSync();
      firstConnect = false;
    };
    const onDisconnect = (): void => setConnected(false);
    const onHintEvent = (payload: unknown): void => {
      if (!isHint(payload) || seen.has(payload.cursor)) return;
      seen.add(payload.cursor);
      if (seen.size > SEEN_CURSORS_MAX) seen.delete(seen.values().next().value as string);
      handlers.current.onHint(payload);
    };
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on(HINT_EVENT, onHintEvent);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off(HINT_EVENT, onHintEvent);
      socket.close();
      setConnected(false);
    };
  }, [createSocket]);

  return connected;
}
