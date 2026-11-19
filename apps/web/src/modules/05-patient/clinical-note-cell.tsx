// apps/web/src/modules/05-patient — one cell of the Clinical tab's "Recent Clinical Notes": what a note says in the row, and, for a note whose
// Part 2 view could not be decided, the retry that reads just that note again (ADR-0114 VN-D30, S1 PR E3).
// Moved out of patient-clinical.tsx (S1 React review); the retry keeps keyboard focus while the note is read again.
import { Button, StatusPill } from "@chartwarden/ui";
import { type JSX, useState } from "react";
import type { NoteSummary } from "./clinical-note-summary";

/** The kit Button sets opacity and cursor inline, so the look of a button that is waiting has to be inline too. */
const WORKING_STYLE = { opacity: 0.6, cursor: "not-allowed" } as const;

/** A recent note whose Part 2 view could not be decided: said in words, with a retry that reads just this note again. */
function UnavailableNote({
  visit,
  onRetry,
}: {
  visit: string;
  onRetry: () => Promise<boolean>;
}): JSX.Element {
  const [retrying, setRetrying] = useState(false);
  const [failedAgain, setFailedAgain] = useState(false);
  const retry = async (): Promise<void> => {
    setRetrying(true);
    setFailedAgain(false);
    const read = await onRetry();
    // A note that is read again swaps this cell out; only a refusal leaves it to say so.
    if (!read) {
      setFailedAgain(true);
      setRetrying(false);
    }
  };
  const outcomeWords = retrying
    ? " Reading the note again…"
    : failedAgain
      ? " Still not available. Try again in a moment."
      : "";
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
          if (!retrying) void retry();
        }}
      >
        Try again
      </Button>
      {/* Always on the page and filled in, so the outcome is announced (a region mounted with its text is not). */}
      <output className="wx-row-sub">{outcomeWords}</output>
    </span>
  );
}

export function NoteSummaryCell({
  summary,
  visit,
  onRetry,
}: {
  summary: NoteSummary;
  visit: string;
  onRetry: () => Promise<boolean>;
}): JSX.Element {
  switch (summary.kind) {
    case "unavailable":
      return <UnavailableNote visit={visit} onRetry={onRetry} />;
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
