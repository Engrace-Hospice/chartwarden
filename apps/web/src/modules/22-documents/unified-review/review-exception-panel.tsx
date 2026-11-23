import { Glyph, StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import type { ReviewExceptionProjection } from "./review-exceptions";

const TONE = {
  0: "critical",
  1: "warning",
  2: "neutral",
} as const;

export function ReviewExceptionPanel({
  exceptions,
  onSelect,
}: {
  exceptions: readonly ReviewExceptionProjection[];
  onSelect: (exception: ReviewExceptionProjection) => void;
}): JSX.Element {
  return (
    <aside className="wx-unified-exceptions" aria-labelledby="unified-exceptions-title">
      <header>
        <h2 id="unified-exceptions-title">Exceptions to review</h2>
        <StatusPill
          label={`${exceptions.length} item${exceptions.length === 1 ? "" : "s"}`}
          tone={exceptions.some((item) => item.priority === 0) ? "critical" : "warning"}
        />
      </header>
      {exceptions.length === 0 ? (
        <p className="wx-unified-empty">
          <Glyph name="check-circle" size={18} /> No projected exceptions.
        </p>
      ) : (
        <ol>
          {exceptions.map((exception) => (
            <li key={exception.id}>
              <button type="button" onClick={() => onSelect(exception)}>
                <span>
                  <strong>{exception.title}</strong>
                  <small>{exception.detail}</small>
                </span>
                <StatusPill
                  label={
                    exception.priority === 0
                      ? "Safeguard"
                      : exception.priority === 1
                        ? "Review"
                        : "Check"
                  }
                  tone={TONE[exception.priority]}
                />
                <Glyph name="chevron-right" size={17} />
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
