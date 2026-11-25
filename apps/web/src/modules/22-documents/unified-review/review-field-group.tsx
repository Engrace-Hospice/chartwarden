import { Glyph, StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { decisionLabel, docTypeLabel, pct } from "../doclens-model";
import type { ReviewFieldGroupProjection } from "./review-projection";

function detailPath(batchId: string, candidateId: string, returnTo: string | null): string {
  const query = new URLSearchParams({ mode: "detailed", from: "unified", candidate: candidateId });
  if (returnTo) query.set("returnTo", returnTo);
  return `/intake/${encodeURIComponent(batchId)}/review?${query.toString()}`;
}

export function ReviewFieldGroup({
  batchId,
  group,
  returnTo,
  onSelectSource,
}: {
  batchId: string;
  group: ReviewFieldGroupProjection;
  returnTo: string | null;
  onSelectSource: (candidateId: string) => void;
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
              <Link
                className="wx-btn-secondary wx-btn-sm"
                to={detailPath(batchId, candidate.id, returnTo)}
              >
                Review decision <Glyph name="arrow-right" size={15} />
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </article>
  );
}
