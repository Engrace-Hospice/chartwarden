// apps/web/src/modules/08-encounters — the sections an amending addendum names, each with its redrafted text and the two choices a clinician
// has (ADR-0114 VN-D30, S1 PR E3). Spec: docs/design/screens/clinical/CHARTWARDEN_UI_ENCOUNTER_VISIT_DOCUMENTATION.md "Amending a signed note".
//
// The text and every state are the addendum's OWN draft (its own resolutions, never the note's), read by `useNoteDraft(..., addendumId)`;
// this is the note's drafted-section panel and hook, not a copy of them. Confirmed, the section is amended when the addendum signs;
// deselected (or nothing to redraft), it amends nothing and stays as signed: each section says which. The hook's owner (the addendum row)
// also holds the Sign button back while a section is unresolved, so this only shows the state.
import { InlineAlert } from "@chartwarden/ui";
import type { JSX } from "react";
import { amendedSectionNote } from "./amendment-model";
import { DraftSectionPanel } from "./draft-section-panel";
import { RetryButton } from "./retry-button";
import { humanizeSection } from "./sign-draft-notice";
import { useDraftRetry } from "./use-draft-retry";
import type { NoteDraft } from "./use-note-draft";

const OFF_TEXT =
  "The visit-note draft is switched off for your organization, or your role does not include reading it, so the amended sections cannot be shown here. Signing is still checked by the server.";
const UNAVAILABLE_TEXT = "The amended sections could not be read. Nothing was changed.";
// The addendum's draft is its author's alone. Worded here, in the app's words: the server's text for the refusal is never shown.
const NOT_AUTHOR_TEXT =
  "Only the author of this addendum can review the sections it amends. Nothing was changed. Ask the author to review and sign it, or open your own addendum.";

// The "closed" answers (the draft is off for this viewer, or is the author's alone) say so in the region's own alert.
const RETRY_WORDS = { ready: "The amended sections loaded.", closed: "" } as const;

export interface AmendmentReviewProps {
  readonly addendumId: string;
  /** `addendumName`: a note can carry several amendments of one section, and each landmark and heading names its own. */
  readonly addendumName: string;
  /** The sections the addendum names, in the order the clinician chose them. */
  readonly sectionIds: readonly string[];
  readonly draft: NoteDraft;
  /** Something else is being done to this addendum (it is being signed, and the page has not shown it signed yet): nothing is resolved now. */
  readonly locked?: boolean;
}

export function AmendmentReview({
  addendumId,
  addendumName,
  sectionIds,
  draft,
  locked = false,
}: AmendmentReviewProps): JSX.Element {
  const { load, notes, busySectionId, refreshing } = draft;
  const idPrefix = `amend-${addendumId}`;
  // The region stays on the page whatever the retry finds, so it is where focus goes and where the outcome is said.
  const { anchor, said, retry } = useDraftRetry<HTMLElement>(draft.reload, RETRY_WORDS);

  const body = (() => {
    switch (load.status) {
      case "loading":
        return <p className="wx-row-sub">Reading the amended sections…</p>;
      case "off":
        return <InlineAlert tone="info">{OFF_TEXT}</InlineAlert>;
      case "notAuthor":
        return <InlineAlert tone="info">{NOT_AUTHOR_TEXT}</InlineAlert>;
      case "unavailable":
        return (
          <>
            <InlineAlert tone="warning">{UNAVAILABLE_TEXT}</InlineAlert>
            <div>
              <RetryButton retrying={refreshing} onRetry={retry} />
            </div>
          </>
        );
      case "ready":
        return (
          <>
            {sectionIds.map((sectionId) => {
              const section = load.draft.sections.find((s) => s.sectionId === sectionId);
              const name = humanizeSection(sectionId);
              return (
                <div key={sectionId} className="wx-amend-section">
                  {section ? (
                    <DraftSectionPanel
                      idPrefix={idPrefix}
                      amending
                      label={`${name}: redrafted from the record (${addendumName})`}
                      section={section}
                      note={notes[sectionId] ?? amendedSectionNote(section.state)}
                      busy={busySectionId === sectionId}
                      blockedReason={blockedReasonOf(busySectionId, refreshing, locked, sectionId)}
                      onResolve={(resolution) => draft.resolve(section, resolution)}
                    />
                  ) : (
                    <p className="wx-row-sub">
                      {name} is not in the addendum's draft. Reload the page.
                    </p>
                  )}
                </div>
              );
            })}
          </>
        );
    }
  })();

  return (
    <section
      className="wx-amend"
      aria-label={`Amended sections, ${addendumName}`}
      ref={anchor}
      tabIndex={-1}
    >
      {body}
      {/* What a retry said is stale once the sections cannot be read again. */}
      <output className="wx-row-sub">{load.status === "unavailable" ? "" : said}</output>
    </section>
  );
}

function blockedReasonOf(
  busySectionId: string | null,
  refreshing: boolean,
  locked: boolean,
  sectionId: string,
): string | null {
  if (locked) return "This addendum is being updated. Wait for it to finish.";
  if (refreshing) return "Updating the drafted text. Confirm or deselect it once it has loaded.";
  if (busySectionId !== null && busySectionId !== sectionId) {
    return "Another section is being recorded. Wait for it to finish.";
  }
  return null;
}
