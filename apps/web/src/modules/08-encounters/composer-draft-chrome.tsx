// apps/web/src/modules/08-encounters — the composer's drafted-section chrome: the strip above the workspace (the draft could not be read, or
// how many drafted sections are resolved) and the right rail (scores and care-plan links) (ADR-0114 VN-D7, VN-D15, S1 PR D).
// Moved out of encounter-compose.tsx unchanged.
import type { JSX } from "react";
import { ComposerCarePlanPicker } from "./composer-care-plan-picker";
import { ComposerScoreTrend } from "./composer-score-trend";
import type { DraftView, PickerEncounter } from "./draft-api";
import { DraftSummary, DraftUnavailable } from "./draft-summary";
import type { NoteDraft } from "./use-note-draft";

export interface ComposerDraftStripProps {
  readonly noteDraft: NoteDraft;
  /** The draft while some of it still needs the clinician (see `useComposerDraft`), else null. */
  readonly pending: DraftView | null;
  readonly headingOf: (sectionId: string) => string;
  readonly onOpenSection: (sectionId: string) => void;
  /** The gate's last refusal about drafted sections, in words, else null. */
  readonly refusal: string | null;
}

export function ComposerDraftStrip({
  noteDraft,
  pending,
  headingOf,
  onOpenSection,
  refusal,
}: ComposerDraftStripProps): JSX.Element {
  return (
    <>
      {noteDraft.load.status === "unavailable" ? (
        <DraftUnavailable retrying={noteDraft.refreshing} onRetry={() => void noteDraft.reload()} />
      ) : null}
      {pending ? (
        <DraftSummary
          draft={pending}
          headingOf={headingOf}
          onOpenSection={onOpenSection}
          refusal={refusal}
        />
      ) : null}
    </>
  );
}

export interface ComposerDraftRailProps {
  readonly encounter: PickerEncounter & { readonly serviceDate: string };
  readonly editable: boolean;
  /** The draft, which names the visit time the scores are read up to. */
  readonly drafted: DraftView;
  readonly carePlanRevision: number;
  readonly onLinksChanged: () => void;
}

export function ComposerDraftRail({
  encounter,
  editable,
  drafted,
  carePlanRevision,
  onLinksChanged,
}: ComposerDraftRailProps): JSX.Element {
  return (
    <div className="wx-draft-rail">
      <ComposerScoreTrend
        patientId={encounter.patientId}
        serviceDate={encounter.serviceDate}
        visitTime={drafted.asOf}
      />
      <ComposerCarePlanPicker
        encounter={encounter}
        editable={editable}
        revision={carePlanRevision}
        onChanged={onLinksChanged}
      />
    </div>
  );
}
