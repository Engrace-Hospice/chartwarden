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
import { SBAR_SECTION_KEYS, type SbarSections } from "@chartwarden/types";
import { useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { currentSessionIdentity, useSession } from "../../shell/session";
import type { MessageReferenceInput } from "./messaging-types";
import { isBlankSbar, normaliseSbar } from "./sbar-utils";

export const DRAFT_SAVE_DEBOUNCE_MS = 1500;
const DRAFT_PATH = "/api/v1/messaging/channels/{id}/draft";
export const MAX_SAVE_ATTEMPTS = 8;
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30_000;
const DEVICE_KEY = "wx-messaging-draft-device";

export interface DraftContent {
  readonly body: string;
  readonly references: readonly MessageReferenceInput[];
  /** The channel composer's in-progress SBAR form, saved in the same slot (WP 3.3); null/absent when none. */
  readonly sbar?: SbarSections | null;
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
  /** Autosave stopped retrying (a permanent refusal, or the attempt cap): the text is kept in this tab's memory only until the next edit. */
  readonly saveGaveUp: boolean;
  /** The server confirmed exactly what the composer holds now (text and SBAR), so a "saved" claim is true. */
  readonly sbarSaved: boolean;
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
  sbar?: SbarSections;
  revision: number;
  deviceId: string;
  updatedAt: string;
}

/** A save the server (or the network) refused; `status` 0 means no answer at all. */
class SaveError extends Error {
  constructor(readonly status: number) {
    super(`draft request failed (${status})`);
  }
}

/** A 4xx other than "slow down / try later" will not get better by repeating the same request. */
const isPermanentFailure = (status: number): boolean =>
  status >= 400 && status < 500 && status !== 408 && status !== 429;

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
  // The SBAR form is not merged text: mine wins when it has content, otherwise theirs.
  const sbar = isBlankSbar(mine.sbar) ? (theirs.sbar ?? null) : (mine.sbar ?? null);
  const withSbar = (content: DraftContent): DraftContent =>
    sbar ? { ...content, sbar } : { body: content.body, references: content.references };
  if (!mine.body.trim()) return withSbar(theirs);
  if (!theirs.body.trim()) return withSbar(mine);
  const body = `${mine.body}\n\n${theirs.body}`;
  const shift = mine.body.length + 2;
  return withSbar({
    body,
    references: [
      ...mine.references,
      ...theirs.references.map((r) => ({ ...r, start: r.start + shift, end: r.end + shift })),
    ],
  });
}

interface Snapshot {
  readonly body: string;
  readonly references: readonly MessageReferenceInput[];
  /** Null when blank: a blank form is never part of the slot. */
  readonly sbar: SbarSections | null;
}
/** One key for both the server's copy and the form's state: sections in canonical order, missing ones as "". */
const sbarKeyOf = (sbar: SbarSections | null | undefined): string => {
  if (!sbar || isBlankSbar(sbar)) return "";
  const { urgencyHint, sections } = normaliseSbar(sbar);
  return JSON.stringify([urgencyHint, SBAR_SECTION_KEYS.map((key) => sections[key])]);
};
const keyOf = (s: Omit<Snapshot, "sbar"> & { readonly sbar?: SbarSections | null }): string =>
  JSON.stringify([s.body, toWire(s.references), sbarKeyOf(s.sbar)]);
/** Nothing worth keeping: no text and no SBAR content (the way a send or a clear discards the server copy). */
const isEmptySnapshot = (s: Snapshot): boolean => !s.body.trim() && isBlankSbar(s.sbar);
const sbarField = (s: Snapshot): { sbar?: SbarSections } =>
  s.sbar && !isBlankSbar(s.sbar) ? { sbar: s.sbar } : {};

export function useServerDraft(args: {
  channelId: string;
  parentMessageId?: string | null;
  text: string;
  references: readonly MessageReferenceInput[];
  /** The channel composer's SBAR form (null when blank); saved and restored in the same slot as the text. */
  sbar?: SbarSections | null;
  /** A send of this composer's text is in flight: nothing is saved or flushed (the server deletes the draft on send). */
  suspended?: boolean;
  /** Put a restored draft into the composer (only ever called while the composer is empty). */
  hydrate: (
    text: string,
    references: MessageReferenceInput[],
    sbar: SbarSections | null,
    /** True only for the first restore after the read, where an urgency the user already picked is kept. */
    initialRead?: boolean,
  ) => void;
}): ServerDraftSync {
  const { channelId, text, references } = args;
  const sbar = args.sbar && !isBlankSbar(args.sbar) ? args.sbar : null;
  const sbarKey = sbarKeyOf(sbar);
  const suspended = args.suspended ?? false;
  const parentMessageId = args.parentMessageId ?? null;
  const client = useApiClient();
  const [conflict, setConflict] = useState<DraftConflict | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saveGaveUp, setSaveGaveUp] = useState(false);
  const pendingRef = useRef<Snapshot | null>(null);
  // The identity this slot was opened under. The shared client sends as whoever is signed in NOW, so nothing (the
  // debounce, a queued or retried save, the unmount flush) may be sent after the identity changed: it would land in
  // the new user's draft slot. "" means the session was still loading at open; it adopts the first real identity.
  const slotIdentityRef = useRef("");
  // Adopt the first real identity EAGERLY (from the context this render sees; the module-level one is only updated by
  // the provider's layout effect, which runs after this one) and never overwrite a known one. Documented ceiling:
  // after a genuine in-page identity change a composer that stays mounted stays inert until its slot changes (safe;
  // identity changes are full page loads today).
  const session = useSession();
  const contextIdentity = session ? `${session.organizationId}:${session.userId}` : "";
  useLayoutEffect(() => {
    if (slotIdentityRef.current === "" && contextIdentity !== "") {
      slotIdentityRef.current = contextIdentity;
    }
  }, [contextIdentity]);
  const identityUnchanged = useCallback((): boolean => {
    const current = currentSessionIdentity();
    if (slotIdentityRef.current === "" && current !== "") slotIdentityRef.current = current;
    return slotIdentityRef.current === current;
  }, []);

  const latestRef = useRef<Snapshot>({ body: text, references, sbar });
  latestRef.current = { body: text, references, sbar };
  const hydrateRef = useRef(args.hydrate);
  hydrateRef.current = args.hydrate;
  const revisionRef = useRef(0);
  /** The content the server is known to hold (so a restore or a save is not echoed back). */
  const syncedKeyRef = useRef<string | null>(null);
  // The same value as state, so "the server holds what the composer holds" can drive a render (the "saved" claim).
  const [syncedKey, setSyncedKey] = useState<string | null>(null);
  const markSynced = useCallback((key: string | null): void => {
    syncedKeyRef.current = key;
    setSyncedKey(key);
  }, []);
  const loadedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const generationRef = useRef(0);
  const conflictRef = useRef<DraftConflict | null>(null);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failuresRef = useRef(0);
  const scheduleRef = useRef<() => void>(() => undefined);
  const saveRef = useRef<(snapshot: Snapshot, generation: number) => Promise<void>>(
    async () => undefined,
  );

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

  /** Retry a failed save on its own with a growing delay (the status line promises it). */
  const armRetry = useCallback((generation: number, status: number): void => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    const delay = Math.min(RETRY_BASE_MS * 2 ** failuresRef.current, RETRY_MAX_MS);
    failuresRef.current += 1;
    // Give up on a permanent refusal or after the attempt cap; only new typing re-arms a save.
    if (isPermanentFailure(status) || failuresRef.current >= MAX_SAVE_ATTEMPTS) {
      setSaveGaveUp(true);
      return;
    }
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      if (generation !== generationRef.current || suspendedRef.current) return;
      if (conflictRef.current) return;
      void saveRef.current(latestRef.current, generation);
    }, delay);
  }, []);

  const save = useCallback(
    (snapshot: Snapshot, generation: number): Promise<void> => {
      const run = async (): Promise<void> => {
        if (generation !== generationRef.current) return;
        if (!identityUnchanged()) return; // never write a draft under a different identity
        const key = keyOf(snapshot);
        if (key === syncedKeyRef.current) return;
        try {
          if (isEmptySnapshot(snapshot)) {
            if (revisionRef.current > 0) {
              const removed = await client.DELETE(DRAFT_PATH, {
                params: { path: { id: channelId }, query: draftQuery(parentMessageId) },
              });
              const status = removed.response?.status ?? 0;
              // 404: the draft is already gone (a send removes it with the message), which is the goal.
              if ((removed.error || status >= 400) && status !== 404) throw new SaveError(status);
            }
            revisionRef.current = 0;
            markSynced(key);
            failuresRef.current = 0;
            setSaveFailed(false);
            setSaveGaveUp(false);
            return;
          }
          const result = await client.PUT(DRAFT_PATH, {
            params: { path: { id: channelId } },
            body: {
              body: snapshot.body,
              references: toWire(snapshot.references),
              ...sbarField(snapshot),
              deviceId: deviceId(),
              baseRevision: revisionRef.current,
              ...(parentMessageId ? { parentMessageId } : {}),
            },
          });
          if (generation !== generationRef.current) return;
          if (result.response?.status === 409) {
            const server = await readServer();
            if (generation !== generationRef.current || !identityUnchanged()) return;
            if (
              !server ||
              (server.body === snapshot.body && sbarKeyOf(server.sbar) === sbarKeyOf(snapshot.sbar))
            ) {
              // Already identical (or gone): adopt the server's revision and carry on; nothing to merge.
              revisionRef.current = server?.revision ?? 0;
              markSynced(server ? key : null);
              // Text typed while the request was in flight still needs its own save.
              if (keyOf(latestRef.current) !== key) scheduleRef.current();
              return;
            }
            if (isEmptySnapshot(latestRef.current)) return; // emptied meanwhile: the change effect discards
            const next: DraftConflict = {
              server: {
                ...server,
                references: withLabels(server.body, server.references),
                sbar: server.sbar ?? null,
              },
              mine: latestRef.current,
            };
            conflictRef.current = next;
            setConflict(next);
            return;
          }
          const saved = (result.data as { draft?: WireDraft | null } | undefined)?.draft;
          if (result.error || !saved) throw new SaveError(result.response?.status ?? 0);
          revisionRef.current = saved.revision;
          markSynced(key);
          failuresRef.current = 0;
          setSaveFailed(false);
          setSaveGaveUp(false);
        } catch (error) {
          if (generation !== generationRef.current) return;
          setSaveFailed(true);
          armRetry(generation, error instanceof SaveError ? error.status : 0);
        }
      };
      return new Promise<void>((resolve) => {
        enqueue(() => run().finally(resolve));
      });
    },
    [
      client,
      channelId,
      parentMessageId,
      enqueue,
      readServer,
      armRetry,
      identityUnchanged,
      markSynced,
    ],
  );
  saveRef.current = save;

  // Open / switch: forget the previous composer's bookkeeping, then restore this one's draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: channelId/parentMessageId ARE the reset triggers (readServer and save already close over them)
  useEffect(() => {
    slotIdentityRef.current = currentSessionIdentity();
    const generation = ++generationRef.current;
    revisionRef.current = 0;
    markSynced(null);
    loadedRef.current = false;
    conflictRef.current = null;
    failuresRef.current = 0;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    setConflict(null);
    setSaveFailed(false);
    setSaveGaveUp(false);
    void (async () => {
      let server: WireDraft | null = null;
      try {
        server = await readServer();
      } catch {
        // Offline or refused: the composer still works; the first save will say if the server is unreachable.
      }
      if (generation !== generationRef.current || !identityUnchanged()) return;
      loadedRef.current = true;
      if (server) {
        revisionRef.current = server.revision;
        // Text and SBAR hydrate independently: whatever the user already typed wins for its own part only, so typing
        // one before the read returns never makes the next save delete the server's other half.
        const local = latestRef.current;
        const hydrateText = !local.body;
        const serverSbar = server.sbar ? normaliseSbar(server.sbar) : null;
        const hydrateSbar = isBlankSbar(local.sbar) && !isBlankSbar(serverSbar);
        const restored = withLabels(server.body, server.references);
        markSynced(keyOf({ body: server.body, references: restored, sbar: serverSbar }));
        if (hydrateText || hydrateSbar) {
          hydrateRef.current(
            hydrateText ? server.body : local.body,
            hydrateText ? restored : [...local.references],
            hydrateSbar ? serverSbar : local.sbar,
            true,
          );
        }
      } else if (!isEmptySnapshot(latestRef.current)) {
        // Text typed before the read finished and nothing on the server: the change effect saves it.
        markSynced(null);
      }
    })();
    return () => {
      // Leaving this composer: flush what is pending against ITS channel/root, then invalidate. A send in flight
      // owns the text (the server drops the draft with the message), so it is never flushed back as a draft.
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        // The text armed for THIS slot, with THIS slot's revision, sent straight away: by the time a queued save
        // would run, the next slot's bookkeeping has replaced both.
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (
          pending &&
          !isEmptySnapshot(pending) &&
          loadedRef.current &&
          !suspendedRef.current &&
          identityUnchanged() && // never write a draft under a different identity
          keyOf(pending) !== syncedKeyRef.current
        ) {
          // Read now: the next slot's effect resets revisionRef synchronously right after this cleanup.
          const baseRevision = revisionRef.current;
          void Promise.resolve()
            .then(() =>
              client.PUT(DRAFT_PATH, {
                params: { path: { id: channelId } },
                body: {
                  body: pending.body,
                  references: toWire(pending.references),
                  ...sbarField(pending),
                  deviceId: deviceId(),
                  baseRevision,
                  ...(parentMessageId ? { parentMessageId } : {}),
                },
              }),
            )
            .catch(() => undefined);
        }
      }
    };
  }, [channelId, parentMessageId, readServer, save, identityUnchanged, markSynced]);

  /** (Re)arm the quiet-period save for whatever the composer holds now. */
  const schedule = useCallback((): void => {
    const generation = generationRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (suspendedRef.current) return;
    const snapshot = latestRef.current;
    if (isEmptySnapshot(snapshot)) {
      void save(snapshot, generation);
      return;
    }
    if (keyOf(snapshot) === syncedKeyRef.current) return;
    pendingRef.current = snapshot;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      pendingRef.current = null;
      if (suspendedRef.current || !identityUnchanged()) return;
      void save(latestRef.current, generation);
    }, DRAFT_SAVE_DEBOUNCE_MS);
  }, [save, identityUnchanged]);
  scheduleRef.current = schedule;

  // Local change: empty -> discard now; otherwise save after a quiet period.
  // `references` is not read in the body but a change in it (same text) must still schedule a save.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!loadedRef.current && !text && !sbarKey) return;
    failuresRef.current = 0; // new typing re-arms a save that gave up
    setSaveGaveUp(false);
    const open = conflictRef.current;
    if (open) {
      if (isEmptySnapshot(latestRef.current)) {
        // The composer was emptied (a send, or cleared) while the prompt was open: nothing is left to merge. Drop the
        // prompt and discard the server copy rather than ever re-saving the text that is gone.
        conflictRef.current = null;
        setConflict(null);
        revisionRef.current = open.server.revision;
        markSynced(null);
      } else {
        // The prompt is not modal: keep "mine" the text that is in the composer now.
        const next = { ...open, mine: latestRef.current };
        conflictRef.current = next;
        setConflict(next);
        return; // the user is choosing; do not race the prompt
      }
    }
    schedule();
  }, [text, references, sbarKey, schedule, suspended]);

  const resolve = useCallback(
    (choice: DraftResolution): void => {
      const current = conflictRef.current;
      if (!current) return;
      conflictRef.current = null;
      setConflict(null);
      revisionRef.current = current.server.revision;
      const generation = generationRef.current;
      if (choice === "theirs") {
        markSynced(keyOf(current.server));
        hydrateRef.current(
          current.server.body,
          [...current.server.references],
          current.server.sbar ?? null,
        );
        return;
      }
      const mine = latestRef.current;
      if (isEmptySnapshot(mine)) return; // nothing of mine left: the change effect already discards
      const chosen = choice === "both" ? mergeDraftBodies(mine, current.server) : mine;
      const chosenSbar = chosen.sbar ?? null;
      if (choice === "both") hydrateRef.current(chosen.body, [...chosen.references], chosenSbar);
      markSynced(null);
      // While a send is in flight nothing is saved; the change effect schedules it if the send fails.
      if (!suspendedRef.current)
        void save(
          { body: chosen.body, references: chosen.references, sbar: chosenSbar },
          generation,
        );
    },
    [save, markSynced],
  );

  const sbarSaved = sbarKey !== "" && syncedKey === keyOf({ body: text, references, sbar });
  return { conflict, saveFailed, saveGaveUp, sbarSaved, resolve };
}
