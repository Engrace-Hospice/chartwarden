// apps/web/src/modules/08-encounters/findings — the lifecycle both findings panels share: load the stored record once, then save the
// whole form on demand.
//
// WHAT THIS KEEPS TRUE
//   - A failed load is a state of its own (`phase: "failed"`), never an empty record: the panel offers "Try again" and no Save, because a
//     form opened blank over a record that exists would, on Save, replace it with nothing (a PUT replaces the whole record).
//   - `locked` (the sentence that says why) turns on when the server says the note will not take this record (signed, finalized, or no
//     section for it) and stays on: the form is read-only.
//   - A save carries the version the form was loaded from as `If-Match`. A 409 STALE_VERSION sets `stale`: the record moved since, the
//     author's input stays on screen untouched, and `retry` (reload) is how they choose to pick up the current record instead.
//   - An answer that lands after the panel is gone sets no state, but a save that LANDED still calls `onSaved`, so the note's preview is
//     refreshed even when the panel was unmounted mid-save.
//   - Another encounter starts clean: the lock, the saving flag and the last save's feedback belong to one visit's record.
import { type ApiClient, useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WriteResult } from "../encounters-api";
import { useIsMounted } from "../use-is-mounted";
import { LOCKING_CODES, STALE_VERSION } from "./findings-api";

export type FindingsLoaded<V> =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly message: string }
  | { readonly phase: "ready"; readonly record: V | null };

interface SaveFeedback {
  readonly saved: boolean;
  readonly failure: string | null;
}

const NO_FEEDBACK: SaveFeedback = { saved: false, failure: null };

export interface FindingsRecordArgs<V extends { readonly version: number }, B> {
  readonly encounterId: string;
  /** Module-level functions, so their identity is stable and a render never reloads the record. */
  readonly load: (client: ApiClient, encounterId: string) => Promise<WriteResult<V | null>>;
  readonly save: (
    client: ApiClient,
    encounterId: string,
    body: B,
    version: number,
  ) => Promise<WriteResult<V>>;
  readonly onSaved: () => void;
}

export interface FindingsRecord<V, B> {
  readonly loaded: FindingsLoaded<V>;
  /** The note will not take this record: the sentence that says why, or null while it will. */
  readonly locked: string | null;
  /** The last save was refused because the stored record moved since the form was loaded. */
  readonly stale: boolean;
  readonly saving: boolean;
  /** The last save landed and nothing has been edited since. */
  readonly saved: boolean;
  readonly failure: string | null;
  /** Read the record again (after a failed load, or to pick up one that moved): the form starts over from what is stored. */
  readonly retry: () => void;
  /** Resolves true when the save landed. */
  readonly save: (body: B) => Promise<boolean>;
  /** The form changed: the last save's confirmation or refusal is about an earlier version of it. */
  readonly dismiss: () => void;
}

export function useFindingsRecord<V extends { readonly version: number }, B>({
  encounterId,
  load,
  save,
  onSaved,
}: FindingsRecordArgs<V, B>): FindingsRecord<V, B> {
  const client = useApiClient();
  const mounted = useIsMounted();
  const [loaded, setLoaded] = useState<FindingsLoaded<V>>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [locked, setLocked] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<SaveFeedback>(NO_FEEDBACK);
  // State that belongs to one visit's record is dropped when the visit changes (set during render: no frame shows the old visit's lock).
  const [scope, setScope] = useState(encounterId);
  if (scope !== encounterId) {
    setScope(encounterId);
    setLocked(null);
    setStale(false);
    setSaving(false);
    setFeedback(NO_FEEDBACK);
  }
  // Read by the save that is in flight when an answer lands: the visit it is for and the version the form was loaded from (or last
  // saved as), which is what a save asks the server to still hold (0 is "nothing stored yet"). Written in effects, not in render.
  const currentEncounter = useRef(encounterId);
  const loadedVersion = useRef(0);
  useEffect(() => {
    currentEncounter.current = encounterId;
  }, [encounterId]);
  useEffect(() => {
    loadedVersion.current = loaded.phase === "ready" ? (loaded.record?.version ?? 0) : 0;
  }, [loaded]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the load on "Try again".
  useEffect(() => {
    let active = true;
    setLoaded({ phase: "loading" });
    void load(client, encounterId).then((result) => {
      if (!active) return;
      setLoaded(
        result.ok
          ? { phase: "ready", record: result.value }
          : { phase: "failed", message: result.message },
      );
    });
    return () => {
      active = false;
    };
  }, [client, encounterId, load, attempt]);

  const retry = useCallback(() => {
    setFeedback(NO_FEEDBACK);
    setStale(false);
    setAttempt((count) => count + 1);
  }, []);

  const dismiss = useCallback(() => setFeedback(NO_FEEDBACK), []);

  const submit = useCallback(
    async (body: B): Promise<boolean> => {
      setSaving(true);
      setFeedback(NO_FEEDBACK);
      const result = await save(client, encounterId, body, loadedVersion.current);
      if (mounted.current && currentEncounter.current === encounterId) {
        setSaving(false);
        if (result.ok) {
          setLoaded({ phase: "ready", record: result.value });
          setFeedback({ saved: true, failure: null });
        } else {
          if (result.code !== null && LOCKING_CODES.has(result.code)) setLocked(result.message);
          if (result.code === STALE_VERSION) setStale(true);
          setFeedback({ saved: false, failure: result.message });
        }
      }
      if (result.ok) onSaved();
      return result.ok;
    },
    [client, encounterId, mounted, onSaved, save],
  );

  return {
    loaded,
    locked,
    stale,
    saving,
    saved: feedback.saved,
    failure: feedback.failure,
    retry,
    save: submit,
    dismiss,
  };
}
