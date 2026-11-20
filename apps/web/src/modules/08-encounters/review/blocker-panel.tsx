// apps/web/src/modules/08-encounters/review — the blocker panel (WF09 WP3): what the server last said about finalizing or signing this
// note, and what it checks at each step.
//
// DRIVEN ONLY BY THE LAST SERVER RESPONSE. There is no read-only gate preview: `POST /encounters/:id/finalize` is the only check, and it
// finalizes the note when it passes. So this panel never claims "ready": before an attempt it says "Not checked yet" and lists what the
// server will check; after a refusal it lists the failures the server named (each with a way to the remedy); after a success it says the
// note is finalized and not signed. The register groups below it are fixed text and never carry a verdict.
import { Button } from "@chartwarden/ui";
import { memo, useEffect, useId, useRef } from "react";
import type { JSX, RefObject } from "react";
import {
  GROUP_HEADING,
  GROUP_NOTE,
  PANEL_HEADING,
  RETRY_LABEL,
  describeAttempt,
  gateSilenceNote,
  introCopy,
  showsFinalizeChecks,
} from "./blocker-copy";
import { type CheckGroup, type RegisterCheck, checksInGroup } from "./gate-register";
import type { NoteTarget } from "./note-target";
import type { Blocker, GateAttempt, Refusal } from "./refusal-model";
import {
  blockerRow,
  checkRow,
  groupBox,
  groupHeading,
  list,
  panelHeading,
  panelStyle,
  paragraph,
  statusBlocked,
  statusLine,
} from "./review-styles";

export interface BlockerPanelProps {
  readonly attempt: GateAttempt;
  /** Take the author to the place a blocker is fixed. The host moves focus or navigates; the panel only names the target. */
  readonly onRemedy: (target: NoteTarget) => void;
  /** Ask the server again after it could not decide. Without it no retry is offered. */
  readonly onRetry?: () => void;
  /** Whether a refusal moves focus to the first blocker. A screen with a dialog open keeps focus in the dialog, and takes it here when the dialog closes. */
  readonly takeFocus?: boolean;
  /** The workspace's Complete anchor (`COMPLETE_ANCHOR_ID`, workspace/jump-to-anchor): the panel takes focus when the step is jumped to. */
  readonly id?: string;
  /** The text of a blocker's remedy button on this screen; the blocker's own when omitted (a screen relabels what only another screen can do). */
  readonly remedyLabel?: (blocker: Blocker) => string | null;
}

const ownLabel = (blocker: Blocker): string | null => blocker.remedyLabel;

const blockedRefusal = (attempt: GateAttempt): Extract<Refusal, { outcome: "blocked" }> | null =>
  attempt.state === "refused" && attempt.refusal.outcome === "blocked" ? attempt.refusal : null;

// Static text, so the three lists are not rendered again by every keystroke elsewhere on the screen.
const CheckList = memo(function CheckList({ group }: { readonly group: CheckGroup }): JSX.Element {
  const headingId = useId();
  const note = GROUP_NOTE[group];
  return (
    <div style={groupBox}>
      <h3 id={headingId} style={groupHeading}>
        {GROUP_HEADING[group]}
      </h3>
      <ul aria-labelledby={headingId} style={list}>
        {checksInGroup(group).map((check: RegisterCheck) => (
          <li key={check.id} style={checkRow}>
            <strong>{check.title}</strong>
            <span className="wx-row-sub">{check.description}</span>
          </li>
        ))}
      </ul>
      {note ? <p style={paragraph}>{note}</p> : null}
    </div>
  );
});

interface BlockerListProps {
  readonly blockers: readonly Blocker[];
  readonly onRemedy: (target: NoteTarget) => void;
  readonly remedyLabel: (blocker: Blocker) => string | null;
  readonly first: RefObject<HTMLLIElement>;
}

function BlockerList({
  blockers,
  onRemedy,
  remedyLabel,
  first,
}: BlockerListProps): JSX.Element | null {
  if (blockers.length === 0) return null;
  return (
    <ol style={list}>
      {blockers.map((blocker, index) => (
        <li
          key={`${blocker.code}:${blocker.field ?? ""}:${index}`}
          data-blocker=""
          ref={index === 0 ? first : undefined}
          tabIndex={-1}
          style={blockerRow}
        >
          <strong>{blocker.what}</strong>
          <span className="wx-row-sub">{blocker.why}</span>
          {remedyLabel(blocker) ? (
            <Button tone="tertiary" size="sm" onClick={() => onRemedy(blocker.remedy)}>
              {remedyLabel(blocker)}
            </Button>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export const BlockerPanel = memo(function BlockerPanel({
  attempt,
  onRemedy,
  onRetry,
  takeFocus = true,
  id,
  remedyLabel = ownLabel,
}: BlockerPanelProps): JSX.Element {
  const headingId = useId();
  const statusId = useId();
  const section = useRef<HTMLElement>(null);
  const firstBlocker = useRef<HTMLLIElement>(null);
  const words = describeAttempt(attempt);
  const intro = introCopy(attempt);
  const blocked = blockedRefusal(attempt);
  const refusal = attempt.state === "refused" ? attempt.refusal : null;
  const canRetry =
    refusal?.outcome === "unavailable" && refusal.reason === "service" && onRetry !== undefined;
  // Each answer parses to a new refusal object, so a second refusal moves focus again and a re-render of the same one does not. A refusal
  // that lists nothing (the server could not decide, or named nothing) puts focus on the panel itself, so the failure is not left below
  // the fold with the author still looking at "All changes saved".
  useEffect(() => {
    if (refusal === null || !takeFocus) return;
    (firstBlocker.current ?? section.current)?.focus();
  }, [refusal, takeFocus]);

  return (
    <section
      ref={section}
      id={id}
      tabIndex={-1}
      aria-labelledby={headingId}
      // Focus on the panel reads what it last said too: a panel that was rebuilt after a finalize (the composer reads the page again)
      // has no change left to announce, so the status is read with the name.
      aria-describedby={statusId}
      aria-busy={attempt.state === "running"}
      style={panelStyle}
    >
      <h2 id={headingId} style={panelHeading}>
        {PANEL_HEADING}
      </h2>
      <output
        id={statusId}
        aria-live="polite"
        style={{ ...statusLine, ...(blocked ? statusBlocked : null) }}
      >
        <strong>{words.headline}</strong>
        <span>{words.body}</span>
      </output>
      {intro ? <p style={paragraph}>{intro}</p> : null}
      {blocked ? (
        <>
          <BlockerList
            blockers={blocked.blockers}
            onRemedy={onRemedy}
            remedyLabel={remedyLabel}
            first={firstBlocker}
          />
          {blocked.gateRanInFull ? (
            <p className="wx-row-sub">{gateSilenceNote(blocked.moment)}</p>
          ) : null}
        </>
      ) : null}
      {canRetry ? (
        <div>
          <Button tone="secondary" size="sm" onClick={onRetry}>
            {RETRY_LABEL}
          </Button>
        </div>
      ) : null}
      {blocked === null && showsFinalizeChecks(attempt) ? <CheckList group="finalize" /> : null}
      <CheckList group="sign" />
      <CheckList group="not_checked" />
    </section>
  );
});
