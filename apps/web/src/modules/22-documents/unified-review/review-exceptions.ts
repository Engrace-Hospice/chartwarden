import type { Candidate, Workspace } from "../doclens-api";
import { docTypeLabel, fieldLabel, identityNeedsAnswer, pct } from "../doclens-model";
import {
  type ReviewFieldGroupProjection,
  type ReviewObservation,
  candidateIsSelectable,
} from "./review-projection";
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
  /** Secondary line that tells same-titled rows apart: field, extracted value and page. */
  readonly subject?: string;
  readonly candidateId: string | null;
  readonly page: number | null;
}

export interface ReviewExceptionRuntime {
  readonly sourceUnavailablePages?: ReadonlySet<number>;
}

const SUBJECT_VALUE_MAX = 80;
const LOW_CONFIDENCE_BELOW = 0.75;

/** Never carries a withheld (Part 2) value; long values are cut so one row stays one line or two. */
function candidateSubject(candidate: Candidate): string {
  const where = fieldLabel(candidate.fieldPath);
  const page = `p.${candidate.page}`;
  if (candidate.redacted) return `${where}: withheld · ${page}`;
  const value = candidate.value ?? "no value extracted";
  const shown =
    value.length > SUBJECT_VALUE_MAX ? `${value.slice(0, SUBJECT_VALUE_MAX).trimEnd()}…` : value;
  return `${where}: ${shown} · ${page}`;
}

interface ExceptionFields {
  readonly id: string;
  readonly kind: ReviewExceptionKind;
  readonly priority: 0 | 1 | 2;
  readonly title: string;
  readonly detail: string;
  /** The candidate the exception points at; its id and page become the row's. */
  readonly target?: Candidate | undefined;
  readonly subject?: string;
}

function groupException(
  group: ReviewFieldGroupProjection,
  fields: ExceptionFields,
): ReviewExceptionProjection {
  const { target, subject, ...rest } = fields;
  return {
    ...rest,
    sectionId: group.sectionId,
    ...(subject ? { subject } : {}),
    candidateId: target?.id ?? null,
    page: target?.page ?? null,
  };
}

type Observations = readonly ReviewObservation[];

function undecidedCandidate(
  undecided: Observations,
  matches: (candidate: Candidate) => boolean,
): Candidate | undefined {
  return undecided.find(({ candidate }) => matches(candidate))?.candidate;
}

function redactedException(group: ReviewFieldGroupProjection): ReviewExceptionProjection | null {
  if (!group.hasRedaction) return null;
  return groupException(group, {
    id: `redacted:${group.id}`,
    kind: "redacted",
    priority: 0,
    title: `${group.label} is withheld`,
    detail: "Part 2 content requires an authorized reviewer with a need to know.",
    target: group.observations.find(({ candidate }) => candidate.redacted)?.candidate,
  });
}

function conflictException(group: ReviewFieldGroupProjection): ReviewExceptionProjection | null {
  if (!group.conflict) return null;
  return groupException(group, {
    id: `conflict:${group.id}`,
    kind: "conflict",
    priority: 1,
    title: `${group.label} has conflicting sources`,
    detail: `${group.distinctValueCount} values across ${group.observations.length} source observations require reconciliation.`,
    target: group.observations[0]?.candidate,
  });
}

function visionException(
  group: ReviewFieldGroupProjection,
  undecided: Observations,
): ReviewExceptionProjection | null {
  const target = undecidedCandidate(
    undecided,
    (candidate) => candidate.vision.status === "disagreed",
  );
  if (!target) return null;
  return groupException(group, {
    id: `vision:${group.id}`,
    kind: "vision-disagreement",
    priority: 1,
    title: `${group.label} differs from the vision check`,
    detail:
      "Compare the extracted value with the source and give a reason if accepting it unchanged.",
    subject: candidateSubject(target),
    target,
  });
}

function highRiskException(
  group: ReviewFieldGroupProjection,
  undecided: Observations,
): ReviewExceptionProjection | null {
  const target = undecidedCandidate(undecided, (candidate) => candidate.riskLevel === "high");
  if (!target) return null;
  return groupException(group, {
    id: `high-risk:${group.id}`,
    kind: "high-risk",
    priority: 1,
    title: `${group.label} needs high-risk review`,
    detail: "This candidate requires an eligible clinician's explicit field-level decision.",
    subject: candidateSubject(target),
    target,
  });
}

function lowConfidenceException(
  group: ReviewFieldGroupProjection,
  undecided: Observations,
): ReviewExceptionProjection | null {
  const target = undecidedCandidate(
    undecided,
    (candidate) => candidate.confidence < LOW_CONFIDENCE_BELOW,
  );
  if (!target) return null;
  return groupException(group, {
    id: `confidence:${group.id}`,
    kind: "low-confidence",
    priority: 2,
    title: `${group.label} needs a closer look`,
    detail: `${pct(target.confidence)} extraction confidence; confirm it against page ${target.page}.`,
    subject: candidateSubject(target),
    target,
  });
}

function undecidedException(
  group: ReviewFieldGroupProjection,
  undecided: Observations,
): ReviewExceptionProjection | null {
  const target = undecided[0]?.candidate;
  if (!target) return null;
  return groupException(group, {
    id: `undecided:${group.id}`,
    kind: "undecided",
    priority: 2,
    title: `${group.label} needs a decision`,
    detail: `${undecided.length} of ${group.observations.length} source observation${group.observations.length === 1 ? "" : "s"} remain undecided.`,
    subject: candidateSubject(target),
    target,
  });
}

function present(
  exception: ReviewExceptionProjection | null,
): exception is ReviewExceptionProjection {
  return exception !== null;
}

/** A plain "needs a decision" row appears only for a group no other requirement already names. */
function groupExceptions(group: ReviewFieldGroupProjection): readonly ReviewExceptionProjection[] {
  const undecided = group.observations.filter(({ candidate }) => candidate.decision === null);
  const named = [
    redactedException(group),
    conflictException(group),
    visionException(group, undecided),
    highRiskException(group, undecided),
    lowConfidenceException(group, undecided),
  ].filter(present);
  if (named.length > 0) return named;
  return [undecidedException(group, undecided)].filter(present);
}

function sourceExceptions(
  workspace: Workspace,
  runtime: ReviewExceptionRuntime,
): readonly ReviewExceptionProjection[] {
  return [...(runtime.sourceUnavailablePages ?? [])].map(
    (page): ReviewExceptionProjection => ({
      id: `source:${page}`,
      kind: "source-unavailable",
      priority: 0,
      sectionId: "documents-safeguards",
      title: `Source page ${page} is unavailable`,
      detail:
        "The source could not be verified. Retry the authorized image request before making a decision.",
      // The row opens a field task, so it names a field the reviewer can open: not a withheld one.
      candidateId:
        workspace.candidates.find(
          (candidate) => candidate.page === page && candidateIsSelectable(workspace, candidate),
        )?.id ?? null,
      page,
    }),
  );
}

function reviewLockException(workspace: Workspace): readonly ReviewExceptionProjection[] {
  const { review } = workspace;
  if (review?.status !== "in_progress" || review.isMine) return [];
  return [
    {
      id: `lock:${review.id}`,
      kind: "review-locked",
      priority: 1,
      sectionId: "documents-safeguards",
      title: "Another reviewer owns this review",
      detail: "You can inspect the referral, but only the current reviewer can record decisions.",
      candidateId: null,
      page: null,
    },
  ];
}

function documentException(
  workspace: Workspace,
  document: Workspace["documents"][number],
): ReviewExceptionProjection | null {
  if (identityNeedsAnswer(document))
    return {
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
    };
  if (document.identity.resolution !== "other_patient") return null;
  return {
    id: `other-patient:${document.pageFrom}`,
    kind: "wrong-patient",
    priority: 1,
    sectionId: "documents-safeguards",
    title: "Another patient's document is excluded",
    detail: `Pages ${document.pageFrom}${document.pageTo === document.pageFrom ? "" : `–${document.pageTo}`} remain visible for audit but cannot write to this chart.`,
    candidateId: null,
    page: document.pageFrom,
  };
}

function sudException(workspace: Workspace): readonly ReviewExceptionProjection[] {
  if (workspace.sud.status !== "detected") return [];
  return [
    {
      id: "sud:unresolved",
      kind: "sud-unresolved",
      priority: 0,
      sectionId: "documents-safeguards",
      title: "Part 2 / SUD safeguard is unresolved",
      detail: "An eligible reviewer must confirm or reject the detection before completion.",
      candidateId: workspace.candidates.find((candidate) => candidate.sudDetected)?.id ?? null,
      page: workspace.sud.indicators[0]?.page ?? null,
    },
  ];
}

function jobExceptions(workspace: Workspace): readonly ReviewExceptionProjection[] {
  return workspace.jobs
    .filter((job) => job.status === "awaiting_capability" || job.status === "failed")
    .map(
      (job): ReviewExceptionProjection => ({
        id: `job:${job.id}`,
        kind: "extraction-unavailable",
        priority: 2,
        sectionId: "documents-safeguards",
        title: `Extraction unavailable for ${job.pageFrom === job.pageTo ? `page ${job.pageFrom}` : `pages ${job.pageFrom}–${job.pageTo}`}`,
        detail:
          "Review the source directly; no extracted observations are available for this document.",
        candidateId: null,
        page: job.pageFrom,
      }),
    );
}

export function projectReviewExceptions(
  workspace: Workspace,
  groups: readonly ReviewFieldGroupProjection[],
  runtime: ReviewExceptionRuntime = {},
): readonly ReviewExceptionProjection[] {
  const exceptions: readonly ReviewExceptionProjection[] = [
    ...sourceExceptions(workspace, runtime),
    ...reviewLockException(workspace),
    ...workspace.documents
      .map((document) => documentException(workspace, document))
      .filter(present),
    ...sudException(workspace),
    ...jobExceptions(workspace),
    ...groups.flatMap(groupExceptions),
  ];
  return [...exceptions].sort(
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
