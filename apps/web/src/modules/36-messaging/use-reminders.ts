// M36 WP 4.10 (ADR-0077) - the caller's own pending reminders. ONE read per API client (`GET /reminders`) serves every message row:
// its success is the signal that the feature is on (a 404 reads as OFF; any other failure keeps the last good index and shows OFF only when there was none) and its rows feed the per-message "Reminder set" state. A failure is cached only briefly; a 404 ("off") is cached. A set or cancel calls `refreshReminders` so the rows
// re-read. No polling. The server stays the authority: with the flag off its routes answer 404.
import type { ReminderDto } from "@wardenx/types";
import type { ApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalApiClient } from "./use-promotions-enabled";

export interface RemindersIndex {
  readonly enabled: boolean;
  readonly reminders: readonly ReminderDto[];
}

const OFF: RemindersIndex = { enabled: false, reminders: [] };
/** `null` = the read FAILED (not the same as OFF): a re-read that fails keeps the last good index on screen. */
const sharedReads = new WeakMap<ApiClient, Promise<RemindersIndex | null>>();
const listeners = new Set<() => void>();
/** The last index a read (or a successful write) established, per client: what a failed re-read falls back to. */
const lastGood = new WeakMap<ApiClient, RemindersIndex>();
/** A failed read is remembered this long so a screen full of rows does not re-fire it on every mount. */
const FAILURE_TTL_MS = 30_000;

function readIndex(client: ApiClient): Promise<RemindersIndex | null> {
  const cached = sharedReads.get(client);
  if (cached) return cached;
  const fail = (): RemindersIndex | null => {
    setTimeout(() => {
      if (sharedReads.get(client) === read) sharedReads.delete(client);
    }, FAILURE_TTL_MS);
    // A failed read falls back to the last good index (with any successful write applied), never to a stale-looking OFF.
    return lastGood.get(client) ?? null;
  };
  // Deferred a tick so a client that throws (not just rejects) also fails closed.
  const read = Promise.resolve()
    .then(() => client.GET("/api/v1/messaging/reminders"))
    .then((result) => {
      if (result?.data && Array.isArray(result.data.reminders)) {
        const index = { enabled: true, reminders: result.data.reminders };
        lastGood.set(client, index);
        return index;
      }
      // Only a 404 means the feature is off for the tenant (cached for the client's life). Anything else is a failed read.
      return result?.response?.status === 404 ? OFF : fail();
    }, fail);
  sharedReads.set(client, read);
  return read;
}

/** Drop the cached read and tell every mounted row to read again. */
export function refreshReminders(
  client: ApiClient,
  patch?: (reminders: readonly ReminderDto[]) => readonly ReminderDto[],
): void {
  const known = lastGood.get(client);
  if (patch && known) lastGood.set(client, { ...known, reminders: patch(known.reminders) });
  sharedReads.delete(client);
  for (const listener of listeners) listener();
}

export function useRemindersIndex(skip = false): RemindersIndex {
  const client = useOptionalApiClient();
  const [index, setIndex] = useState<RemindersIndex>(OFF);
  const latestRead = useRef(0);
  useEffect(() => {
    if (!client || skip) return;
    let current = true;
    const load = (): void => {
      const id = ++latestRead.current;
      void readIndex(client).then((value) => {
        // A superseded read (a refresh overtook it) or an unmounted row must not write state; a failed read keeps what is shown.
        if (current && id === latestRead.current && value) setIndex(value);
      });
    };
    listeners.add(load);
    load();
    return () => {
      current = false;
      listeners.delete(load);
    };
  }, [client, skip]);
  return skip ? OFF : index;
}

export type ReminderResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number | undefined; readonly code: string | undefined };

const NETWORK_FAILURE: ReminderResult = { ok: false, status: undefined, code: undefined };

interface RawAnswer {
  readonly data?: unknown;
  readonly error?: { readonly error?: { readonly code?: string } };
  readonly response?: { readonly status: number };
}

export function useReminderActions() {
  const client = useOptionalApiClient();
  const finish = useCallback(
    (
      answer: RawAnswer,
      patch?: (r: readonly ReminderDto[]) => readonly ReminderDto[],
    ): ReminderResult => {
      if (answer.data === undefined) {
        return { ok: false, status: answer.response?.status, code: answer.error?.error?.code };
      }
      if (client) refreshReminders(client, patch);
      return { ok: true };
    },
    [client],
  );
  const set = useCallback(
    async (messageId: string, remindAt: Date, idempotencyKey?: string): Promise<ReminderResult> => {
      if (!client) return NETWORK_FAILURE;
      try {
        const answer = await client.PUT("/api/v1/messaging/messages/{id}/reminder", {
          params: {
            path: { id: messageId },
            header: { "Idempotency-Key": idempotencyKey ?? crypto.randomUUID() },
          },
          body: { remind_at: remindAt.toISOString() },
        });
        const saved = answer.data;
        return finish(
          answer,
          saved ? (list) => [...list.filter((r) => r.message_id !== messageId), saved] : undefined,
        );
      } catch {
        return NETWORK_FAILURE;
      }
    },
    [client, finish],
  );
  const cancel = useCallback(
    async (messageId: string): Promise<ReminderResult> => {
      if (!client) return NETWORK_FAILURE;
      try {
        return finish(
          await client.DELETE("/api/v1/messaging/messages/{id}/reminder", {
            params: { path: { id: messageId } },
          }),
          (list) => list.filter((r) => r.message_id !== messageId),
        );
      } catch {
        return NETWORK_FAILURE;
      }
    },
    [client, finish],
  );
  return { set, cancel };
}
