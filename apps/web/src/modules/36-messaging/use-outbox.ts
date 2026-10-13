// The offline outbox of the channel composer (06-ux-design §4 "Offline"): messages whose POST got no response wait here
// as "Not sent" rows until the server confirms them.
//
// React state ONLY. Message bodies are PHI and must not be persisted in the browser (no localStorage, sessionStorage
// or IndexedDB): closing or reloading the tab drops the queue, by design.
import { useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { SendBody } from "./message-send-body";
import { apiErrorMessage } from "./messaging-utils";
import type { QueuedSend, SentMessage } from "./use-message-sender";

const RETRY_FAILED_MESSAGE = "Message could not be sent.";
/** Answered refusals a retry cannot fix: the user can only read the reason and discard. */
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([403, 404, 409, 422]);

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
  /** A refusal (403/404/409/422): Retry is withdrawn, Discard remains. */
  readonly permanent?: boolean;
}

type AttemptOutcome = "delivered" | "answered" | "offline" | "skipped";

interface UseOutboxInput {
  channelId: string;
  /** The thread's generation: bumped on channel switch and unmount, so a late reply is dropped. */
  generationRef: MutableRefObject<number>;
  /** The server confirmed a queued message: merge it into the timeline (the draft is not touched). */
  onDelivered: (sent: SentMessage) => void;
}

export function useOutbox({ channelId, generationRef, onDelivered }: UseOutboxInput) {
  const client = useApiClient();
  const [items, setItems] = useState<readonly OutboxItem[]>([]);
  const itemsRef = useRef<readonly OutboxItem[]>([]);
  const drainingRef = useRef(false);
  const onDeliveredRef = useRef(onDelivered);
  onDeliveredRef.current = onDelivered;

  const replaceAll = useCallback((next: readonly OutboxItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);
  const patch = useCallback(
    (localId: string, changes: Partial<OutboxItem>) =>
      replaceAll(
        itemsRef.current.map((item) => (item.localId === localId ? { ...item, ...changes } : item)),
      ),
    [replaceAll],
  );

  const enqueue = useCallback(
    (queued: QueuedSend) =>
      replaceAll([
        ...itemsRef.current,
        {
          localId: queued.body.clientMessageId,
          channelId,
          body: queued.body,
          idempotencyKey: queued.idempotencyKey,
          sent: queued.sent,
          status: "not_sent",
        },
      ]),
    [channelId, replaceAll],
  );

  const discard = useCallback(
    (localId: string) =>
      replaceAll(
        itemsRef.current.filter((item) => item.localId !== localId || item.status === "sending"),
      ),
    [replaceAll],
  );

  const reset = useCallback(() => replaceAll([]), [replaceAll]);

  const attempt = useCallback(
    async (localId: string): Promise<AttemptOutcome> => {
      const item = itemsRef.current.find((candidate) => candidate.localId === localId);
      if (!item || item.status === "sending" || item.permanent) return "skipped";
      const generation = generationRef.current;
      patch(localId, { status: "sending", error: undefined });
      const post = () =>
        client.POST("/api/v1/messaging/channels/{id}/messages", {
          params: {
            path: { id: item.channelId },
            header: { "Idempotency-Key": item.idempotencyKey },
          },
          body: item.body,
        });
      let result: Awaited<ReturnType<typeof post>>;
      try {
        result = await post();
      } catch {
        // Still no response: keep the same key, a lost reply replays safely on the server.
        if (generation !== generationRef.current) return "skipped";
        patch(localId, { status: "not_sent" });
        return "offline";
      }
      if (generation !== generationRef.current) return "skipped";
      const { data, error, response } = result;
      if (error || !data) {
        const status = response?.status ?? 0;
        patch(localId, {
          status: "not_sent",
          error: apiErrorMessage(error, RETRY_FAILED_MESSAGE),
          permanent: PERMANENT_STATUSES.has(status),
          // The idempotency store caches answered failures, so the key rotates; the clientMessageId stays.
          ...(status >= 400 ? { idempotencyKey: crypto.randomUUID() } : {}),
        });
        return "answered";
      }
      replaceAll(itemsRef.current.filter((candidate) => candidate.localId !== localId));
      onDeliveredRef.current({
        ...item.sent,
        messageId: data.messageId,
        createdAt: data.createdAt,
      });
      return "delivered";
    },
    [client, generationRef, patch, replaceAll],
  );

  /** Oldest first, one at a time; stops at the first send that still gets no response. */
  const drain = useCallback(async (): Promise<void> => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      for (const item of itemsRef.current) {
        if ((await attempt(item.localId)) === "offline") break;
      }
    } finally {
      drainingRef.current = false;
    }
  }, [attempt]);

  useEffect(() => {
    const onOnline = () => void drain();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [drain]);

  return { items, enqueue, discard, reset, retry: attempt };
}
