// apps/web/src/modules/08-encounters — the sections an amending addendum names, each with its redrafted text and the two choices a clinician
// has (ADR-0114 VN-D30, S1 PR E3). Spec: docs/design/screens/clinical/CHARTWARDEN_UI_ENCOUNTER_VISIT_DOCUMENTATION.md "Amending a signed note".
//
// The text and every state are the addendum's OWN draft (its own resolutions, never the note's), read by `useNoteDraft(..., addendumId)`;
// this is the note's drafted-section panel and hook, not a copy of them. Confirmed, the section is amended when the addendum signs;
// deselected (or nothing to redraft), it amends nothing and stays as signed: each section says which. The hook's owner (the addendum row)
// also holds the Sign button back while a section is unresolved, so this only shows the state.
import { Button, InlineAlert } from "@chartwarden/ui";
import type { JSX } from "react";
import { amendedSectionNote } from "./amendment-model";
import { DraftSectionPanel } from "./draft-section-panel";
import { humanizeSection } from "./sign-draft-notice";
import type { NoteDraft } from "./use-note-draft";

const OFF_TEXT =
  "The visit-note draft is switched off for your organization, or your role does not include reading it, so the amended sections cannot be shown here. Signing is still checked by the server.";
const UNAVAILABLE_TEXT = "The amended sections could not be read. Nothing was changed.";

export interface AmendmentReviewProps {
  readonly addendumId: string;
  /** The sections the addendum names, in the order the clinician chose them. */
  readonly sectionIds: readonly string[];
  readonly draft: NoteDraft;
}

export function AmendmentReview({
  addendumId,
  sectionIds,
  draft,
}: AmendmentReviewProps): JSX.Element {
  const { load, notes, busySectionId, refreshing } = draft;
  const idPrefix = `amend-${addendumId}`;

  const body = (() => {
    switch (load.status) {
      case "loading":
        return <p className="wx-row-sub">Reading the amended sections…</p>;
      case "off":
        return <InlineAlert tone="info">{OFF_TEXT}</InlineAlert>;
      case "unavailable":
        return (
          <>
            <InlineAlert tone="warning">{UNAVAILABLE_TEXT}</InlineAlert>
            <div>
              <Button
                tone="secondary"
                size="sm"
                loading={refreshing}
                onClick={() => void draft.reload()}
              >
                Try again
              </Button>
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
                      label={`${name}: redrafted from the record`}
                      section={section}
                      note={notes[sectionId] ?? amendedSectionNote(section.state)}
                      busy={busySectionId === sectionId}
                      blockedReason={blockedReasonOf(busySectionId, refreshing, sectionId)}
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
    <section className="wx-amend" aria-label="Amended sections">
      {body}
    </section>
  );
}

function blockedReasonOf(
  busySectionId: string | null,
  refreshing: boolean,
  sectionId: string,
): string | null {
  if (refreshing) return "Updating the drafted text. Confirm or deselect it once it has loaded.";
  if (busySectionId !== null && busySectionId !== sectionId) {
    return "Another section is being recorded. Wait for it to finish.";
  }
  return null;
}
