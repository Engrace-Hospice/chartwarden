import { Glyph, StatusPill } from "@chartwarden/ui";
import { memo, useId, useMemo, useState } from "react";
import type { JSX } from "react";
import type { Candidate } from "../doclens-api";
import { decisionLabel, docTypeLabel, pct } from "../doclens-model";
import {
  NO_VALUE_LABEL,
  type ObservationValue,
  type ObservationValueKind,
  consolidateObservations,
  extractedValues,
  observationDisplayValue,
  observationKind,
  visibleValue,
} from "./review-observation-values";
import type { ReviewFieldGroupProjection, ReviewObservation } from "./review-projection";

interface ReviewAction {
  /**
   * Opens the observation's review task: its source page, the highlighted location and the decision.
   * The clicked button comes with it, so closing the task can hand focus back to it.
   */
  readonly onReview: (candidateId: string, trigger: HTMLElement | null) => void;
  /** True while a decision is being saved: no task opens until it has ended. */
  readonly disabled?: boolean;
}

/** Names a value that is not a plain extraction, so a rejected value cannot pass for an accepted one. */
function ValueMarker({ kind }: { kind: ObservationValueKind }): JSX.Element | null {
  if (kind === "correction") {
    return <span className="wx-unified-observation-marker">Approved correction</span>;
  }
  if (kind === "rejected") return <span className="wx-unified-observation-marker">Rejected</span>;
  return null;
}

/** The decision state and vision flag of one source. A rejection is already named by its marker. */
function decisionLine(candidate: Candidate, kind: ObservationValueKind): string {
  const decided = candidate.decision ? decisionLabel(candidate.decision.decision) : null;
  const parts = [
    kind === "rejected" ? null : (decided ?? "No decision recorded"),
    candidate.vision.status === "disagreed" ? "Vision disagreement" : null,
  ];
  return parts.filter((part) => part !== null).join(" · ");
}

/**
 * The accessible name of a button that names a value. It is a hidden element the button points at, not
 * an `aria-label`: an extracted value (a name, a date of birth) is never copied into a DOM attribute.
 */
function NameSource({ id, children }: { id: string; children: string }): JSX.Element {
  return (
    <span id={id} hidden>
      {children}
    </span>
  );
}

function ObservationRow({
  observation: { candidate, document },
  onReview,
  disabled,
}: ReviewAction & { observation: ReviewObservation }): JSX.Element {
  const kind = observationKind(candidate);
  const shown = observationDisplayValue(candidate);
  const line = decisionLine(candidate, kind);
  const nameId = useId();
  return (
    <li data-candidate-id={candidate.id}>
      <div className="wx-unified-observation-value">
        <strong>{shown}</strong>
        <ValueMarker kind={kind} />
        {kind === "correction" ? (
          <span>Extracted: {visibleValue(candidate.value) ?? NO_VALUE_LABEL}</span>
        ) : null}
        <span>
          {document?.title ?? docTypeLabel(candidate.documentType)} · Page {candidate.page} ·{" "}
          {pct(candidate.confidence)} confidence
        </span>
        {line ? <span>{line}</span> : null}
      </div>
      <div className="wx-unified-observation-actions">
        <NameSource id={nameId}>{`Review ${shown}, page ${candidate.page}`}</NameSource>
        <button
          type="button"
          className="wx-btn-secondary wx-btn-sm"
          aria-labelledby={nameId}
          disabled={disabled}
          onClick={(event) => onReview(candidate.id, event.currentTarget)}
        >
          Review <Glyph name="arrow-right" size={15} />
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
  onReview,
  disabled,
}: ReviewAction & {
  value: ObservationValue;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const sourcesId = useId();
  const nameId = useId();
  const shown = value.displayValue ?? NO_VALUE_LABEL;
  const extracted = extractedValues(value);
  return (
    <li>
      <div className="wx-unified-observation-value">
        <strong>{shown}</strong>
        <ValueMarker kind={value.kind} />
        {extracted.length > 0 ? <span>Extracted: {extracted.join(", ")}</span> : null}
        <span>{consolidatedSummary(value)}</span>
      </div>
      <NameSource id={nameId}>{`Sources for ${shown}`}</NameSource>
      <button
        type="button"
        className="wx-btn-secondary wx-btn-sm wx-unified-observation-toggle"
        aria-expanded={expanded}
        aria-controls={sourcesId}
        aria-labelledby={nameId}
        onClick={onToggle}
      >
        Sources <Glyph name={expanded ? "chevron-down" : "chevron-right"} size={15} />
      </button>
      {expanded ? (
        <ul id={sourcesId} className="wx-unified-observation-sources">
          {value.observations.map((observation) => (
            <ObservationRow
              key={observation.candidate.id}
              observation={observation}
              onReview={onReview}
              disabled={disabled}
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

/** Pass a stable `onReview` (and an unchanged `group` between refreshes) so the memo can skip renders. */
export const ReviewFieldGroup = memo(function ReviewFieldGroup({
  group,
  onReview,
  disabled,
}: ReviewAction & {
  group: ReviewFieldGroupProjection;
}): JSX.Element {
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const status = groupStatus(group);
  const values = useMemo(() => consolidateObservations(group.observations), [group.observations]);
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
              onReview={onReview}
              disabled={disabled}
            />
          ) : (
            <ConsolidatedValue
              key={value.key}
              value={value}
              expanded={expandedKeys.has(value.key)}
              onToggle={() => toggle(value.key)}
              onReview={onReview}
              disabled={disabled}
            />
          );
        })}
      </ul>
    </article>
  );
});
