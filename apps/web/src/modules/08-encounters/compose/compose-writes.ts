// apps/web/src/modules/08-encounters/compose — what the composer's buttons do to the server: start and apply an edit of the note text, save
// the draft, and finalize the note (moved out of encounter-compose.tsx). The server decides every refusal; this words it
// and keeps the screen in step with what the server now holds.
// Not a hook: called each render, like the closures it replaces, so each write sees the draft, version and saved baseline of the render
// that made it.
import type { ApiClient } from "@chartwarden/ui";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { type UiFeedback, feedbackFor, transportFeedback } from "../compose-feedback";
import { gateRefusalWords } from "../compose-gate-refusal";
import {
  type DraftSections,
  type EncounterView,
  type SelectionsView,
  currentNoteText,
  finalizeEncounter,
  saveSelections,
  toSelectionsBody,
} from "../encounters-api";
import { lateEntryApprovalNote } from "../late-entry-reason";
import type { LateEntryReasonState } from "../use-late-entry-reason";
import { type ComposeOperation, type PanelKey, unsavedPanelsFeedback } from "./compose-model";

type Setter<T> = Dispatch<SetStateAction<T>>;

export interface ComposeWritesContext {
  readonly client: ApiClient;
  readonly encounterId: string | undefined;
  readonly version: number;
  readonly draft: DraftSections;
  /** The fall the note links, only while its reason is the follow-up after a fall. */
  readonly effectiveFallId: string | null;
  /** The working draft as it would be saved. */
  readonly currentDraft: string;
  readonly editedNarrative: string | null;
  readonly selectionsDirty: boolean;
  /** The parts of the note whose own form holds unsaved input: finalizing would drop it. */
  readonly dirtyPanels: readonly PanelKey[];
  readonly panelTitle: (key: PanelKey) => string;
  readonly showPanel: (key: PanelKey) => void;
  readonly headingOfSection: (sectionId: string) => string;
  readonly lateEntry: LateEntryReasonState;
  /** Counts re-reads and saves of the note's text, so an older answer arriving late is dropped. */
  readonly previewRead: MutableRefObject<number>;
  readonly readStored: () => Promise<SelectionsView | null>;
  readonly applyStored: (stored: SelectionsView) => void;
  readonly refreshPreview: () => Promise<void>;
  /** Re-reads the draft (its text, hash and state). */
  readonly reloadDraft: () => Promise<unknown>;
  readonly refuse: (text: string | null) => void;
  /** Reloads the whole note; resolves to the note, or null when it could not be read. */
  readonly load: () => Promise<EncounterView | null>;
  readonly setFeedback: Setter<UiFeedback | null>;
  readonly setOperation: Setter<ComposeOperation | null>;
  readonly setError: Setter<string | null>;
  readonly setVersion: Setter<number>;
  readonly setPreview: Setter<string>;
  readonly setPreviewStale: Setter<boolean>;
  readonly setLastSavedDraft: Setter<string>;
  readonly setEditing: Setter<boolean>;
  readonly setEditText: Setter<string>;
}

export interface ComposeWrites {
  readonly startEdit: () => Promise<void>;
  readonly writeEdit: (next: string | null) => Promise<void>;
  readonly save: () => Promise<boolean>;
  readonly finalize: () => Promise<void>;
}

export function createComposeWrites({
  client,
  encounterId,
  version,
  draft,
  effectiveFallId,
  currentDraft,
  editedNarrative,
  selectionsDirty,
  dirtyPanels,
  panelTitle,
  showPanel,
  headingOfSection,
  lateEntry,
  previewRead,
  readStored,
  applyStored,
  refreshPreview,
  reloadDraft,
  refuse,
  load,
  setFeedback,
  setOperation,
  setError,
  setVersion,
  setPreview,
  setPreviewStale,
  setLastSavedDraft,
  setEditing,
  setEditText,
}: ComposeWritesContext): ComposeWrites {
  /** Edit the note text. Unsaved selections are saved first, so the text being edited is the note as it now reads. */
  async function startEdit(): Promise<void> {
    if (!encounterId) return;
    if (selectionsDirty && !(await save())) return;
    const stored = await readStored();
    if (!stored) {
      setFeedback(transportFeedback);
      return;
    }
    previewRead.current += 1;
    applyStored(stored);
    setEditText(currentNoteText(stored));
    setEditing(true);
  }

  /** Apply (text) or discard (null) the author's edit of the note text, then show the note as the server now holds it. */
  async function writeEdit(next: string | null): Promise<void> {
    if (!encounterId) return;
    setOperation("saving");
    setFeedback(null);
    try {
      const res = await saveSelections(
        client,
        encounterId,
        version,
        toSelectionsBody(draft, effectiveFallId, next),
      );
      if (!res.ok) {
        setFeedback(feedbackFor(res));
        return;
      }
      setVersion(res.value.version);
      setLastSavedDraft(currentDraft);
      setEditing(false);
      await refreshPreview();
      setFeedback({
        tone: "success",
        title: next === null ? "Edit discarded" : "Note text updated",
        message:
          next === null
            ? "The note reads as generated from your selections."
            : "Your edited text is what will be signed. The generated text is kept beside it.",
      });
    } catch {
      setFeedback(transportFeedback);
    } finally {
      setOperation(null);
    }
  }

  async function save(): Promise<boolean> {
    if (!encounterId) return false;

    setOperation("saving");
    setFeedback(null);

    try {
      const res = await saveSelections(
        client,
        encounterId,
        version,
        toSelectionsBody(draft, effectiveFallId),
      );

      if (!res.ok) {
        setFeedback(feedbackFor(res));
        return false;
      }

      setVersion(res.value.version);
      setPreview(res.value.layer1Preview);
      previewRead.current += 1;
      setPreviewStale(false);
      setLastSavedDraft(currentDraft);
      // A save changes the clinician's own words inside a drafted section, so its text, hash and state are re-read.
      void reloadDraft();
      // A saved edit may have gone stale under what was just saved; the server decides.
      if (editedNarrative !== null) await refreshPreview();
      setFeedback({
        tone: "success",
        title: "Draft saved",
        message: "Your visit note changes were saved.",
      });
      return true;
    } catch {
      setFeedback(transportFeedback);
      return false;
    } finally {
      setOperation(null);
    }
  }

  async function finalize(): Promise<void> {
    if (!encounterId) return;
    // Finalizing reloads the note, which would drop what a panel holds unsaved: say so instead of losing it silently.
    if (dirtyPanels.length > 0) {
      setFeedback(unsavedPanelsFeedback(dirtyPanels.map(panelTitle)));
      showPanel(dirtyPanels[0] as PanelKey);
      return;
    }

    setOperation("finalizing");
    setFeedback(null);
    let finalizationAttempted = false;

    try {
      const saved = await saveSelections(
        client,
        encounterId,
        version,
        toSelectionsBody(draft, effectiveFallId),
      );

      if (!saved.ok) {
        setFeedback(feedbackFor(saved));
        return;
      }

      setVersion(saved.value.version);
      setPreview(saved.value.layer1Preview);
      previewRead.current += 1;
      setPreviewStale(false);
      setLastSavedDraft(currentDraft);

      finalizationAttempted = true;
      const res = await finalizeEncounter(client, encounterId, lateEntry.reasonForFinalize);

      if (!res.ok) {
        // The save changed what the draft is built from and the gate may have named drafted sections: one re-read shows what the
        // server holds now, whatever the refusal. (A finalize that succeeds reloads the whole note below, and the draft with it.)
        void reloadDraft();
        // A missing or short late-entry reason is answered by the reason box (focused), not by the server's sentence.
        if (lateEntry.absorbRefusal(res)) return;
        const gate = gateRefusalWords(res.details, headingOfSection);
        if (gate) {
          // The gate named drafted sections: say which and why, beside the draft strip.
          refuse(gate.refusal);
          setFeedback(gate.feedback);
          return;
        }
        setFeedback(feedbackFor(res));
        return;
      }

      setFeedback({
        tone: "success",
        title: "Note finalized",
        message: ["Sign it from the encounter record.", lateEntryApprovalNote(lateEntry.estimate)]
          .filter(Boolean)
          .join(" "),
      });
      lateEntry.clear();
      const reloaded = await load();
      if (!reloaded) {
        setError(
          "The note was finalized, but the updated record could not be reloaded. Return to the encounter record or refresh before continuing.",
        );
      }
    } catch {
      if (!finalizationAttempted) {
        setFeedback(transportFeedback);
        return;
      }

      const reconciled = await load();
      if (!reconciled) {
        setError(
          "Finalization status could not be confirmed. Return to the encounter record or refresh before continuing.",
        );
      } else if (reconciled.status === "draft") {
        setFeedback({
          tone: "warning",
          title: "Finalization not completed",
          message: "Your draft was saved, but finalization was not completed. You can try again.",
        });
      } else {
        // Finalized: nothing keeps a copy of the typed reason, as on the success path above.
        lateEntry.clear();
        setFeedback({
          tone: "success",
          title: "Note finalized",
          message: "The server confirmed finalization after the connection was interrupted.",
        });
      }
    } finally {
      setOperation(null);
    }
  }

  return { startEdit, writeEdit, save, finalize };
}
