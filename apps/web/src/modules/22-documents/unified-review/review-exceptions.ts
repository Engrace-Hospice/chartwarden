import type { Workspace } from "../doclens-api";
import { docTypeLabel, identityNeedsAnswer, pct } from "../doclens-model";
import type { ReviewFieldGroupProjection } from "./review-projection";
import { type ReviewSectionId, sectionIndex } from "./review-sections";

export type ReviewExceptionKind =
  | "source-unavailable"
  | "identity-unresolved"
  | "wrong-patient"
  | "sud-unresolved"
  | "redacted"
  | "review-locked"
  | "conflict"
  | "vision-disagreement"
  | "high-risk"
  | "low-confidence"
  | "extraction-unavailable"
  | "undecided";

export interface ReviewExceptionProjection {
  readonly id: string;
  readonly kind: ReviewExceptionKind;
  readonly priority: 0 | 1 | 2;
  readonly sectionId: ReviewSectionId;
  readonly title: string;
  readonly detail: string;
  readonly candidateId: string | null;
  readonly page: number | null;
}

export interface ReviewExceptionRuntime {
  readonly sourceUnavailablePages?: ReadonlySet<number>;
}

function groupExceptions(group: ReviewFieldGroupProjection): readonly ReviewExceptionProjection[] {
  const exceptions: ReviewExceptionProjection[] = [];
  const undecided = group.observations.filter(({ candidate }) => candidate.decision === null);
  if (group.hasRedaction) {
    const first = group.observations.find(({ candidate }) => candidate.redacted)?.candidate;
    exceptions.push({
      id: `redacted:${group.id}`,
      kind: "redacted",
      priority: 0,
      sectionId: group.sectionId,
      title: `${group.label} is withheld`,
      detail: "Part 2 content requires an authorized reviewer with a need to know.",
      candidateId: first?.id ?? null,
      page: first?.page ?? null,
    });
  }
  if (group.conflict) {
    const first = group.observations[0]?.candidate;
    exceptions.push({
      id: `conflict:${group.id}`,
      kind: "conflict",
      priority: 1,
      sectionId: group.sectionId,
      title: `${group.label} has conflicting sources`,
      detail: `${group.distinctValueCount} values across ${group.observations.length} source observations require reconciliation.`,
      candidateId: first?.id ?? null,
      page: first?.page ?? null,
    });
  }
  const vision = undecided.find(
    ({ candidate }) => candidate.vision.status === "disagreed",
  )?.candidate;
  if (vision) {
    exceptions.push({
      id: `vision:${group.id}`,
      kind: "vision-disagreement",
      priority: 1,
      sectionId: group.sectionId,
      title: `${group.label} differs from the vision check`,
      detail:
        "Compare the extracted value with the source and give a reason if accepting it unchanged.",
      candidateId: vision.id,
      page: vision.page,
    });
  }
  const highRisk = undecided.find(({ candidate }) => candidate.riskLevel === "high")?.candidate;
  if (highRisk) {
    exceptions.push({
      id: `high-risk:${group.id}`,
      kind: "high-risk",
      priority: 1,
      sectionId: group.sectionId,
      title: `${group.label} needs high-risk review`,
      detail: "This candidate requires an eligible clinician's explicit field-level decision.",
      candidateId: highRisk.id,
      page: highRisk.page,
    });
  }
  const lowConfidence = undecided.find(({ candidate }) => candidate.confidence < 0.75)?.candidate;
  if (lowConfidence) {
    exceptions.push({
      id: `confidence:${group.id}`,
      kind: "low-confidence",
      priority: 2,
      sectionId: group.sectionId,
      title: `${group.label} needs a closer look`,
      detail: `${pct(lowConfidence.confidence)} extraction confidence; confirm it against page ${lowConfidence.page}.`,
      candidateId: lowConfidence.id,
      page: lowConfidence.page,
    });
  }
  const firstUndecided = undecided[0]?.candidate;
  if (firstUndecided && exceptions.length === 0) {
    exceptions.push({
      id: `undecided:${group.id}`,
      kind: "undecided",
      priority: 2,
      sectionId: group.sectionId,
      title: `${group.label} needs a decision`,
      detail: `${undecided.length} of ${group.observations.length} source observation${group.observations.length === 1 ? "" : "s"} remain undecided.`,
      candidateId: firstUndecided.id,
      page: firstUndecided.page,
    });
  }
  return exceptions;
}

export function projectReviewExceptions(
  workspace: Workspace,
  groups: readonly ReviewFieldGroupProjection[],
  runtime: ReviewExceptionRuntime = {},
): readonly ReviewExceptionProjection[] {
  const exceptions: ReviewExceptionProjection[] = [];
  for (const page of runtime.sourceUnavailablePages ?? []) {
    exceptions.push({
      id: `source:${page}`,
      kind: "source-unavailable",
      priority: 0,
      sectionId: "documents-safeguards",
      title: `Source page ${page} is unavailable`,
      detail:
        "The source could not be verified. Retry the authorized image request before making a decision.",
      candidateId: workspace.candidates.find((candidate) => candidate.page === page)?.id ?? null,
      page,
    });
  }
  if (workspace.review?.status === "in_progress" && !workspace.review.isMine) {
    exceptions.push({
      id: `lock:${workspace.review.id}`,
      kind: "review-locked",
      priority: 1,
      sectionId: "documents-safeguards",
      title: "Another reviewer owns this review",
      detail: "You can inspect the referral, but only the current reviewer can record decisions.",
      candidateId: null,
      page: null,
    });
  }
  for (const document of workspace.documents) {
    if (identityNeedsAnswer(document)) {
      exceptions.push({
        id: `identity:${document.pageFrom}`,
        kind: "identity-unresolved",
        priority: 0,
        sectionId: "documents-safeguards",
        title: `Patient identity needs review on page ${document.pageFrom}`,
        detail: `${docTypeLabel(document.documentType)} may belong to another patient.`,
        candidateId:
          workspace.candidates.find(
            (candidate) => candidate.page >= document.pageFrom && candidate.page <= document.pageTo,
          )?.id ?? null,
        page: document.pageFrom,
      });
    } else if (document.identity.resolution === "other_patient") {
      exceptions.push({
        id: `other-patient:${document.pageFrom}`,
        kind: "wrong-patient",
        priority: 1,
        sectionId: "documents-safeguards",
        title: `Another patient's document is excluded`,
        detail: `Pages ${document.pageFrom}${document.pageTo === document.pageFrom ? "" : `–${document.pageTo}`} remain visible for audit but cannot write to this chart.`,
        candidateId: null,
        page: document.pageFrom,
      });
    }
  }
  if (workspace.sud.status === "detected") {
    exceptions.push({
      id: "sud:unresolved",
      kind: "sud-unresolved",
      priority: 0,
      sectionId: "documents-safeguards",
      title: "Part 2 / SUD safeguard is unresolved",
      detail: "An eligible reviewer must confirm or reject the detection before completion.",
      candidateId: workspace.candidates.find((candidate) => candidate.sudDetected)?.id ?? null,
      page: workspace.sud.indicators[0]?.page ?? null,
    });
  }
  for (const job of workspace.jobs.filter(
    (job) => job.status === "awaiting_capability" || job.status === "failed",
  )) {
    exceptions.push({
      id: `job:${job.id}`,
      kind: "extraction-unavailable",
      priority: 2,
      sectionId: "documents-safeguards",
      title: `Extraction unavailable for ${job.pageFrom === job.pageTo ? `page ${job.pageFrom}` : `pages ${job.pageFrom}–${job.pageTo}`}`,
      detail:
        "Review the source directly; no extracted observations are available for this document.",
      candidateId: null,
      page: job.pageFrom,
    });
  }
  for (const group of groups) {
    exceptions.push(...groupExceptions(group));
  }
  return exceptions.sort(
    (a, b) =>
      a.priority - b.priority ||
      sectionIndex(a.sectionId) - sectionIndex(b.sectionId) ||
      a.id.localeCompare(b.id),
  );
}

export function exceptionCountsBySection(
  exceptions: readonly ReviewExceptionProjection[],
): Readonly<Partial<Record<ReviewSectionId, number>>> {
  const counts: Partial<Record<ReviewSectionId, number>> = {};
  for (const exception of exceptions) {
    counts[exception.sectionId] = (counts[exception.sectionId] ?? 0) + 1;
  }
  return counts;
}
