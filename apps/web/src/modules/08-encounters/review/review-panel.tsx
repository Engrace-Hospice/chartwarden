// apps/web/src/modules/08-encounters/review — the review panel (WF09 WP3): the server-assembled note in its slot, and a read-only summary of
// what the author has entered, each row with a way back to edit it. The panel assembles nothing and decides nothing: the note text is the
// caller's (the composer's existing preview), and whether the note can be finalized is the server's.
import { Button, InlineAlert } from "@chartwarden/ui";
import { memo, useId } from "react";
import type { JSX, ReactNode } from "react";
import { STATE_LABEL } from "../draft-model";
import type { NoteTarget } from "./note-target";
import { sectionEntryLabel } from "./progress-wording";
import {
  groupHeading,
  list,
  panelHeading,
  panelStyle,
  paragraph,
  reviewRow,
  reviewRowText,
} from "./review-styles";
import type { EntryBasis, FindingSummary, NoteSummary, SectionSummary } from "./review-summary";

export interface ReviewPanelProps {
  readonly summary: NoteSummary;
  /** Whether the note can still be edited: without it the rows carry no Edit button. */
  readonly editable: boolean;
  /** The composer holds changes the server has not saved: the summary shows what is on screen. */
  readonly unsavedChanges: boolean;
  readonly onEdit: (target: NoteTarget) => void;
  /** The assembled note, as the composer already shows it. */
  readonly children?: ReactNode;
  /** The workspace's Review anchor (`REVIEW_ANCHOR_ID`, workspace/jump-to-anchor): the panel takes focus when the step is jumped to. */
  readonly id?: string;
}

const BASIS_WORDS: Readonly<Record<EntryBasis, string>> = {
  selection: "selected statements",
  own_text: "your own text",
  saved_record: "a saved record",
  confirmed_draft: "confirmed drafted text",
};

const joinWords = (words: readonly string[]): string =>
  words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

interface RowProps {
  readonly editable: boolean;
  readonly onEdit: (target: NoteTarget) => void;
}

function EditButton({
  label,
  target,
  onEdit,
}: {
  readonly label: string;
  readonly target: NoteTarget;
  readonly onEdit: RowProps["onEdit"];
}): JSX.Element {
  return (
    <Button tone="tertiary" size="sm" aria-label={`Edit ${label}`} onClick={() => onEdit(target)}>
      Edit
    </Button>
  );
}

function SectionRow({
  section,
  editable,
  onEdit,
}: RowProps & { readonly section: SectionSummary }): JSX.Element {
  return (
    <li style={reviewRow}>
      <span style={reviewRowText}>
        <strong>{section.heading}</strong>
        <span className="wx-row-sub">{section.required ? "Required" : "Optional"}</span>
        <span>{sectionEntryLabel(section)}</span>
        {section.statements.length > 0 ? (
          <span className="wx-row-sub">{section.statements.join("; ")}</span>
        ) : null}
        {section.basis.length > 0 ? (
          <span className="wx-row-sub">
            Entered from {joinWords(section.basis.map((b) => BASIS_WORDS[b]))}.
          </span>
        ) : null}
        {section.draftState ? (
          <span className="wx-row-sub">Draft: {STATE_LABEL[section.draftState]}</span>
        ) : null}
      </span>
      {editable ? (
        <EditButton label={section.heading} target={section.edit} onEdit={onEdit} />
      ) : null}
    </li>
  );
}

function FindingRow({
  finding,
  editable,
  onEdit,
}: RowProps & { readonly finding: FindingSummary }): JSX.Element {
  return (
    <li style={reviewRow}>
      <span style={reviewRowText}>
        <strong>{finding.label}</strong>
        <span>{finding.detail}</span>
      </span>
      {editable ? <EditButton label={finding.label} target={finding.edit} onEdit={onEdit} /> : null}
    </li>
  );
}

// Memoised: the composer keeps the summary, the callback and the children stable, so a keystroke in a free-text box does not rebuild the rows.
export const ReviewPanel = memo(function ReviewPanel({
  summary,
  editable,
  unsavedChanges,
  onEdit,
  children,
  id,
}: ReviewPanelProps): JSX.Element {
  const headingId = useId();
  const stateId = useId();
  const recordedId = useId();
  return (
    <section id={id} tabIndex={-1} aria-labelledby={headingId} style={panelStyle}>
      <h2 id={headingId} style={panelHeading}>
        Review note
      </h2>
      <p style={paragraph}>
        This shows what you have entered; the server assembles the note text and decides whether it
        can be finalized.
      </p>
      {unsavedChanges ? (
        <InlineAlert tone="warning">
          You have unsaved changes. This summary shows what is on screen; the server checks only
          what is saved.
        </InlineAlert>
      ) : null}
      {children ? <div>{children}</div> : null}
      <h3 id={stateId} style={groupHeading}>
        What the note will state
      </h3>
      <ul aria-labelledby={stateId} style={list}>
        {summary.sections.map((section) => (
          <SectionRow
            key={section.sectionId}
            section={section}
            editable={editable}
            onEdit={onEdit}
          />
        ))}
      </ul>
      <h3 id={recordedId} style={groupHeading}>
        Recorded on this visit
      </h3>
      <ul aria-labelledby={recordedId} style={list}>
        {summary.findings.map((finding) => (
          <FindingRow key={finding.id} finding={finding} editable={editable} onEdit={onEdit} />
        ))}
      </ul>
    </section>
  );
});
