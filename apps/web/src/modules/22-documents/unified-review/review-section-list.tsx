import { Glyph, StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import type { ReviewSectionProjection } from "./review-projection";
import type { ReviewSectionId } from "./review-sections";

function sectionStatus(section: ReviewSectionProjection): {
  label: string;
  tone: "success" | "warning" | "neutral";
} {
  if (section.state === "reviewed") return { label: "Reviewed", tone: "success" };
  if (section.exceptionCount > 0) {
    return {
      label: `${section.exceptionCount} item${section.exceptionCount === 1 ? "" : "s"} to review`,
      tone: "warning",
    };
  }
  if (section.state === "empty") return { label: "No extracted information", tone: "neutral" };
  return { label: "Review required", tone: "warning" };
}

export function ReviewSectionList({
  sections,
  selectedId,
  onSelect,
}: {
  sections: readonly ReviewSectionProjection[];
  selectedId: ReviewSectionId;
  onSelect: (sectionId: ReviewSectionId) => void;
}): JSX.Element {
  return (
    <nav className="wx-unified-sections" aria-label="Clinical review sections">
      {sections.map((section) => {
        const selected = section.id === selectedId;
        const status = sectionStatus(section);
        return (
          <button
            key={section.id}
            type="button"
            className={selected ? "is-selected" : undefined}
            aria-expanded={selected}
            aria-controls={`unified-section-${section.id}`}
            onClick={() => onSelect(section.id)}
          >
            <span className="wx-unified-section-icon" aria-hidden>
              <Glyph name={section.glyph} size={24} />
            </span>
            <span className="wx-unified-section-copy">
              <strong>{section.title}</strong>
              <small>{section.description}</small>
            </span>
            <StatusPill label={status.label} tone={status.tone} />
            <Glyph name={selected ? "chevron-down" : "chevron-right"} size={18} />
          </button>
        );
      })}
    </nav>
  );
}
