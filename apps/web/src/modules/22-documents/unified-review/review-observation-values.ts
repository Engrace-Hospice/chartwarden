import type { Candidate } from "../doclens-api";
import { normalizedCandidateValue } from "./review-conflicts";
import type { ReviewObservation } from "./review-projection";

/** What the reviewer sees as this observation's decision, for consolidation purposes only. */
export type ObservationValueKind = "correction" | "rejected" | "extracted" | "withheld";

export interface ObservationValue {
  /** Stable across workspace refreshes: the same value and kind always get the same key. */
  readonly key: string;
  readonly kind: ObservationValueKind;
  /** The effective value of the first source, as it should be shown. Null when withheld or blank. */
  readonly displayValue: string | null;
  readonly observations: readonly ReviewObservation[];
}

export const NO_VALUE_LABEL = "No value extracted";

/** The value when it has visible text; null for null, empty and whitespace-only, which are no value. */
export function visibleValue(value: string | null): string | null {
  return value !== null && value.trim() !== "" ? value : null;
}

/** The value a reviewer sees for an observation: the approved correction wins over the extraction. */
export function effectiveObservationValue(candidate: Candidate): string | null {
  const { decision } = candidate;
  return decision?.decision === "approve_with_edit" && decision.editedValue !== null
    ? decision.editedValue
    : candidate.value;
}

function observationKind(candidate: Candidate): ObservationValueKind {
  if (candidate.redacted) return "withheld";
  const kind = candidate.decision?.decision;
  if (kind === "approve_with_edit" && candidate.decision?.editedValue !== null) return "correction";
  return kind === "reject" ? "rejected" : "extracted";
}

function valueKey(candidate: Candidate, kind: ObservationValueKind): string {
  // Protected content is never merged: each withheld source keeps its own row.
  if (kind === "withheld") return `withheld|${candidate.id}`;
  const value = normalizedCandidateValue({
    fieldPath: candidate.fieldPath,
    value: effectiveObservationValue(candidate),
  });
  return `${kind}|${value}`;
}

/**
 * Collapses observations that show the same value into one entry so a repeated demographic reads
 * once. The match is exact after trim, whitespace collapse and case folding (the same normalisation
 * that drives the conflict badge), never fuzzy. A correction, a rejection and a plain extraction
 * stay apart, so an approved correction cannot hide behind (or swallow) an identical extracted
 * value and a rejected source stays visible. Order follows the first source of each value.
 */
export function consolidateObservations(
  observations: readonly ReviewObservation[],
): readonly ObservationValue[] {
  const byKey = new Map<string, { head: ObservationValue; members: ReviewObservation[] }>();
  for (const observation of observations) {
    const { candidate } = observation;
    const kind = observationKind(candidate);
    const key = valueKey(candidate, kind);
    const entry = byKey.get(key);
    if (entry) {
      entry.members.push(observation);
      continue;
    }
    const displayValue =
      kind === "withheld" ? null : visibleValue(effectiveObservationValue(candidate));
    byKey.set(key, { head: { key, kind, displayValue, observations: [] }, members: [observation] });
  }
  return [...byKey.values()].map(({ head, members }) => ({ ...head, observations: members }));
}
