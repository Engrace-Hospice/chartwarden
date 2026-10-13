// WP 2.5: server-side draft sync for one composer (the channel composer, or one thread root's reply composer).
//
// The composer keeps owning its text; this hook only mirrors it to PUT /channels/:id/draft:
//   - on open it reads the caller's own draft and puts it into an EMPTY composer (text already typed always wins);
//   - changes are saved after a quiet period, never per keystroke, strictly one request at a time;
//   - an emptied composer (a send, or the user clearing it) discards the server copy at once;
//   - each save names the revision this client last saw and a per-tab device id. A save from another device that
//     missed a newer revision is a 409: the hook reads the server copy and raises a merge prompt (`conflict`)
//     instead of overwriting it. Last writer wins per device, so a tab never conflicts with itself.
// A failed save never touches the composer; `saveFailed` only drives a small status line and clears on the next success.
import { useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageReferenceInput } from "./messaging-types";

export const DRAFT_SAVE_DEBOUNCE_MS = 1500;
const DRAFT_PATH = "/api/v1/messaging/channels/{id}/draft";
const DEVICE_KEY = "wx-messaging-draft-device";

export interface DraftContent {
  readonly body: string;
  readonly references: readonly MessageReferenceInput[];
}

export interface DraftConflict {
  readonly server: DraftContent & {
    readonly revision: number;
    readonly deviceId: string;
    readonly updatedAt: string;
  };
  readonly mine: DraftContent;
}

export type DraftResolution = "mine" | "theirs" | "both";

export interface ServerDraftSync {
  readonly conflict: DraftConflict | null;
  readonly saveFailed: boolean;
  readonly resolve: (choice: DraftResolution) => void;
}

interface WireReference {
  kind: "staff" | "patient";
  entityId: string;
  start: number;
  end: number;
}
interface WireDraft {
  body: string;
  references: WireReference[];
  revision: number;
  deviceId: string;
  updatedAt: string;
}

/** The thread-root selector; absent for the channel composer's own draft. */
const draftQuery = (parentMessageId: string | null): { parentMessageId?: string } =>
  parentMessageId ? { parentMessageId } : {};

let fallbackDeviceId: string | null = null;
/** One id per browser tab (sessionStorage), so two tabs of one user are two devices. */
function deviceId(): string {
  try {
    const stored = window.sessionStorage.getItem(DEVICE_KEY);
    if (stored) return stored;
    const created = crypto.randomUUID();
    window.sessionStorage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    fallbackDeviceId ??= `tab-${Math.random().toString(36).slice(2)}`;
    return fallbackDeviceId;
  }
}

/** The server stores no chip label; it is the mention text itself ("@Name"). */
function withLabels(body: string, references: readonly WireReference[]): MessageReferenceInput[] {
  return references.map((reference) => ({
    ...reference,
    displayLabel: body.slice(reference.start, reference.end).replace(/^@/, ""),
  }));
}

function toWire(references: readonly MessageReferenceInput[]): WireReference[] {
  return references.map(({ kind, entityId, start, end }) => ({ kind, entityId, start, end }));
}

/** "Combine both": mine, a blank line, then theirs, with their mention offsets moved past mine. */
export function mergeDraftBodies(mine: DraftContent, theirs: DraftContent): DraftContent {
  if (!mine.body.trim()) return theirs;
  if (!theirs.body.trim()) return mine;
  const body = `${mine.body}\n\n${theirs.body}`;
  const shift = mine.body.length + 2;
  return {
    body,
    references: [
      ...mine.references,
      ...theirs.references.map((r) => ({ ...r, start: r.start + shift, end: r.end + shift })),
    ],
  };
}

interface Snapshot {
  readonly body: string;
  readonly references: readonly MessageReferenceInput[];
}
const keyOf = (s: Snapshot): string => JSON.stringify([s.body, toWire(s.references)]);

export function useServerDraft(args: {
  channelId: string;
  parentMessageId?: string | null;
  text: string;
  references: readonly MessageReferenceInput[];
  /** Put a restored draft into the composer (only ever called while the composer is empty). */
  hydrate: (text: string, references: MessageReferenceInput[]) => void;
}): ServerDraftSync {
  const { channelId, text, references } = args;
  const parentMessageId = args.parentMessageId ?? null;
  const client = useApiClient();
  const [conflict, setConflict] = useState<DraftConflict | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  const latestRef = useRef<Snapshot>({ body: text, references });
  latestRef.current = { body: text, references };
  const hydrateRef = useRef(args.hydrate);
  hydrateRef.current = args.hydrate;
  const revisionRef = useRef(0);
  /** The content the server is known to hold (so a restore or a save is not echoed back). */
  const syncedKeyRef = useRef<string | null>(null);
  const loadedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const generationRef = useRef(0);
  const conflictRef = useRef<DraftConflict | null>(null);

  const readServer = useCallback(async (): Promise<WireDraft | null> => {
    const { data } = await client.GET(DRAFT_PATH, {
      params: { path: { id: channelId }, query: draftQuery(parentMessageId) },
    });
    return ((data as { draft?: WireDraft | null } | undefined)?.draft ?? null) as WireDraft | null;
  }, [client, channelId, parentMessageId]);

  /** Runs the work after everything queued before it; never rejects. */
  const enqueue = useCallback((work: () => Promise<void>): void => {
    queueRef.current = queueRef.current.then(work, work).catch(() => undefined);
  }, []);

  const save = useCallback(
    (snapshot: Snapshot, generation: number): Promise<void> => {
      const run = async (): Promise<void> => {
        if (generation !== generationRef.current) return;
        const key = keyOf(snapshot);
        if (key === syncedKeyRef.current) return;
        try {
          if (!snapshot.body.trim()) {
            if (revisionRef.current > 0) {
              await client.DELETE(DRAFT_PATH, {
                params: { path: { id: channelId }, query: draftQuery(parentMessageId) },
              });
            }
            revisionRef.current = 0;
            syncedKeyRef.current = key;
            setSaveFailed(false);
            return;
          }
          const result = await client.PUT(DRAFT_PATH, {
            params: { path: { id: channelId } },
            body: {
              body: snapshot.body,
              references: toWire(snapshot.references),
              deviceId: deviceId(),
              baseRevision: revisionRef.current,
              ...(parentMessageId ? { parentMessageId } : {}),
            },
          });
          if (generation !== generationRef.current) return;
          if (result.response?.status === 409) {
            const server = await readServer();
            if (generation !== generationRef.current) return;
            if (!server || server.body === snapshot.body) {
              // Already identical (or gone): adopt the server's revision and carry on; nothing to merge.
              revisionRef.current = server?.revision ?? 0;
              syncedKeyRef.current = server ? key : null;
              return;
            }
            const next: DraftConflict = {
              server: { ...server, references: withLabels(server.body, server.references) },
              mine: snapshot,
            };
            conflictRef.current = next;
            setConflict(next);
            return;
          }
          const saved = (result.data as { draft?: WireDraft | null } | undefined)?.draft;
          if (result.error || !saved) throw new Error("draft save failed");
          revisionRef.current = saved.revision;
          syncedKeyRef.current = key;
          setSaveFailed(false);
        } catch {
          if (generation === generationRef.current) setSaveFailed(true);
        }
      };
      return new Promise<void>((resolve) => {
        enqueue(() => run().finally(resolve));
      });
    },
    [client, channelId, parentMessageId, enqueue, readServer],
  );

  // Open / switch: forget the previous composer's bookkeeping, then restore this one's draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: channelId/parentMessageId ARE the reset triggers (readServer and save already close over them)
  useEffect(() => {
    const generation = ++generationRef.current;
    revisionRef.current = 0;
    syncedKeyRef.current = null;
    loadedRef.current = false;
    conflictRef.current = null;
    setConflict(null);
    setSaveFailed(false);
    void (async () => {
      let server: WireDraft | null = null;
      try {
        server = await readServer();
      } catch {
        // Offline or refused: the composer still works; the first save will say if the server is unreachable.
      }
      if (generation !== generationRef.current) return;
      loadedRef.current = true;
      if (server) {
        revisionRef.current = server.revision;
        if (!latestRef.current.body) {
          const restored = withLabels(server.body, server.references);
          syncedKeyRef.current = keyOf({ body: server.body, references: restored });
          hydrateRef.current(server.body, restored);
        }
      } else if (latestRef.current.body.trim()) {
        // Text typed before the read finished and nothing on the server: the change effect saves it.
        syncedKeyRef.current = null;
      }
    })();
    return () => {
      // Leaving this composer: flush what is pending against ITS channel/root, then invalidate.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        if (loadedRef.current) void save(latestRef.current, generation);
      }
    };
  }, [channelId, parentMessageId, readServer, save]);

  // Local change: empty -> discard now; otherwise save after a quiet period.
  // `references` is not read in the body but a change in it (same text) must still schedule a save.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!loadedRef.current && !text) return;
    if (conflictRef.current) return; // the user is choosing; do not race the prompt
    const snapshot = latestRef.current;
    const generation = generationRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (!snapshot.body.trim()) {
      void save(snapshot, generation);
      return;
    }
    if (keyOf(snapshot) === syncedKeyRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void save(latestRef.current, generation);
    }, DRAFT_SAVE_DEBOUNCE_MS);
    return () => {
      // A newer change replaces the timer; a leave is flushed by the open/switch effect's cleanup.
    };
  }, [text, references, save]);

  const resolve = useCallback(
    (choice: DraftResolution): void => {
      const current = conflictRef.current;
      if (!current) return;
      conflictRef.current = null;
      setConflict(null);
      revisionRef.current = current.server.revision;
      const generation = generationRef.current;
      if (choice === "theirs") {
        syncedKeyRef.current = keyOf(current.server);
        hydrateRef.current(current.server.body, [...current.server.references]);
        return;
      }
      const chosen =
        choice === "both" ? mergeDraftBodies(current.mine, current.server) : current.mine;
      if (choice === "both") hydrateRef.current(chosen.body, [...chosen.references]);
      syncedKeyRef.current = null;
      void save({ body: chosen.body, references: chosen.references }, generation);
    },
    [save],
  );

  return { conflict, saveFailed, resolve };
}
