// apps/web/src/modules/08-encounters — the composer's drafted-section chrome: the strip above the workspace (the draft could not be read, or
// how many drafted sections are resolved) and the right rail (scores and care-plan links) (ADR-0114 VN-D7, VN-D15, S1 PR D).
// Moved out of encounter-compose.tsx unchanged.
import { useState } from "react";
import type { JSX } from "react";
import { ComposerCarePlanPicker } from "./composer-care-plan-picker";
import { ComposerDisciplinePlanPicker } from "./composer-discipline-plan-picker";
import { ComposerScoreTrend } from "./composer-score-trend";
import type { DraftView, PickerEncounter } from "./draft-api";
import { draftsFromDisciplinePlan, isDisciplinePlanVisit } from "./draft-model";
import { DraftStrip, DraftSummary, DraftUnavailable } from "./draft-summary";
import { useDraftRetry } from "./use-draft-retry";
import type { NoteDraft } from "./use-note-draft";

const RETRY_WORDS = {
  ready: "The pre-drafted text loaded.",
  closed: "The pre-drafted text is not available for this note.",
} as const;

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
}: ComposerDraftStripProps): JSX.Element | null {
  const { anchor, said, retry } = useDraftRetry<HTMLElement>(noteDraft.reload, RETRY_WORDS);
  const unavailable = noteDraft.load.status === "unavailable";
  // The strip takes no room when nothing is drafted, except while it holds what a retry just said (and the focus that retry left behind).
  if (!unavailable && !pending && said === "") return null;
  return (
    <DraftStrip retry={{ anchor, said: unavailable ? "" : said }}>
      {unavailable ? <DraftUnavailable retrying={noteDraft.refreshing} onRetry={retry} /> : null}
      {pending ? (
        <DraftSummary
          draft={pending}
          headingOf={headingOf}
          onOpenSection={onOpenSection}
          refusal={refusal}
        />
      ) : null}
    </DraftStrip>
  );
}

export interface ComposerDraftRailProps {
  readonly encounter: PickerEncounter & { readonly serviceDate: string };
  readonly editable: boolean;
  /**
   * The draft, which names the visit time the scores are read up to. Null when nothing is drafted: a social-work or chaplain visit still shows its
   * plan picker then (with every item left out nothing is drafted, and the items must stay reachable to be kept again, also after a reload);
   * any other visit shows no rail.
   */
  readonly drafted: DraftView | null;
  /**
   * The draft was read for this visit. A plan visit's list is mounted only then: with the tenant switch off (or no access) the draft answers 404 and so
   * would the list, and the composer stays exactly as it was, without a request or an empty frame.
   */
  readonly draftReady: boolean;
  readonly carePlanRevision: number;
  readonly onLinksChanged: () => void;
}

export function ComposerDraftRail({
  encounter,
  editable,
  drafted,
  draftReady,
  carePlanRevision,
  onLinksChanged,
}: ComposerDraftRailProps): JSX.Element | null {
  const planVisit = isDisciplinePlanVisit(encounter.discipline);
  // Once the draft was read, a later re-read that fails (after a change in the list) must not unmount the list under the box that was pressed.
  const [readFor, setReadFor] = useState<string | null>(null);
  if (draftReady && readFor !== encounter.id) setReadFor(encounter.id);
  const planList = planVisit && (draftReady || readFor === encounter.id);
  if (drafted === null && !planList) return null;
  return (
    <div className="wx-draft-rail">
      {drafted ? (
        <ComposerScoreTrend
          patientId={encounter.patientId}
          serviceDate={encounter.serviceDate}
          visitTime={drafted.asOf}
        />
      ) : null}
      {planList ? (
        <ComposerDisciplinePlanPicker
          encounterId={encounter.id}
          discipline={encounter.discipline}
          editable={editable}
          revision={carePlanRevision}
          onChanged={onLinksChanged}
        />
      ) : null}
      {drafted ? (
        <ComposerCarePlanPicker
          encounter={encounter}
          editable={editable}
          revision={carePlanRevision}
          onChanged={onLinksChanged}
          // A plan visit's sections keep its own plan's items (the picker above), never the care plan's, whatever the draft names.
          confirmationLinks={!planVisit && !draftsFromDisciplinePlan(drafted)}
        />
      ) : null}
    </div>
  );
}
