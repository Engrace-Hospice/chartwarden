// The offline outbox of the channel composer (06-ux-design §4 "Offline"): messages whose POST got no response wait here
// as "Not sent" rows until the server confirms them.
//
// React state ONLY, held per channel so switching channels never loses a queued message. Message bodies are PHI and must
// not be persisted in the browser (no localStorage, sessionStorage or IndexedDB): closing or reloading the tab drops the
// queue, by design, and a beforeunload warning says so while anything waits.
import { useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SendBody } from "./message-send-body";
import { apiErrorMessage } from "./messaging-utils";
import type { QueuedSend, SentMessage } from "./use-message-sender";

const RETRY_FAILED_MESSAGE = "Message could not be sent.";
/** A POST that has not answered by then counts as no response: the row stays "Not sent" and the key is reused. */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Answered refusals a retry cannot fix: the user can only read the reason and discard. 409 is NOT here: the server
 * answers 409 for an idempotent request still in flight, so the original may yet commit and a retry is safe.
 */
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([403, 404, 422]);

export interface OutboxItem {
  /** The clientMessageId: unique per composed message, and the id the server dedupes on. */
  readonly localId: string;
  readonly channelId: string;
  readonly body: SendBody;
  readonly idempotencyKey: string;
  /** What the row shows; `messageId` is the localId and `createdAt` the queue time until the server answers. */
  readonly sent: SentMessage;
  readonly status: "not_sent" | "sending";
  readonly error?: string;
  /** A refusal (403/404/422): Retry is withdrawn, Discard remains. */
  readonly permanent?: boolean;
}

type Queues = Readonly<Record<string, readonly OutboxItem[]>>;
type AttemptOutcome = "delivered" | "answered" | "offline" | "skipped";

const NO_ITEMS: readonly OutboxItem[] = [];

/** `change` returns the replacement for the item, or null to remove it; empty channels are dropped. */
function mapItem(
  queues: Queues,
  localId: string,
  change: (item: OutboxItem) => OutboxItem | null,
): Queues {
  const next: Record<string, readonly OutboxItem[]> = {};
  for (const [channel, items] of Object.entries(queues)) {
    const mapped = items.flatMap((item) => {
      if (item.localId !== localId) return [item];
      const replacement = change(item);
      return replacement ? [replacement] : [];
    });
    if (mapped.length > 0) next[channel] = mapped;
  }
  return next;
}

const findItem = (queues: Queues, localId: string): OutboxItem | undefined =>
  Object.values(queues)
    .flat()
    .find((item) => item.localId === localId);

interface UseOutboxInput {
  /** The open channel: only its rows are returned, and only its deliveries are merged. */
  channelId: string;
  /** The server confirmed a queued message of the open channel: merge it into the timeline (the draft is not touched). */
  onDelivered: (sent: SentMessage) => void;
}

export function useOutbox({ channelId, onDelivered }: UseOutboxInput) {
  const client = useApiClient();
  const [queues, setQueues] = useState<Queues>({});
  const queuesRef = useRef<Queues>({});
  const drainingRef = useRef(false);
  const mountedRef = useRef(true);
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  const onDeliveredRef = useRef(onDelivered);
  onDeliveredRef.current = onDelivered;

  const replaceAll = useCallback((next: Queues) => {
    queuesRef.current = next;
    setQueues(next);
  }, []);
  const patch = useCallback(
    (localId: string, changes: Partial<OutboxItem>) =>
      replaceAll(mapItem(queuesRef.current, localId, (item) => ({ ...item, ...changes }))),
    [replaceAll],
  );
  const remove = useCallback(
    (localId: string) => replaceAll(mapItem(queuesRef.current, localId, () => null)),
    [replaceAll],
  );

  const enqueue = useCallback(
    (queued: QueuedSend) => {
      const channel = channelIdRef.current;
      replaceAll({
        ...queuesRef.current,
        [channel]: [
          ...(queuesRef.current[channel] ?? NO_ITEMS),
          {
            localId: queued.body.clientMessageId,
            channelId: channel,
            body: queued.body,
            idempotencyKey: queued.idempotencyKey,
            sent: queued.sent,
            status: "not_sent",
          },
        ],
      });
    },
    [replaceAll],
  );

  /** Allowed while a row is sending: if that request still lands, the message was delivered and is shown as such. */
  const discard = remove;

  /** True when the open channel has a message waiting that a retry can still deliver: a new send must queue behind it. */
  const hasQueued = useCallback(
    () => (queuesRef.current[channelIdRef.current] ?? NO_ITEMS).some((item) => !item.permanent),
    [],
  );

  const send = useCallback(
    async (item: OutboxItem): Promise<AttemptOutcome> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const post = () =>
        client.POST("/api/v1/messaging/channels/{id}/messages", {
          params: {
            path: { id: item.channelId },
            header: { "Idempotency-Key": item.idempotencyKey },
          },
          body: item.body,
          signal: controller.signal,
        });
      let result: Awaited<ReturnType<typeof post>>;
      try {
        result = await post();
      } catch {
        // Still no response (offline or timed out): keep the same key, a lost reply replays safely on the server.
        if (!mountedRef.current) return "skipped";
        patch(item.localId, { status: "not_sent" });
        return "offline";
      } finally {
        clearTimeout(timer);
      }
      if (!mountedRef.current) return "skipped";
      const { data, error, response } = result;
      if (error || !data) {
        const status = response?.status ?? 0;
        patch(item.localId, {
          status: "not_sent",
          error: apiErrorMessage(error, RETRY_FAILED_MESSAGE),
          permanent: PERMANENT_STATUSES.has(status),
          // The idempotency store caches answered failures, so the key rotates; the clientMessageId stays.
          ...(status >= 400 ? { idempotencyKey: crypto.randomUUID() } : {}),
        });
        return "answered";
      }
      remove(item.localId);
      // A reply for a channel that is no longer open is not merged into the open one: it loads with that channel.
      if (item.channelId === channelIdRef.current) {
        onDeliveredRef.current({
          ...item.sent,
          messageId: data.messageId,
          createdAt: data.createdAt,
        });
      }
      return "delivered";
    },
    [client, patch, remove],
  );

  /**
   * One attempt. A manual Retry on item N is allowed even with older items waiting: it may then send out of order,
   * but only because the user chose to (the online drain always goes oldest first).
   */
  const attempt = useCallback(
    async (localId: string): Promise<AttemptOutcome> => {
      const item = findItem(queuesRef.current, localId);
      if (!item || item.status === "sending" || item.permanent) return "skipped";
      patch(localId, { status: "sending", error: undefined });
      try {
        return await send(item);
      } catch {
        // Never leave a row stuck in "sending" (e.g. crypto.randomUUID threw).
        patch(localId, { status: "not_sent", error: RETRY_FAILED_MESSAGE });
        return "answered";
      }
    },
    [patch, send],
  );

  /**
   * Every channel's queue, oldest first, one at a time. No response stops everything (still offline); anything else
   * that is not a delivery stops only that channel, so a later message never overtakes the one that failed.
   */
  const drain = useCallback(async (): Promise<void> => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      for (const items of Object.values(queuesRef.current)) {
        for (const { localId } of items) {
          const current = findItem(queuesRef.current, localId);
          if (!current || current.permanent) continue;
          const outcome = await attempt(localId);
          if (outcome === "offline") return;
          if (outcome !== "delivered") break;
        }
      }
    } finally {
      drainingRef.current = false;
    }
  }, [attempt]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const onOnline = () => void drain();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [drain]);

  const anyQueued = Object.keys(queues).length > 0;
  useEffect(() => {
    if (!anyQueued) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyQueued]);

  return { items: queues[channelId] ?? NO_ITEMS, enqueue, discard, retry: attempt, hasQueued };
}
