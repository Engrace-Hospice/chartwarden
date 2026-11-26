import type { Candidate, Workspace } from "../doclens-api";
import { fieldLabel } from "../doclens-model";
import {
  candidateGroupingKey,
  canonicalFieldPath,
  hasConflictingValues,
  normalizedCandidateValue,
} from "./review-conflicts";
import {
  REVIEW_SECTIONS,
  type ReviewSectionDefinition,
  type ReviewSectionId,
  sectionForField,
} from "./review-sections";

export type ReviewGroupState = "reviewed" | "partially-reviewed" | "review-required";
export type ReviewSectionState = "reviewed" | "needs-review" | "empty";

export interface ReviewObservation {
  readonly candidate: Candidate;
  readonly document: Workspace["documents"][number] | null;
}

export interface ReviewFieldGroupProjection {
  readonly id: string;
  readonly sectionId: ReviewSectionId;
  readonly category: string;
  readonly canonicalFieldPath: string;
  readonly label: string;
  readonly candidateIds: readonly string[];
  readonly observations: readonly ReviewObservation[];
  readonly state: ReviewGroupState;
  readonly conflict: boolean;
  readonly distinctValueCount: number;
  readonly decidedCount: number;
  readonly highestRisk: Candidate["riskLevel"];
  readonly hasVisionDisagreement: boolean;
  readonly hasRedaction: boolean;
}

export interface ReviewSectionProjection extends ReviewSectionDefinition {
  readonly groups: readonly ReviewFieldGroupProjection[];
  readonly candidateCount: number;
  readonly decidedCount: number;
  readonly exceptionCount: number;
  readonly state: ReviewSectionState;
}

export interface ReviewProjection {
  readonly workspace: Workspace;
  readonly sections: readonly ReviewSectionProjection[];
  readonly groups: readonly ReviewFieldGroupProjection[];
  readonly candidateIds: readonly string[];
  readonly excludedCandidateIds: readonly string[];
  readonly candidateCount: number;
  readonly decidedCount: number;
  readonly reviewedSectionCount: number;
}

const RISK_RANK: Readonly<Record<Candidate["riskLevel"], number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

function highestRisk(candidates: readonly Candidate[]): Candidate["riskLevel"] {
  return candidates.reduce<Candidate["riskLevel"]>(
    (highest, candidate) =>
      RISK_RANK[candidate.riskLevel] > RISK_RANK[highest] ? candidate.riskLevel : highest,
    "low",
  );
}

function groupState(candidates: readonly Candidate[]): ReviewGroupState {
  const decided = candidates.filter((candidate) => candidate.decision !== null).length;
  return decided === candidates.length
    ? "reviewed"
    : decided > 0
      ? "partially-reviewed"
      : "review-required";
}

function documentForPage(
  documents: Workspace["documents"],
  page: number,
): Workspace["documents"][number] | null {
  return documents.find((document) => page >= document.pageFrom && page <= document.pageTo) ?? null;
}

export function candidateIsOtherPatient(workspace: Workspace, candidate: Candidate): boolean {
  return (
    documentForPage(workspace.documents, candidate.page)?.identity.resolution === "other_patient"
  );
}

/** A candidate the reviewer can open as a field task: not withheld, not another patient's. */
export function candidateIsSelectable(workspace: Workspace, candidate: Candidate): boolean {
  return !candidate.redacted && !candidateIsOtherPatient(workspace, candidate);
}

function categoryFor(candidate: Candidate): string {
  if (candidate.fieldPath.startsWith("patient.address.")) return "Address";
  if (candidate.fieldPath.startsWith("patient.")) return "Patient information";
  if (candidate.fieldPath.startsWith("medications[")) return "Medications";
  if (candidate.fieldPath.startsWith("allergies[")) return "Allergies";
  if (candidate.fieldPath.startsWith("diagnoses[")) return "Diagnoses";
  return "Other / unmapped";
}

function groupLabel(candidate: Candidate): string {
  const canonical = canonicalFieldPath(candidate.fieldPath);
  if (canonical === "medications[].name") return "Medication";
  if (canonical === "allergies[].substance") return "Allergy";
  if (canonical === "diagnoses[].description") return "Diagnosis";
  if (canonical === "diagnoses[].role") return "Diagnosis role";
  if (canonical === "diagnoses[].icd10") return "Diagnosis ICD-10-CM code";
  return fieldLabel(candidate.fieldPath).replace(/ \d+ · /, " · ");
}

function groupId(sectionId: ReviewSectionId, candidates: readonly Candidate[]): string {
  return `review-group:${sectionId}:${candidates
    .map((candidate) => candidate.id)
    .sort()
    .join(":")}`;
}

export function projectReviewGroups(workspace: Workspace): readonly ReviewFieldGroupProjection[] {
  const grouped = new Map<string, Candidate[]>();
  for (const candidate of workspace.candidates) {
    if (candidateIsOtherPatient(workspace, candidate)) continue;
    const sectionId = sectionForField(candidate.fieldPath);
    const key = `${sectionId}|${candidateGroupingKey(candidate)}`;
    const current = grouped.get(key) ?? [];
    current.push(candidate);
    grouped.set(key, current);
  }

  return [...grouped.values()]
    .map((candidates) => {
      const sorted = [...candidates].sort(
        (a, b) => a.page - b.page || a.bbox[1] - b.bbox[1] || a.id.localeCompare(b.id),
      );
      const first = sorted[0] as Candidate;
      const sectionId = sectionForField(first.fieldPath);
      const decidedCount = sorted.filter((candidate) => candidate.decision !== null).length;
      return {
        id: groupId(sectionId, sorted),
        sectionId,
        category: categoryFor(first),
        canonicalFieldPath: canonicalFieldPath(first.fieldPath),
        label: groupLabel(first),
        candidateIds: sorted.map((candidate) => candidate.id),
        observations: sorted.map((candidate) => ({
          candidate,
          document: documentForPage(workspace.documents, candidate.page),
        })),
        state: groupState(sorted),
        conflict: hasConflictingValues(sorted),
        distinctValueCount: new Set(sorted.map(normalizedCandidateValue)).size,
        decidedCount,
        highestRisk: highestRisk(sorted),
        hasVisionDisagreement: sorted.some((candidate) => candidate.vision.status === "disagreed"),
        hasRedaction: sorted.some((candidate) => candidate.redacted),
      } satisfies ReviewFieldGroupProjection;
    })
    .sort(
      (a, b) =>
        REVIEW_SECTIONS.findIndex((section) => section.id === a.sectionId) -
          REVIEW_SECTIONS.findIndex((section) => section.id === b.sectionId) ||
        a.label.localeCompare(b.label) ||
        a.id.localeCompare(b.id),
    );
}

export function projectUnifiedReview(
  workspace: Workspace,
  exceptionCounts: Readonly<Partial<Record<ReviewSectionId, number>>> = {},
): ReviewProjection {
  const groups = projectReviewGroups(workspace);
  const sections = REVIEW_SECTIONS.map((definition) => {
    const sectionGroups = groups.filter((group) => group.sectionId === definition.id);
    const candidateCount = sectionGroups.reduce(
      (total, group) => total + group.candidateIds.length,
      0,
    );
    const decidedCount = sectionGroups.reduce((total, group) => total + group.decidedCount, 0);
    const exceptionCount = exceptionCounts[definition.id] ?? 0;
    const state: ReviewSectionState =
      candidateCount === 0
        ? "empty"
        : decidedCount === candidateCount && exceptionCount === 0
          ? "reviewed"
          : "needs-review";
    return {
      ...definition,
      groups: sectionGroups,
      candidateCount,
      decidedCount,
      exceptionCount,
      state,
    } satisfies ReviewSectionProjection;
  });
  const candidateIds = workspace.candidates.map((candidate) => candidate.id).sort();
  const excludedCandidateIds = workspace.candidates
    .filter((candidate) => candidateIsOtherPatient(workspace, candidate))
    .map((candidate) => candidate.id)
    .sort();
  const candidateCount = groups.reduce((total, group) => total + group.candidateIds.length, 0);
  const decidedCount = groups.reduce((total, group) => total + group.decidedCount, 0);
  return {
    workspace,
    sections,
    groups,
    candidateIds,
    excludedCandidateIds,
    candidateCount,
    decidedCount,
    reviewedSectionCount: sections.filter((section) => section.state === "reviewed").length,
  };
}
