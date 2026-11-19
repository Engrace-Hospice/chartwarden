// apps/web/src/modules/08-encounters — the composer's one-line answer to "what is still between me and signing" for a drafted note
// (ADR-0114 VN-D7): how many drafted sections are resolved and which ones are not, each a button that opens that section. When the
// server refused a finalize or a sign for specific sections, they are named here in words. The strip is flat (no card): it sits between the
// required-documentation line and the workspace and takes no room at all when nothing is drafted (the caller does not render it).
// The same strip says so when the draft could not be read, with the retry: a note whose draft is unknown cannot be finalized. The strip's
// frame (`DraftStrip`) belongs to the composer's chrome, so the one element stays when the retry succeeds and can take focus.
import { Button, InlineAlert } from "@chartwarden/ui";
import type { JSX, ReactNode, RefObject } from "react";
import type { DraftView } from "./draft-api";
import { STATE_LABEL, reviewCounts } from "./draft-model";
import { RetryButton } from "./retry-button";

export interface DraftStripProps {
  readonly children: ReactNode;
  /**
   * Makes the strip something focus can be sent to (the retry that was pressed in it is about to go) and gives it a status that is always
   * on the page, filled with what the retry found: a region mounted with its text is not announced.
   */
  readonly retry?: { readonly anchor: RefObject<HTMLElement>; readonly said: string };
}

/** The strip's frame; `DraftUnavailable` and `DraftSummary` are what goes inside it. */
export function DraftStrip({ children, retry }: DraftStripProps): JSX.Element {
  return (
    <section
      className="wx-draft-summary"
      aria-label="Drafted sections"
      ref={retry?.anchor}
      tabIndex={retry ? -1 : undefined}
    >
      {children}
      {retry ? <output className="wx-row-sub">{retry.said}</output> : null}
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
    <>
      <InlineAlert tone="warning">
        The pre-drafted text could not be loaded. Your own documentation is not affected, but the
        note cannot be finalized until the draft can be read.
      </InlineAlert>
      <div>
        <RetryButton retrying={retrying} onRetry={onRetry} />
      </div>
    </>
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
    <>
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
    </>
  );
}
