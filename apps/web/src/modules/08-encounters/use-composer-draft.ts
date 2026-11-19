// apps/web/src/modules/08-encounters — what the visit-note composer derives from the draft of the note it is open on (ADR-0114): which
// draft the panel, rail and care-plan picker are built from, which drafted section the open section's panel shows, why that panel may
// not act right now, and the care-plan picker's re-read trigger. The draft itself (loading, resolving, ordering) is `useNoteDraft`.
import { useCallback, useState } from "react";
import type { DraftSectionView, DraftView, Resolution } from "./draft-api";
import { draftIsActive, touchesCarePlan } from "./draft-model";
import { stateLabel } from "./encounter-status";
import { type NoteDraft, useNoteDraft } from "./use-note-draft";

export interface ComposerDraftInput {
  /** Undefined until the composer knows its encounter. */
  readonly encounterId: string | undefined;
  readonly encounterStatus: string | undefined;
  /** The section open in the editor. */
  readonly activeSectionId: string | undefined;
  /** The composer is saving or finalizing. */
  readonly saving: boolean;
  /** The clinician has edits that are not saved. */
  readonly dirty: boolean;
}

export interface ComposerDraft {
  readonly noteDraft: NoteDraft;
  /**
   * The draft the section panel, the rail and the care-plan picker are built from. Null while nothing has been drafted for this
   * encounter, and then KEPT for the encounter, even if the clinician deselects the last drafted section: the panel that says what
   * just happened, its live region and the picker the note points at must not vanish under the person who acted.
   */
  readonly drafted: DraftView | null;
  /** The draft the strip counts, only while at least one section is still drafted. */
  readonly pending: DraftView | null;
  /** The drafted section for the open section (an empty one says it has nothing to draft). */
  readonly panelSection: DraftSectionView | undefined;
  /** Why the open section's panel cannot confirm or deselect now, else null. */
  readonly blockedReason: string | null;
  /** Bumped when a resolve changed the visit's care-plan links, so the picker re-reads them. */
  readonly carePlanRevision: number;
  /** The server's last refusal about drafted sections, in words (a finalize 422), else null. */
  readonly refusal: string | null;
  readonly refuse: (text: string | null) => void;
  readonly resolveSection: (section: DraftSectionView, resolution: Resolution) => Promise<boolean>;
}

interface BlockInput {
  readonly status: string | undefined;
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly refreshing: boolean;
  readonly busySectionId: string | null;
  readonly sectionId: string | undefined;
}

function blockedReasonFor({
  status,
  saving,
  dirty,
  refreshing,
  busySectionId,
  sectionId,
}: BlockInput): string | null {
  if (status !== undefined && status !== "draft" && status !== "finalized") {
    return `This note is ${stateLabel(status).toLowerCase()}, so its drafted sections can no longer be changed.`;
  }
  if (saving) return "Wait for the save to finish.";
  if (dirty) {
    return "You have unsaved changes. Save the draft first, so what you confirm is what you will sign.";
  }
  if (refreshing) {
    return "Updating the drafted text. Confirm or deselect it once it has loaded.";
  }
  if (busySectionId !== null && busySectionId !== sectionId) {
    return "Another section is being recorded. Wait for it to finish.";
  }
  return null;
}

export function useComposerDraft({
  encounterId,
  encounterStatus,
  activeSectionId,
  saving,
  dirty,
}: ComposerDraftInput): ComposerDraft {
  const noteDraft = useNoteDraft(encounterId, encounterStatus);
  const [carePlanRevision, setCarePlanRevision] = useState(0);
  const [refusal, refuse] = useState<string | null>(null);

  // "Something was drafted here" is remembered for the encounter it was seen on, and forgotten with a change of encounter. It is
  // derived while rendering (the encounter it was seen on is state), so the render that shows the emptied section already has it.
  const [seenOn, setSeenOn] = useState<string | undefined>(undefined);
  const draftNow = noteDraft.load.status === "ready" ? noteDraft.load.draft : null;
  const seenNow = encounterId !== undefined && (draftIsActive(draftNow) || seenOn === encounterId);
  const nextSeenOn = seenNow ? encounterId : undefined;
  if (nextSeenOn !== seenOn) setSeenOn(nextSeenOn);

  const drafted = seenNow ? draftNow : null;
  const pending = drafted !== null && draftIsActive(drafted) ? drafted : null;
  const panelSection = drafted?.sections.find((section) => section.sectionId === activeSectionId);
  const blockedReason = blockedReasonFor({
    status: encounterStatus,
    saving,
    dirty,
    refreshing: noteDraft.refreshing,
    busySectionId: noteDraft.busySectionId,
    sectionId: panelSection?.sectionId,
  });

  const { resolve } = noteDraft;
  const resolveSection = useCallback(
    async (section: DraftSectionView, resolution: Resolution): Promise<boolean> => {
      refuse(null);
      const recorded = await resolve(section, resolution);
      if (recorded && touchesCarePlan(section)) setCarePlanRevision((revision) => revision + 1);
      return recorded;
    },
    [resolve],
  );

  return {
    noteDraft,
    drafted,
    pending,
    panelSection,
    blockedReason,
    carePlanRevision,
    refusal,
    refuse,
    resolveSection,
  };
}
