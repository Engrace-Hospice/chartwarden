// The offline outbox of the channel composer (06-ux-design §4 "Offline"): messages whose POST got no response wait here
// as "Not sent" rows until the server confirms them.
//
// LIFTED: one instance lives in the organization-level component (StaffMessaging), above the per-channel thread that
// unmounts on every channel switch, so the queue, the `online`/`beforeunload` listeners and in-flight sends survive a
// switch. (An in-app route change away from messaging unmounts it too, and drops the queue: an accepted limit, there is
// no router blocker.) The open thread binds its merge handler with `bindThread`; a delivery is merged only when the bound thread is
// that channel's, otherwise the item is just removed (the message shows when the channel is next loaded).
//
// React state ONLY, held per channel so switching channels never loses a queued message. Message bodies are PHI and must
// not be persisted in the browser (no localStorage, sessionStorage or IndexedDB): closing or reloading the tab drops the
// queue, by design, and a beforeunload warning says so while anything waits.
import { useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SendBody } from "./message-send-body";
import { REQUEST_TIMEOUT_MS, apiErrorMessage } from "./messaging-utils";
import type { QueuedSend, SentMessage } from "./use-message-sender";

const RETRY_FAILED_MESSAGE = "Message could not be sent.";
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
  /** How many answered failures this message has had (each is announced, even with the same error text). */
  readonly failCount?: number;
  /** How many retries got no response at all (announced too: otherwise a retry offline is silent). */
  readonly offlineCount?: number;
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

export type Outbox = ReturnType<typeof useOutbox>;

type MergeHandler = (sent: SentMessage) => void;

export function useOutbox() {
  const client = useApiClient();
  const [queues, setQueues] = useState<Queues>({});
  const [deliveredBy, setDeliveredBy] = useState<Readonly<Record<string, number>>>({});
  const queuesRef = useRef<Queues>({});
  const drainingRef = useRef(false);
  const drainAgainRef = useRef(false);
  const drainRef = useRef<(only?: string) => Promise<void>>(async () => {});
  const mountedRef = useRef(true);
  const threadRef = useRef<{ channelId: string; merge: MergeHandler } | null>(null);

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

  /** The open thread says where deliveries for its channel go. Returns the unbind. */
  const bindThread = useCallback((channelId: string, merge: MergeHandler) => {
    const binding = { channelId, merge };
    threadRef.current = binding;
    return () => {
      if (threadRef.current === binding) threadRef.current = null;
    };
  }, []);

  const enqueue = useCallback(
    (channelId: string, queued: QueuedSend) =>
      replaceAll({
        ...queuesRef.current,
        [channelId]: [
          ...(queuesRef.current[channelId] ?? NO_ITEMS),
          {
            localId: queued.body.clientMessageId,
            channelId,
            body: queued.body,
            idempotencyKey: queued.idempotencyKey,
            sent: queued.sent,
            status: "not_sent",
          },
        ],
      }),
    [replaceAll],
  );

  /** True when the channel has a message waiting that a retry can still deliver: a new send must queue behind it. */
  const hasQueued = useCallback(
    (channelId: string) =>
      (queuesRef.current[channelId] ?? NO_ITEMS).some((item) => !item.permanent),
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
        patch(item.localId, { status: "not_sent", offlineCount: (item.offlineCount ?? 0) + 1 });
        // Discarded while sending: nothing holds its followers back any more.
        if (!findItem(queuesRef.current, item.localId)) void drainRef.current(item.channelId);
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
          failCount: (item.failCount ?? 0) + 1,
          error: apiErrorMessage(error, RETRY_FAILED_MESSAGE),
          permanent: PERMANENT_STATUSES.has(status),
          // The idempotency store caches answered failures, so the key rotates; the clientMessageId stays.
          ...(status >= 400 ? { idempotencyKey: crypto.randomUUID() } : {}),
        });
        if (!findItem(queuesRef.current, item.localId)) void drainRef.current(item.channelId);
        return "answered";
      }
      remove(item.localId);
      setDeliveredBy((current) => ({
        ...current,
        [item.channelId]: (current[item.channelId] ?? 0) + 1,
      }));
      // A reply for a channel that is not the open one is not merged: it loads with that channel.
      const thread = threadRef.current;
      if (thread && thread.channelId === item.channelId) {
        thread.merge({ ...item.sent, messageId: data.messageId, createdAt: data.createdAt });
      }
      return "delivered";
    },
    [client, patch, remove],
  );

  const attempt = useCallback(
    async (localId: string): Promise<AttemptOutcome> => {
      if (!mountedRef.current) return "skipped";
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
   * Oldest first, one at a time. No response stops everything (still offline); anything else that is not a delivery
   * stops only that channel, so a later message never overtakes the one that failed. `only` limits the first pass to
   * one channel. Each channel's queue is re-read before every send (an item queued meanwhile is picked up), and a drain
   * requested while one runs sets a flag that makes it go round again instead of being dropped.
   */
  const drain = useCallback(
    async (only?: string): Promise<void> => {
      if (!mountedRef.current) return;
      if (drainingRef.current) {
        drainAgainRef.current = true;
        return;
      }
      drainingRef.current = true;
      const tried = new Set<string>();
      let scope = only;
      try {
        do {
          drainAgainRef.current = false;
          for (const channelId of Object.keys(queuesRef.current)) {
            if (scope && channelId !== scope) continue;
            for (;;) {
              if (!mountedRef.current) return;
              const next = (queuesRef.current[channelId] ?? NO_ITEMS).find(
                (item) => !item.permanent,
              );
              if (!next || tried.has(next.localId)) break;
              tried.add(next.localId);
              const outcome = await attempt(next.localId);
              if (outcome === "offline") return;
              if (outcome !== "delivered") break;
            }
          }
          scope = undefined;
        } while (drainAgainRef.current && mountedRef.current);
      } finally {
        drainingRef.current = false;
      }
    },
    [attempt],
  );

  drainRef.current = drain;

  /**
   * A manual Retry on item N is allowed even with older items waiting: it may then send out of order, but only because
   * the user chose to. When it delivers (or the head turns out permanent) the followers queued behind it go out now.
   */
  const retry = useCallback(
    async (localId: string): Promise<AttemptOutcome> => {
      const channelId = findItem(queuesRef.current, localId)?.channelId;
      const outcome = await attempt(localId);
      const unblocked = outcome === "delivered" || findItem(queuesRef.current, localId)?.permanent;
      if (channelId && unblocked) await drain(channelId);
      return outcome;
    },
    [attempt, drain],
  );

  /** Allowed while a row is sending: if that request still lands, the message was delivered and is shown as such. */
  const discard = useCallback(
    (localId: string) => {
      const item = findItem(queuesRef.current, localId);
      remove(localId);
      // A head that had failed was what held its followers back.
      if (item?.error) void drain(item.channelId);
    },
    [remove, drain],
  );

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

  const itemsFor = useCallback((channelId: string) => queues[channelId] ?? NO_ITEMS, [queues]);
  const deliveredFor = useCallback(
    (channelId: string) => deliveredBy[channelId] ?? 0,
    [deliveredBy],
  );
  return { itemsFor, deliveredFor, enqueue, discard, retry, hasQueued, bindThread };
}

/** The open thread receives its channel's deliveries for as long as it is mounted (its latest merge handler, always). */
export function useBindOutboxThread(outbox: Outbox, channelId: string, merge: MergeHandler): void {
  const mergeRef = useRef(merge);
  useLayoutEffect(() => {
    mergeRef.current = merge;
  });
  const { bindThread } = outbox;
  useEffect(() => bindThread(channelId, (sent) => mergeRef.current(sent)), [bindThread, channelId]);
}
