import { useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiErrorCode, selectFiles, sha256Hex, withRequestDeadline } from "./attachment-utils";
import type { AttachmentChip } from "./messaging-types";

/**
 * WP 1.5 composer-side upload pipeline: hash -> authorize -> PUT -> complete -> (poll while scanning).
 *
 * Idempotency follows the send composer's rule (see sendAttemptFor): every request that needs a key has its
 * OWN key per item, reused when no reply arrived (lost-reply retry) and rotated after any answered error,
 * because the server caches answered failures under the key.
 *
 * Bounded work: at most MAX_CONCURRENT_UPLOADS items hash/upload at once (the rest queue); every item has an
 * AbortController (remove, channel switch and unmount abort it); the PUT has a stall deadline; a status poll ends
 * on a terminal answer, an answered 4xx, an unknown value, or POLL_BUDGET_MS.
 */

type Stage = "authorize" | "put" | "complete";

interface UploadTicket {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly expiresAtMs: number;
}

/** Internals the chip does not need to render. */
interface Tracked extends AttachmentChip {
  readonly stage: Stage;
  readonly sha256Hex: string | null;
  readonly ticket: UploadTicket | null;
  readonly authorizeKey: string;
  readonly completeKey: string;
}

const POLL_START_MS = 3_000;
const POLL_MAX_MS = 15_000;
/** After this long still "scanning" the poll stops; the chip stays sendable (the backend binds a pending file). */
const POLL_BUDGET_MS = 10 * 60_000;
const MAX_CONCURRENT_UPLOADS = 2;
/** fetch cannot report upload progress, so this is a deadline for the whole PUT (25 MB in 5 min is ~85 KB/s). */
const PUT_STALL_MS = 5 * 60_000;
const STILL_SCANNING_MESSAGE = "Still scanning. You can send now; it is delivered once cleared.";
const BLOCKED_MESSAGE = "This file was blocked by the security scan. Remove it.";
const GONE_MESSAGE = "This file is no longer available. Remove it.";
const NETWORK_MESSAGE = "Upload interrupted. Check your connection and retry.";
const STALLED_MESSAGE = "The upload took too long. Check your connection and retry.";
const REATTACH_MESSAGE = "The server refused this file. Remove it and attach it again.";
const SCAN_UNREADABLE_MESSAGE = "The scan result could not be read. Retry, or remove the file.";

const AUTHORIZE_MESSAGES: Readonly<Record<string, string>> = {
  UNSUPPORTED_MEDIA_TYPE: "This file type is not allowed.",
  UPLOAD_SIZE_INVALID: "This file is too large or empty.",
  CHANNEL_ARCHIVED: "This conversation is archived.",
  DEGRADED: "File upload is not available right now.",
};

type Verdict = "available" | "blocked" | "pending" | "gone" | "unknown";

/** What a status reply means. Only 404/410 mean the file is gone; 401/403/408/429/5xx and other answers are transient. */
function verdictOf(result: {
  data?: { availability?: string; attached?: boolean };
  response?: Response;
}): Verdict {
  if (result.data) {
    if (result.data.attached) return "gone";
    switch (result.data.availability) {
      case "available":
        return "available";
      case "blocked":
        return "blocked";
      case "scanning":
      case "uploading":
        return "pending";
      default:
        return "unknown";
    }
  }
  const status = result.response?.status ?? 0;
  return status === 404 || status === 410 ? "gone" : "pending";
}

function answered(result: { error?: unknown; response?: Response }): boolean {
  return Boolean(result.error) || (result.response?.status ?? 0) >= 400;
}

export interface AttachmentUploads {
  readonly chips: readonly AttachmentChip[];
  readonly notices: readonly string[];
  /** True while a file is still hashing/uploading, or failed/blocked: Send must wait or the chip be removed. */
  readonly blocksSend: boolean;
  /** Ids to bind: ready and still-scanning files (the backend accepts pending). */
  readonly sendableIds: readonly string[];
  addFiles: (files: readonly File[]) => void;
  remove: (localId: string) => void;
  retry: (localId: string) => void;
  /** Re-read each bound candidate's status and flag the ones that can no longer be sent. */
  recheck: () => Promise<void>;
  reset: () => void;
}

export function useAttachmentUploads(channelId: string): AttachmentUploads {
  const client = useApiClient();
  const [tracked, setTracked] = useState<readonly Tracked[]>([]);
  const [notices, setNotices] = useState<readonly string[]>([]);
  const itemsRef = useRef<readonly Tracked[]>([]);
  const generationRef = useRef(0);
  const runningRef = useRef(new Set<string>());
  const queueRef = useRef<string[]>([]);
  const pollTimers = useRef(new Map<string, number>());
  const controllers = useRef(new Map<string, AbortController>());
  const recheckControllers = useRef(new Map<string, AbortController>());
  const pumpRef = useRef<() => void>(() => {});

  const commit = useCallback((next: readonly Tracked[]) => {
    itemsRef.current = next;
    setTracked(next);
  }, []);

  const patch = useCallback(
    (localId: string, changes: Partial<Tracked>) => {
      // A removed item (or one from a previous channel) is gone from the ref: late responses become no-ops.
      if (!itemsRef.current.some((item) => item.localId === localId)) return;
      commit(
        itemsRef.current.map((item) => (item.localId === localId ? { ...item, ...changes } : item)),
      );
    },
    [commit],
  );

  const stopPolling = useCallback((localId: string) => {
    const timer = pollTimers.current.get(localId);
    if (timer !== undefined) window.clearTimeout(timer);
    pollTimers.current.delete(localId);
  }, []);

  const abortItem = useCallback((localId: string) => {
    controllers.current.get(localId)?.abort();
    controllers.current.delete(localId);
    recheckControllers.current.get(localId)?.abort();
    recheckControllers.current.delete(localId);
  }, []);

  // Stop every poll, abort every in-flight request and drop the queue: late replies see a new generation.
  const teardown = useCallback(() => {
    generationRef.current += 1;
    for (const timer of pollTimers.current.values()) window.clearTimeout(timer);
    pollTimers.current.clear();
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    for (const controller of recheckControllers.current.values()) controller.abort();
    recheckControllers.current.clear();
    queueRef.current = [];
    runningRef.current.clear();
  }, []);

  const reset = useCallback(() => {
    teardown();
    commit([]);
    setNotices([]);
  }, [commit, teardown]);

  // New channel: drop every chip. Unmount: only teardown (no state update on an unmounted hook).
  // biome-ignore lint/correctness/useExhaustiveDependencies: channelId is the reset trigger
  useEffect(() => {
    reset();
    return teardown;
  }, [channelId, reset, teardown]);

  const poll = useCallback(
    (localId: string, attachmentId: string, delay: number, startedAt: number) => {
      const generation = generationRef.current;
      const timer = window.setTimeout(async () => {
        pollTimers.current.delete(localId);
        if (generation !== generationRef.current) return;
        const controller = new AbortController();
        controllers.current.set(localId, controller);
        let verdict: Verdict = "pending";
        try {
          const result = await client.GET("/api/v1/messaging/attachments/{id}", {
            params: { path: { id: attachmentId } },
            signal: controller.signal,
          });
          verdict = verdictOf(result);
        } catch {
          // A thrown request is transient (or an abort, which the guards below drop).
        }
        if (controllers.current.get(localId) === controller) controllers.current.delete(localId);
        if (generation !== generationRef.current) return;
        if (!itemsRef.current.some((item) => item.localId === localId)) return;
        if (verdict === "available") return patch(localId, { status: "ready", message: null });
        if (verdict === "blocked") {
          return patch(localId, { status: "blocked", message: BLOCKED_MESSAGE });
        }
        if (verdict === "gone" || verdict === "unknown") {
          return patch(localId, { status: "failed", message: SCAN_UNREADABLE_MESSAGE });
        }
        if (Date.now() - startedAt >= POLL_BUDGET_MS) {
          return patch(localId, { message: STILL_SCANNING_MESSAGE });
        }
        poll(localId, attachmentId, Math.min(delay * 2, POLL_MAX_MS), startedAt);
      }, delay);
      pollTimers.current.set(localId, timer);
    },
    [client, patch],
  );

  const run = useCallback(
    async (localId: string): Promise<void> => {
      if (runningRef.current.has(localId)) return;
      const generation = generationRef.current;
      const controller = new AbortController();
      const { signal } = controller;
      controllers.current.set(localId, controller);
      const live = (): Tracked | undefined =>
        generation === generationRef.current
          ? itemsRef.current.find((item) => item.localId === localId)
          : undefined;
      const fail = (message: string, changes: Partial<Tracked> = {}) =>
        patch(localId, { status: "failed", message, ...changes });
      runningRef.current.add(localId);
      try {
        let item = live();
        if (!item) return;

        if (item.stage === "authorize") {
          patch(localId, { status: "hashing", message: null });
          let digest = item.sha256Hex;
          if (!digest) {
            try {
              digest = await sha256Hex(item.file);
            } catch {
              if (live()) fail("This file could not be read.");
              return;
            }
            if (!live()) return;
            patch(localId, { sha256Hex: digest });
          }
          patch(localId, { status: "uploading" });
          const { authorizeKey, fileName, contentType, byteSize } = item;
          const authorizeDeadline = withRequestDeadline(signal);
          const authorize = () =>
            client.POST("/api/v1/messaging/attachments/uploads", {
              params: { header: { "Idempotency-Key": authorizeKey } },
              body: { channelId, fileName, contentType, byteSize, sha256Hex: digest },
              signal: authorizeDeadline.signal,
            });
          let result: Awaited<ReturnType<typeof authorize>>;
          try {
            result = await authorize();
          } catch {
            if (live()) fail(authorizeDeadline.expired() ? STALLED_MESSAGE : NETWORK_MESSAGE);
            return;
          }
          item = live();
          if (!item) return;
          if (!result.data) {
            const message =
              AUTHORIZE_MESSAGES[apiErrorCode(result.error) ?? ""] ??
              "The upload could not be started.";
            fail(message, answered(result) ? { authorizeKey: crypto.randomUUID() } : {});
            return;
          }
          const { attachmentId: authorizedId, upload } = result.data;
          patch(localId, {
            attachmentId: authorizedId,
            stage: "put",
            ticket: {
              url: upload.url,
              headers: upload.headers,
              expiresAtMs: Date.parse(upload.expiresAt),
            },
          });
          item = live();
          if (!item) return;
        }

        if (item.stage === "put") {
          const ticket = item.ticket;
          if (!ticket || ticket.expiresAtMs <= Date.now()) {
            // The presigned URL lapsed while the user waited: a fresh authorization needs a fresh key.
            fail(NETWORK_MESSAGE, {
              stage: "authorize",
              ticket: null,
              authorizeKey: crypto.randomUUID(),
            });
            return;
          }
          patch(localId, { status: "uploading", message: null });
          let stalled = false;
          const stallTimer = window.setTimeout(() => {
            stalled = true;
            controller.abort();
          }, PUT_STALL_MS);
          let response: Response;
          try {
            response = await fetch(ticket.url, {
              method: "PUT",
              headers: ticket.headers,
              body: item.file,
              signal,
            });
          } catch {
            if (live()) fail(stalled ? STALLED_MESSAGE : NETWORK_MESSAGE);
            return;
          } finally {
            window.clearTimeout(stallTimer);
          }
          if (!live()) return;
          if (!response.ok) {
            fail("The file could not be uploaded. Retry to start again.", {
              stage: "authorize",
              ticket: null,
              authorizeKey: crypto.randomUUID(),
            });
            return;
          }
          patch(localId, { stage: "complete" });
          item = live();
          if (!item) return;
        }

        patch(localId, { status: "uploading", message: null });
        const { attachmentId, completeKey } = item;
        const completeDeadline = withRequestDeadline(signal);
        const complete = () =>
          client.POST("/api/v1/messaging/attachments/{id}/complete", {
            params: {
              path: { id: attachmentId ?? "" },
              header: { "Idempotency-Key": completeKey },
            },
            signal: completeDeadline.signal,
          });
        let completion: Awaited<ReturnType<typeof complete>>;
        try {
          completion = await complete();
        } catch {
          if (live()) fail(completeDeadline.expired() ? STALLED_MESSAGE : NETWORK_MESSAGE);
          return;
        }
        if (!live()) return;
        if (!completion.data) {
          const code = apiErrorCode(completion.error);
          const rotated = answered(completion) ? { completeKey: crypto.randomUUID() } : {};
          if (code === "ATTACHMENT_NOT_UPLOADED") {
            fail("The upload did not finish. Retry to send the file again.", {
              ...rotated,
              stage: "put",
            });
          } else if (code === "ATTACHMENT_UPLOAD_MISMATCH") {
            fail("The file changed while uploading. Retry to start again.", {
              stage: "authorize",
              ticket: null,
              authorizeKey: crypto.randomUUID(),
              completeKey: crypto.randomUUID(),
            });
          } else {
            fail("The upload could not be finished. Retry.", rotated);
          }
          return;
        }
        const availability = completion.data.availability;
        if (availability === "available") patch(localId, { status: "ready", message: null });
        else if (availability === "blocked") {
          patch(localId, { status: "blocked", message: BLOCKED_MESSAGE });
        } else {
          patch(localId, { status: "scanning", message: null });
          poll(localId, attachmentId ?? "", POLL_START_MS, Date.now());
        }
      } catch {
        // A malformed reply must surface as a retryable chip, never as an unhandled rejection.
        if (live()) fail("The upload could not be finished. Retry.");
      } finally {
        if (controllers.current.get(localId) === controller) controllers.current.delete(localId);
        if (generation === generationRef.current) {
          runningRef.current.delete(localId);
          pumpRef.current();
        }
      }
    },
    [channelId, client, patch, poll],
  );

  // Start queued items until MAX_CONCURRENT_UPLOADS are running; a finishing run calls this again.
  const pump = useCallback(() => {
    while (runningRef.current.size < MAX_CONCURRENT_UPLOADS) {
      const next = queueRef.current.shift();
      if (next === undefined) return;
      void run(next);
    }
  }, [run]);
  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  const enqueue = useCallback(
    (localIds: readonly string[]) => {
      for (const localId of localIds) {
        if (!queueRef.current.includes(localId) && !runningRef.current.has(localId)) {
          queueRef.current.push(localId);
        }
      }
      pump();
    },
    [pump],
  );

  const addFiles = useCallback(
    (files: readonly File[]) => {
      const { accepted, rejections } = selectFiles(files, itemsRef.current.length);
      setNotices(rejections);
      if (accepted.length === 0) return;
      const created: Tracked[] = accepted.map(({ file, contentType }) => ({
        localId: crypto.randomUUID(),
        file,
        fileName: file.name,
        contentType,
        byteSize: file.size,
        status: "hashing",
        message: null,
        attachmentId: null,
        stage: "authorize",
        sha256Hex: null,
        ticket: null,
        authorizeKey: crypto.randomUUID(),
        completeKey: crypto.randomUUID(),
      }));
      commit([...itemsRef.current, ...created]);
      enqueue(created.map((item) => item.localId));
    },
    [commit, enqueue],
  );

  const remove = useCallback(
    (localId: string) => {
      stopPolling(localId);
      abortItem(localId);
      queueRef.current = queueRef.current.filter((queued) => queued !== localId);
      runningRef.current.delete(localId);
      commit(itemsRef.current.filter((item) => item.localId !== localId));
      pumpRef.current();
    },
    [abortItem, commit, stopPolling],
  );

  const retry = useCallback(
    (localId: string) => {
      patch(localId, { status: "hashing", message: null });
      enqueue([localId]);
    },
    [enqueue, patch],
  );

  // After a refused send: find out which candidates are no longer sendable so the user knows what to remove.
  // If none can be flagged (the refusal names no culprit), every attached chip needs re-attaching: leaving them
  // sendable would offer a Retry of the same refused payload.
  const recheck = useCallback(async (): Promise<void> => {
    const generation = generationRef.current;
    const candidates = itemsRef.current.filter(
      (item) => item.attachmentId && (item.status === "ready" || item.status === "scanning"),
    );
    // True when a verdict was applied to the chip as it was when the read started.
    const applyIfUnchanged = (
      localId: string,
      read: Pick<Tracked, "status" | "attachmentId">,
      changes: Partial<Tracked>,
    ): boolean => {
      if (generation !== generationRef.current) return false;
      const now = itemsRef.current.find((item) => item.localId === localId);
      if (!now || now.status !== read.status || now.attachmentId !== read.attachmentId)
        return false;
      patch(localId, changes);
      return true;
    };
    const flagged = await Promise.all(
      candidates.map(async ({ localId, attachmentId, status }) => {
        const controller = new AbortController();
        recheckControllers.current.set(localId, controller);
        const deadline = withRequestDeadline(controller.signal);
        try {
          const result = await client.GET("/api/v1/messaging/attachments/{id}", {
            params: { path: { id: attachmentId ?? "" } },
            signal: deadline.signal,
          });
          const verdict = verdictOf(result);
          const read = { status, attachmentId };
          if (verdict === "blocked" || verdict === "gone") {
            const message = verdict === "blocked" ? BLOCKED_MESSAGE : GONE_MESSAGE;
            if (!applyIfUnchanged(localId, read, { status: "blocked", message })) return false;
            stopPolling(localId);
            return true;
          }
          if (verdict === "available")
            applyIfUnchanged(localId, read, { status: "ready", message: null });
        } catch {
          // Status unreachable, timed out or aborted (or pending/unknown/401/403/5xx above): leave the chip.
        } finally {
          if (recheckControllers.current.get(localId) === controller) {
            recheckControllers.current.delete(localId);
          }
        }
        return false;
      }),
    );
    if (generation !== generationRef.current || flagged.some(Boolean)) return;
    for (const item of itemsRef.current) {
      if (item.attachmentId && (item.status === "ready" || item.status === "scanning")) {
        stopPolling(item.localId);
        patch(item.localId, { status: "reattach", message: REATTACH_MESSAGE });
      }
    }
  }, [client, patch, stopPolling]);

  const chips: readonly AttachmentChip[] = tracked.map(
    ({ localId, file, fileName, contentType, byteSize, status, message, attachmentId }) => ({
      localId,
      file,
      fileName,
      contentType,
      byteSize,
      status,
      message,
      attachmentId,
    }),
  );
  return {
    chips,
    notices,
    blocksSend: tracked.some((item) => !(item.status === "ready" || item.status === "scanning")),
    sendableIds: tracked.flatMap((item) =>
      (item.status === "ready" || item.status === "scanning") && item.attachmentId
        ? [item.attachmentId]
        : [],
    ),
    addFiles,
    remove,
    retry,
    recheck,
    reset,
  };
}
