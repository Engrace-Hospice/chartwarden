import { Glyph } from "@chartwarden/ui";
import type { JSX } from "react";
import type { Workspace } from "../doclens-api";
import { ReviewFieldGroup } from "./review-field-group";
import type { ReviewProjection } from "./review-projection";
import { ReviewSectionList } from "./review-section-list";
import type { ReviewSectionId } from "./review-sections";

/** The left column: the six sections and the observations of the one that is open. */
export function ReviewClinicalColumn({
  workspace,
  projection,
  selectedSectionId,
  onSelectSection,
  onReview,
  busy,
}: {
  workspace: Workspace;
  projection: ReviewProjection;
  selectedSectionId: ReviewSectionId;
  onSelectSection: (sectionId: ReviewSectionId) => void;
  onReview: (candidateId: string, trigger: HTMLElement | null) => void;
  /** True while a decision is being saved: the Review buttons wait for it. */
  busy: boolean;
}): JSX.Element {
  const selectedSection = projection.sections.find((section) => section.id === selectedSectionId);
  return (
    <section className="wx-unified-clinical" aria-label="Clinical information">
      <header>
        <div>
          <h2>Clinical information</h2>
          <p>Consolidated information from {workspace.documents.length} source documents.</p>
        </div>
      </header>
      <ReviewSectionList
        sections={projection.sections}
        selectedId={selectedSectionId}
        onSelect={onSelectSection}
      />
      {selectedSection ? (
        <section
          id={`unified-section-${selectedSection.id}`}
          className="wx-unified-section-detail"
          aria-labelledby={`unified-section-title-${selectedSection.id}`}
        >
          <header>
            <div>
              <h2 id={`unified-section-title-${selectedSection.id}`}>{selectedSection.title}</h2>
              <p>{selectedSection.description}</p>
            </div>
            <span>
              {selectedSection.decidedCount} / {selectedSection.candidateCount} decided
            </span>
          </header>
          {selectedSection.groups.length === 0 ? (
            <div className="wx-unified-empty">
              <Glyph name="info" size={18} /> No extracted observations are mapped to this section.
            </div>
          ) : (
            selectedSection.groups.map((group) => (
              <ReviewFieldGroup key={group.id} group={group} onReview={onReview} disabled={busy} />
            ))
          )}
        </section>
      ) : null}
    </section>
  );
}
