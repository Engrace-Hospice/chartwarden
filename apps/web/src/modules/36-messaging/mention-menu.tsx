import type { JSX } from "react";
import type { MentionCandidate } from "./messaging-types";

interface MentionMenuProps {
  readonly loading: boolean;
  readonly error: boolean;
  readonly candidates: readonly MentionCandidate[];
  readonly activeIndex: number;
  readonly onChoose: (candidate: MentionCandidate) => void;
  readonly onRetry: () => void;
}

/** The composer's @-mention suggestion popup. Focus stays in the textarea; arrow keys drive the active option. */
export function MentionMenu({
  loading,
  error,
  candidates,
  activeIndex,
  onChoose,
  onRetry,
}: MentionMenuProps): JSX.Element {
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: focus remains in the composer while arrow keys control this ARIA combobox popup
    <div
      id="messaging-mention-suggestions"
      className="wx-mention-menu"
      // biome-ignore lint/a11y/useSemanticElements: a native select cannot serve as a rich, async composer popup
      role="listbox"
      aria-label="Mention suggestions"
    >
      {loading ? (
        <span className="wx-mention-state">Searching…</span>
      ) : error ? (
        <span className="wx-mention-state" role="alert">
          Suggestions could not be loaded.{" "}
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </span>
      ) : candidates.length === 0 ? (
        <span className="wx-mention-state">No eligible people or patients</span>
      ) : (
        candidates.map((candidate, index) => (
          <button
            // biome-ignore lint/a11y/useSemanticElements: a native option cannot render the required staff/patient detail markup
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={index === activeIndex}
            className={index === activeIndex ? "is-active" : undefined}
            key={`${candidate.kind}:${candidate.entityId}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(candidate)}
          >
            <strong>{candidate.displayName}</strong>
            <span>
              {candidate.kind === "patient" ? "Patient" : "Staff"}
              {candidate.detail ? ` · ${candidate.detail}` : ""}
            </span>
          </button>
        ))
      )}
    </div>
  );
}
