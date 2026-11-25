// apps/web/src/modules/08-encounters/compose — how the composer keeps the note's text in step with the server: read what is stored, show it,
// and re-read it when a panel saved something the note states (moved out of encounter-compose.tsx unchanged).
import type { ApiClient } from "@chartwarden/ui";
import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback } from "react";
import { type SelectionsView, loadSelections } from "../encounters-api";
import type { RecordedPanelKind } from "../recorded-panels";
import { DRAFT_SOURCE_PANELS } from "./compose-model";

export interface PreviewSyncInput {
  readonly client: ApiClient;
  readonly encounterId: string | undefined;
  /** Counts loads: a read that answers after another note (or a reload) started must not be shown. */
  readonly loadSequence: MutableRefObject<number>;
  /** The newest re-read of the note's text: an older one answering late must not overwrite what a newer read or a save put on screen. */
  readonly previewRead: MutableRefObject<number>;
  readonly setPreview: Dispatch<SetStateAction<string>>;
  readonly setEditedNarrative: Dispatch<SetStateAction<string | null>>;
  readonly setEditStale: Dispatch<SetStateAction<boolean>>;
  readonly setPreviewStale: Dispatch<SetStateAction<boolean>>;
  /** Re-reads the draft (its text, hash and state). */
  readonly reloadDraft: () => Promise<unknown>;
}

export interface PreviewSync {
  readonly readStored: () => Promise<SelectionsView | null>;
  readonly applyStored: (stored: SelectionsView) => void;
  readonly refreshPreview: () => Promise<void>;
  readonly refreshFromPanel: (panel: RecordedPanelKind) => void;
}

export function usePreviewSync({
  client,
  encounterId,
  loadSequence,
  previewRead,
  setPreview,
  setEditedNarrative,
  setEditStale,
  setPreviewStale,
  reloadDraft,
}: PreviewSyncInput): PreviewSync {
  /** The stored note, or null when it could not be read (a refusal or a dropped connection). */
  const readStored = useCallback(async (): Promise<SelectionsView | null> => {
    if (!encounterId) return null;
    try {
      return await loadSelections(client, encounterId);
    } catch {
      return null;
    }
  }, [client, encounterId]);

  /** What the server holds for the note's text: the generated preview and the author's edit of it, if any. */
  const applyStored = useCallback(
    (stored: SelectionsView): void => {
      setPreview(stored.layer1Preview);
      setEditedNarrative(stored.editedNarrative ?? null);
      setEditStale(stored.editedNarrativeStale === true);
      setPreviewStale(false);
    },
    [setPreview, setEditedNarrative, setEditStale, setPreviewStale],
  );

  /**
   * Re-read the server-assembled note without touching the author's working draft. Vitals are recorded
   * apart from the selections and the note states them, so the preview is stale the moment they save. The
   * preview shows what is stored; unsaved edits still need a save, exactly as before.
   */
  const refreshPreview = useCallback(async (): Promise<void> => {
    // The load this read belongs to (another note, or a reload, starts a newer one) and the read itself (a newer read or a save puts
    // newer text on screen): an answer for an older one must not overwrite it.
    const sequence = loadSequence.current;
    const read = ++previewRead.current;
    const stored = await readStored();
    if (sequence !== loadSequence.current || read !== previewRead.current) return;
    if (stored === null) {
      setPreviewStale(true);
      return;
    }
    applyStored(stored);
  }, [applyStored, readStored, loadSequence, previewRead, setPreviewStale]);
  // The panels' "something they state was saved": stable, so the memoised panels are not re-rendered by a keystroke in the free text.
  // A saved ADL record is a source of the draft (the aide's recorded ADLs lead the drafted `adl` section), so the draft is re-read too:
  // the text, its hash and its state must be the ones the author is about to confirm. The nutrition and wound records are not a source of
  // any drafted section, so saving them re-reads the preview alone (a draft read is a full recompute and a patient-attributed audit row).
  const refreshFromPanel = useCallback(
    (panel: RecordedPanelKind): void => {
      void refreshPreview();
      if (DRAFT_SOURCE_PANELS.has(panel)) void reloadDraft();
    },
    [refreshPreview, reloadDraft],
  );

  return { readStored, applyStored, refreshPreview, refreshFromPanel };
}
