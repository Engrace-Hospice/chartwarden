// apps/web/src/modules/08-encounters — the composer's one-line answer to "what is still between me and signing" for a drafted note
// (ADR-0114 VN-D7): how many drafted sections are resolved and which ones are not, each a button that opens that section. When the
// server refused a finalize or a sign for specific sections, they are named here in words. The strip is flat (no card): it sits between the
// required-documentation line and the workspace and takes no room at all when nothing is drafted (the caller does not render it).
// The same strip says so when the draft could not be read, with the retry: a note whose draft is unknown cannot be finalized.
import { Button, InlineAlert } from "@chartwarden/ui";
import type { JSX, ReactNode } from "react";
import type { DraftView } from "./draft-api";
import { STATE_LABEL, reviewCounts } from "./draft-model";

function DraftStrip({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <section className="wx-draft-summary" aria-label="Drafted sections">
      {children}
    </section>
  );
}

export interface DraftUnavailableProps {
  /** A re-read is in flight: the retry shows it is working and does not send a second one. */
  readonly retrying: boolean;
  readonly onRetry: () => void;
}

export function DraftUnavailable({ retrying, onRetry }: DraftUnavailableProps): JSX.Element {
  return (
    <DraftStrip>
      <InlineAlert tone="warning">
        The pre-drafted text could not be loaded. Your own documentation is not affected, but the
        note cannot be finalized until the draft can be read.
      </InlineAlert>
      <div>
        <Button tone="secondary" size="sm" loading={retrying} onClick={onRetry}>
          Try again
        </Button>
      </div>
    </DraftStrip>
  );
}

export interface DraftSummaryProps {
  readonly draft: DraftView;
  readonly headingOf: (sectionId: string) => string;
  readonly onOpenSection: (sectionId: string) => void;
  /** The server's last refusal about drafted sections, already in words (finalize 422 or sign 409), else null. */
  readonly refusal: string | null;
}

export function DraftSummary({
  draft,
  headingOf,
  onOpenSection,
  refusal,
}: DraftSummaryProps): JSX.Element {
  const { drafted, resolved, needReview } = reviewCounts(draft);
  return (
    <DraftStrip>
      <p className="wx-draft-summary-line">
        <strong>
          {resolved} of {drafted}
        </strong>{" "}
        drafted {drafted === 1 ? "section is" : "sections are"} resolved.{" "}
        {needReview.length === 0
          ? "Nothing in the draft is holding up the note."
          : "Signing stays blocked until the rest are confirmed or deselected."}
      </p>
      {needReview.length > 0 ? (
        <ul className="wx-draft-todo">
          {needReview.map((section) => (
            <li key={section.sectionId}>
              <Button tone="tertiary" size="sm" onClick={() => onOpenSection(section.sectionId)}>
                {headingOf(section.sectionId)}
              </Button>
              <span className="wx-row-sub">{STATE_LABEL[section.state]}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {refusal ? <InlineAlert tone="error">{refusal}</InlineAlert> : null}
    </DraftStrip>
  );
}
