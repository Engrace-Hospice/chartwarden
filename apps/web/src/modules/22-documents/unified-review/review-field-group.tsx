import { Glyph, StatusPill } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { decisionLabel, docTypeLabel, pct } from "../doclens-model";
import {
  NO_VALUE_LABEL,
  type ObservationValue,
  consolidateObservations,
  visibleValue,
} from "./review-observation-values";
import type { ReviewFieldGroupProjection, ReviewObservation } from "./review-projection";

interface ObservationActions {
  readonly onSelectSource: (candidateId: string) => void;
  readonly onReviewDecision: (candidateId: string) => void;
}

function ObservationRow({
  observation: { candidate, document },
  onSelectSource,
  onReviewDecision,
}: ObservationActions & { observation: ReviewObservation }): JSX.Element {
  return (
    <li data-candidate-id={candidate.id}>
      <div className="wx-unified-observation-value">
        {candidate.redacted ? (
          <strong>Part 2 content withheld</strong>
        ) : candidate.decision?.decision === "approve_with_edit" &&
          candidate.decision.editedValue !== null ? (
          <>
            <strong>{candidate.decision.editedValue}</strong>
            <span>Approved correction</span>
            <span>Extracted: {visibleValue(candidate.value) ?? NO_VALUE_LABEL}</span>
          </>
        ) : (
          <strong>{visibleValue(candidate.value) ?? NO_VALUE_LABEL}</strong>
        )}
        <span>
          {document?.title ?? docTypeLabel(candidate.documentType)} · Page {candidate.page} ·{" "}
          {pct(candidate.confidence)} confidence
        </span>
        <span>
          {candidate.decision ? decisionLabel(candidate.decision.decision) : "No decision recorded"}
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
  );
}

function consolidatedSummary({ observations }: ObservationValue): string {
  const total = observations.length;
  const decided = observations.filter(({ candidate }) => candidate.decision !== null).length;
  const disagreements = observations.filter(
    ({ candidate }) => candidate.vision.status === "disagreed",
  ).length;
  const vision = disagreements > 0 ? ` · Vision disagreement (${disagreements})` : "";
  return `${total} sources · ${decided} of ${total} decided${vision}`;
}

/** One value shared by several sources: shown once, with every source one disclosure away. */
function ConsolidatedValue({
  value,
  expanded,
  onToggle,
  onSelectSource,
  onReviewDecision,
}: ObservationActions & {
  value: ObservationValue;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const sourcesId = `unified-sources-${value.observations[0]?.candidate.id ?? value.key}`;
  const shown = value.displayValue ?? NO_VALUE_LABEL;
  const toggleLabel = expanded ? "Hide sources" : "Show sources";
  return (
    <li className="wx-unified-observation-consolidated" data-value-key={value.key}>
      <div className="wx-unified-observation-value">
        <strong>{shown}</strong>
        {value.kind === "correction" ? <span>Approved correction</span> : null}
        {value.kind === "rejected" ? <span>Rejected</span> : null}
        <span>{consolidatedSummary(value)}</span>
      </div>
      <button
        type="button"
        className="wx-btn-secondary wx-btn-sm wx-unified-observation-toggle"
        aria-expanded={expanded}
        aria-controls={sourcesId}
        aria-label={`${toggleLabel} for ${shown}`}
        onClick={onToggle}
      >
        {toggleLabel} <Glyph name={expanded ? "chevron-down" : "chevron-right"} size={15} />
      </button>
      {expanded ? (
        <ul id={sourcesId} className="wx-unified-observation-sources">
          {value.observations.map((observation) => (
            <ObservationRow
              key={observation.candidate.id}
              observation={observation}
              onSelectSource={onSelectSource}
              onReviewDecision={onReviewDecision}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function groupStatus(group: ReviewFieldGroupProjection): {
  label: string;
  tone: "warning" | "success" | "progress" | "critical";
} {
  if (group.conflict)
    return { label: `${group.distinctValueCount} conflicting values`, tone: "warning" };
  if (group.state === "reviewed") return { label: "Reviewed", tone: "success" };
  if (group.state === "partially-reviewed")
    return { label: "Partially reviewed", tone: "progress" };
  if (group.highestRisk === "high") return { label: "High-risk review", tone: "critical" };
  return { label: "Review required", tone: "warning" };
}

export function ReviewFieldGroup({
  group,
  onSelectSource,
  onReviewDecision,
}: ObservationActions & {
  group: ReviewFieldGroupProjection;
}): JSX.Element {
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const status = groupStatus(group);
  const values = consolidateObservations(group.observations);
  const toggle = (key: string): void =>
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

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
        {values.map((value) => {
          const [only] = value.observations;
          return only && value.observations.length === 1 ? (
            <ObservationRow
              key={only.candidate.id}
              observation={only}
              onSelectSource={onSelectSource}
              onReviewDecision={onReviewDecision}
            />
          ) : (
            <ConsolidatedValue
              key={value.key}
              value={value}
              expanded={expandedKeys.has(value.key)}
              onToggle={() => toggle(value.key)}
              onSelectSource={onSelectSource}
              onReviewDecision={onReviewDecision}
            />
          );
        })}
      </ul>
    </article>
  );
}
