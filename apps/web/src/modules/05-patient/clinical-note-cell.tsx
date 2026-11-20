// apps/web/src/modules/05-patient — one row of the Clinical tab's "Recent Clinical Notes": what a note says in the row, and, for a note whose
// Part 2 view could not be decided, the retry that reads just that note again (ADR-0114 VN-D30, S1 PR E3).
// Moved out of patient-clinical.tsx (S1 React review); the retry keeps keyboard focus while the note is read again, and when it succeeds
// (the button goes with the "cannot be shown" text) focus goes to the row's own link and the outcome is said in a status already on the page.
import { Button, StatusPill, t } from "@chartwarden/ui";
import { type JSX, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { NoteSummary } from "./clinical-note-summary";

/** The kit Button sets opacity and cursor inline, so the look of a button that is waiting has to be inline too. */
const WORKING_STYLE = { opacity: 0.6, cursor: "not-allowed" } as const;

type RetryPhase = "idle" | "reading" | "failed" | "read";

const RETRY_WORDS: Readonly<Record<RetryPhase, string>> = {
  idle: "",
  reading: " Reading the note again…",
  failed: " Still not available. Try again in a moment.",
  read: " The note was read again.",
};

/** A recent note whose Part 2 view could not be decided: said in words, with a retry that reads just this note again. */
function UnavailableNote({
  visit,
  retrying,
  onRetry,
}: {
  visit: string;
  retrying: boolean;
  onRetry: () => void;
}): JSX.Element {
  return (
    <span>
      <span>The note cannot be shown right now</span>{" "}
      <Button
        tone="tertiary"
        size="sm"
        // Not `loading` (which disables the button and drops keyboard focus from the person who pressed it): it says it is working and waits.
        aria-disabled={retrying || undefined}
        aria-busy={retrying || undefined}
        style={retrying ? WORKING_STYLE : undefined}
        aria-label={`Try again: ${visit}`}
        onClick={() => {
          if (!retrying) onRetry();
        }}
      >
        Try again
      </Button>
    </span>
  );
}

function NoteSummaryCell({
  summary,
  visit,
  retrying,
  onRetry,
}: {
  summary: NoteSummary;
  visit: string;
  retrying: boolean;
  onRetry: () => void;
}): JSX.Element {
  switch (summary.kind) {
    case "unavailable":
      return <UnavailableNote visit={visit} retrying={retrying} onRetry={onRetry} />;
    case "withheld":
      return (
        <span>
          <StatusPill label="Withheld" tone="neutral" />{" "}
          <span className="wx-row-sub">42 CFR Part 2</span>
        </span>
      );
    case "text":
      return (
        <span>
          {summary.text}
          {summary.someWithheld ? (
            <span className="wx-row-sub"> Some sections withheld</span>
          ) : null}
        </span>
      );
    case "none":
      return <span>—</span>;
  }
}

export interface NoteRowProps {
  /** The note's own page. */
  readonly href: string;
  readonly date: string;
  readonly typeLabel: string;
  readonly author: string;
  readonly summary: NoteSummary;
  /** Reads this note again; true once it was read. */
  readonly onRetry: () => Promise<boolean>;
}

export function NoteRow({
  href,
  date,
  typeLabel,
  author,
  summary,
  onRetry,
}: NoteRowProps): JSX.Element {
  const [phase, setPhase] = useState<RetryPhase>("idle");
  const link = useRef<HTMLAnchorElement>(null);
  const summaryCell = useRef<HTMLTableCellElement>(null);
  const retry = async (): Promise<void> => {
    setPhase("reading");
    const read = await onRetry();
    setPhase(read ? "read" : "failed");
    if (!read) return;
    // A note that is read again swaps the retry out. Focus goes to the row's link, which stays, unless the person went elsewhere meanwhile.
    const held = document.activeElement;
    if (held === null || held === document.body || summaryCell.current?.contains(held)) {
      link.current?.focus();
    }
  };
  return (
    <tr>
      <td className="wx-nums" style={{ whiteSpace: "nowrap" }}>
        {date}
      </td>
      <td style={{ whiteSpace: "nowrap" }}>
        <Link to={href} ref={link}>
          {typeLabel}
        </Link>
      </td>
      <td>{author}</td>
      <td style={{ color: t.onSurfaceVariant }} ref={summaryCell}>
        <NoteSummaryCell
          summary={summary}
          visit={`${typeLabel} ${date}`}
          retrying={phase === "reading"}
          onRetry={() => void retry()}
        />
        {/* Always on the page while a retry is in play, and filled in, so the outcome is announced (a region mounted with its text is not). */}
        {summary.kind === "unavailable" || phase !== "idle" ? (
          // "Read again" is stale once the note cannot be shown again.
          <output className="wx-row-sub">
            {summary.kind === "unavailable" && phase === "read" ? "" : RETRY_WORDS[phase]}
          </output>
        ) : null}
      </td>
    </tr>
  );
}
