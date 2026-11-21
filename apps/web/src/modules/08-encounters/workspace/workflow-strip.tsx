// apps/web/src/modules/08-encounters/workspace — the Document / Review / Complete strip (Workflow 09, WP1). Navigation only: it adds no
// status and decides nothing. Document is the composer (an editable note is a Draft; any other status says why it is closed), Review and
// Complete move within the page to where the note reads and where it is finalized or signed.
import { useId, useState } from "react";
import type { JSX, MouseEvent } from "react";
import { Link } from "react-router-dom";
import { stateLabel } from "../encounter-status";
import { COMPLETE_ANCHOR_ID, REVIEW_ANCHOR_ID, jumpToAnchor } from "./jump-to-anchor";

/** The id the composer's Document step goes to: the top of the page where the note is written. */
export const DOCUMENT_ANCHOR_ID = "visit-document";

type Step = "document" | "review" | "complete";

interface VisitWorkflowStripProps {
  /** Which screen the strip is on: the composer is the Document step itself; on the record it leads there. */
  readonly screen: "compose" | "record";
  /** The encounter's status exactly as the server returned it. */
  readonly status: string;
  /** Whether the session may author encounters: the composer's route needs it, so without it Document is not a link. A choice of what to show, not authorization. */
  readonly canAuthor: boolean;
  /** Where Document goes from the record (the composer, with the way back already attached). */
  readonly composeHref: string;
  /** Where Complete goes from the composer once the note is no longer a draft: signing happens on the record, not in the composer. */
  readonly recordCompleteHref: string;
  /** The id the Document step's reason is given, when another control on the screen (the record's Compose button) is described by it. */
  readonly documentReasonId?: string;
}

const stepClass = (active: boolean): string => `wx-chart-subtab${active ? " active" : ""}`;

/** Only a plain primary click is the strip's own: a modified or middle click is the browser's "open in a new tab" on a valid deep link. */
const isPlainPrimaryClick = (event: MouseEvent): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * The step the note is at, from the screen and the server's status, until the author jumps somewhere. In the composer the note is being
 * written (Document) until it is finalized and waits for review; on the record a draft is read (Review) and anything past it is at Complete.
 */
function stepFor(screen: VisitWorkflowStripProps["screen"], status: string): Step {
  if (screen === "compose") return status === "finalized" ? "review" : "document";
  return status === "draft" ? "review" : "complete";
}

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
          if (!isPlainPrimaryClick(event)) return;
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

/** What an account that may read a note but not author encounters is told wherever the way to the composer is withheld. */
export const READ_ONLY_REASON =
  "You can read this note but not edit it: writing a note needs permission to author encounters.";

/** Why Document cannot be taken on the record, or null when it can: a closed note, or an account that may read the note but not write it. */
function documentClosedReason(
  screen: VisitWorkflowStripProps["screen"],
  status: string,
  canAuthor: boolean,
): string | null {
  if (screen !== "record") return null;
  if (status !== "draft") {
    return `Documentation is closed: this encounter is ${stateLabel(status)}, and only a Draft can be edited.`;
  }
  return canAuthor ? null : READ_ONLY_REASON;
}

function DocumentStep({
  screen,
  composeHref,
  closedReason,
  active,
  reasonId,
  onJump,
}: {
  readonly screen: VisitWorkflowStripProps["screen"];
  readonly composeHref: string;
  readonly closedReason: string | null;
  readonly active: boolean;
  readonly reasonId: string;
  readonly onJump: () => void;
}): JSX.Element {
  if (screen === "compose") {
    return (
      <JumpStep anchorId={DOCUMENT_ANCHOR_ID} label="Document" active={active} onJump={onJump} />
    );
  }
  if (closedReason !== null) return <UnavailableStep label="Document" reasonId={reasonId} />;
  return (
    <li>
      <Link to={composeHref} className={stepClass(false)}>
        Document
      </Link>
    </li>
  );
}

export function VisitWorkflowStrip(props: VisitWorkflowStripProps): JSX.Element {
  const { screen, status, canAuthor, composeHref, recordCompleteHref, documentReasonId } = props;
  // A jump is remembered for the status it was made at: a finalize moves the note on, and the step it is at follows it.
  const [jumped, setJumped] = useState<{ readonly step: Step; readonly status: string } | null>(
    null,
  );
  const active = jumped?.status === status ? jumped.step : stepFor(screen, status);
  const jumpTo = (step: Step) => () => setJumped({ step, status });
  const generatedReasonId = useId();
  const reasonId = documentReasonId ?? generatedReasonId;
  const reviewReasonId = useId();
  const closedReason = documentClosedReason(screen, status, canAuthor);
  const reviewMissing = screen === "compose" && !composerHasReview(status);
  const signsOnRecord = screen === "compose" && status !== "draft";

  return (
    <nav aria-label="Note workflow">
      <ol className="wx-visit-steps">
        <DocumentStep
          screen={screen}
          composeHref={composeHref}
          closedReason={closedReason}
          active={active === "document"}
          reasonId={reasonId}
          onJump={jumpTo("document")}
        />
        {reviewMissing ? (
          <UnavailableStep label="Review" reasonId={reviewReasonId} />
        ) : (
          <JumpStep
            anchorId={REVIEW_ANCHOR_ID}
            label="Review"
            active={active === "review"}
            onJump={jumpTo("review")}
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
            onJump={jumpTo("complete")}
          />
        )}
      </ol>
      {closedReason !== null ? (
        <p id={reasonId} className="wx-visit-step-reason">
          {closedReason}
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
