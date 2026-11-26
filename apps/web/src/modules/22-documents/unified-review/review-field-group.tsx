import { Glyph, StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import { decisionLabel, docTypeLabel, pct } from "../doclens-model";
import type { ReviewFieldGroupProjection } from "./review-projection";

export function ReviewFieldGroup({
  group,
  onSelectSource,
  onReviewDecision,
}: {
  group: ReviewFieldGroupProjection;
  onSelectSource: (candidateId: string) => void;
  onReviewDecision: (candidateId: string) => void;
}): JSX.Element {
  const status = group.conflict
    ? { label: `${group.distinctValueCount} conflicting values`, tone: "warning" as const }
    : group.state === "reviewed"
      ? { label: "Reviewed", tone: "success" as const }
      : group.state === "partially-reviewed"
        ? { label: "Partially reviewed", tone: "progress" as const }
        : group.highestRisk === "high"
          ? { label: "High-risk review", tone: "critical" as const }
          : { label: "Review required", tone: "warning" as const };

  return (
    <article className="wx-unified-group" data-group-id={group.id}>
      <header>
        <div>
          <span className="wx-unified-category">{group.category}</span>
          <h3>{group.label}</h3>
          <p>
            {group.observations.length} source observation
            {group.observations.length === 1 ? "" : "s"} · {group.decidedCount} decided
          </p>
        </div>
        <StatusPill label={status.label} tone={status.tone} />
      </header>
      <ul className="wx-unified-observations">
        {group.observations.map(({ candidate, document }) => (
          <li key={candidate.id} data-candidate-id={candidate.id}>
            <div className="wx-unified-observation-value">
              {candidate.redacted ? (
                <strong>Part 2 content withheld</strong>
              ) : candidate.decision?.decision === "approve_with_edit" &&
                candidate.decision.editedValue !== null ? (
                <>
                  <strong>{candidate.decision.editedValue}</strong>
                  <span>Approved correction</span>
                  <span>Extracted: {candidate.value ?? "No value extracted"}</span>
                </>
              ) : (
                <strong>{candidate.value ?? "No value extracted"}</strong>
              )}
              <span>
                {document?.title ?? docTypeLabel(candidate.documentType)} · Page {candidate.page} ·{" "}
                {pct(candidate.confidence)} confidence
              </span>
              <span>
                {candidate.decision
                  ? decisionLabel(candidate.decision.decision)
                  : "No decision recorded"}
                {candidate.vision.status === "disagreed" ? " · Vision disagreement" : ""}
              </span>
            </div>
            <div className="wx-unified-observation-actions">
              <button
                type="button"
                className="wx-btn-secondary wx-btn-sm"
                onClick={() => onSelectSource(candidate.id)}
              >
                <Glyph name="eye" size={15} /> Preview source
              </button>
              <button
                type="button"
                className="wx-btn-secondary wx-btn-sm"
                onClick={() => onReviewDecision(candidate.id)}
              >
                Review decision <Glyph name="arrow-right" size={15} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </article>
  );
}
