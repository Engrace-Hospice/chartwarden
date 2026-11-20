// apps/web/src/modules/08-encounters/workspace — the Document / Review / Complete strip (Workflow 09, WP1). Navigation only: it adds no
// status and decides nothing. Document is the composer (an editable note is a Draft; any other status says why it is closed), Review and
// Complete move within the page to where the note reads and where it is finalized or signed.
import { useId, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { stateLabel } from "../encounter-status";
import { COMPLETE_ANCHOR_ID, REVIEW_ANCHOR_ID, jumpToAnchor } from "./jump-to-anchor";

/** The id the composer's Document step goes to: the top of the page where the note is written. */
export const DOCUMENT_ANCHOR_ID = "visit-document";

type Step = "document" | "review" | "complete";

export interface VisitWorkflowStripProps {
  /** Which screen the strip is on: the composer is the Document step itself; on the record it leads there. */
  readonly screen: "compose" | "record";
  /** The encounter's status exactly as the server returned it. */
  readonly status: string;
  /** Where Document goes from the record (the composer, with the way back already attached). */
  readonly composeHref: string;
  /** Where Complete goes from the composer once the note is no longer a draft: signing happens on the record, not in the composer. */
  readonly recordCompleteHref: string;
}

const stepClass = (active: boolean): string => `wx-chart-subtab${active ? " active" : ""}`;

interface JumpStepProps {
  readonly anchorId: string;
  readonly label: string;
  readonly active: boolean;
  readonly onJump: () => void;
}

function JumpStep({ anchorId, label, active, onJump }: JumpStepProps): JSX.Element {
  return (
    <li>
      <a
        href={`#${anchorId}`}
        className={stepClass(active)}
        aria-current={active ? "step" : undefined}
        onClick={(event) => {
          // Never the browser's own hash navigation (a history entry the router's guard would meet): the strip moves within the page. A
          // page without the target does nothing, and nothing is marked as the current step.
          event.preventDefault();
          if (jumpToAnchor(anchorId)) onJump();
        }}
      >
        {label}
      </a>
    </li>
  );
}

/** A step that cannot be taken here. aria-disabled, not disabled: it stays reachable by keyboard so the reason beside the strip is found. */
function UnavailableStep({
  label,
  reasonId,
}: {
  readonly label: string;
  readonly reasonId: string;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        className={`${stepClass(false)} wx-visit-step-unavailable`}
        aria-disabled="true"
        aria-describedby={reasonId}
      >
        {label}
      </button>
    </li>
  );
}

/** The composer holds the note's review and the sign-off panel only while the note can still be finalized; a signed or void note has none. */
function composerHasReview(status: string): boolean {
  return status === "draft" || status === "finalized";
}

function DocumentStep({
  screen,
  status,
  composeHref,
  active,
  reasonId,
  onJump,
}: VisitWorkflowStripProps & {
  readonly active: boolean;
  readonly reasonId: string;
  readonly onJump: () => void;
}): JSX.Element {
  if (screen === "compose") {
    return (
      <JumpStep anchorId={DOCUMENT_ANCHOR_ID} label="Document" active={active} onJump={onJump} />
    );
  }
  if (status === "draft") {
    return (
      <li>
        <Link to={composeHref} className={stepClass(false)}>
          Document
        </Link>
      </li>
    );
  }
  return <UnavailableStep label="Document" reasonId={reasonId} />;
}

export function VisitWorkflowStrip(props: VisitWorkflowStripProps): JSX.Element {
  const { screen, status, recordCompleteHref } = props;
  const [active, setActive] = useState<Step>(screen === "compose" ? "document" : "review");
  const reasonId = useId();
  const reviewReasonId = useId();
  const documentClosed = screen === "record" && status !== "draft";
  const reviewMissing = screen === "compose" && !composerHasReview(status);
  const signsOnRecord = screen === "compose" && status !== "draft";

  return (
    <nav aria-label="Note workflow">
      <ol className="wx-visit-steps">
        <DocumentStep
          {...props}
          active={active === "document"}
          reasonId={reasonId}
          onJump={() => setActive("document")}
        />
        {reviewMissing ? (
          <UnavailableStep label="Review" reasonId={reviewReasonId} />
        ) : (
          <JumpStep
            anchorId={REVIEW_ANCHOR_ID}
            label="Review"
            active={active === "review"}
            onJump={() => setActive("review")}
          />
        )}
        {signsOnRecord ? (
          <li>
            <Link to={recordCompleteHref} className={stepClass(false)}>
              Complete
            </Link>
          </li>
        ) : (
          <JumpStep
            anchorId={COMPLETE_ANCHOR_ID}
            label="Complete"
            active={active === "complete"}
            onJump={() => setActive("complete")}
          />
        )}
      </ol>
      {documentClosed ? (
        <p id={reasonId} className="wx-visit-step-reason">
          Documentation is closed: this encounter is {stateLabel(status)}, and only a Draft can be
          edited.
        </p>
      ) : null}
      {reviewMissing ? (
        <p id={reviewReasonId} className="wx-visit-step-reason">
          Review is not shown here: this encounter is {stateLabel(status)}, and the composer reviews
          only a Draft or a Finalized note. The encounter record shows it.
        </p>
      ) : null}
    </nav>
  );
}
