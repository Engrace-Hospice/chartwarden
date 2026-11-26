import type { ReviewExceptionKind, ReviewExceptionProjection } from "./review-exceptions";
import type { ReviewSectionId } from "./review-sections";

export type ExceptionCategoryId =
  | "patient-identity"
  | "part2-sud"
  | "conflicts"
  | "high-risk"
  | "vision"
  | "other";

export interface ReviewExceptionTask {
  readonly id: string;
  readonly categoryId: ExceptionCategoryId;
  readonly sectionId: ReviewSectionId;
  readonly title: string;
  readonly candidateId: string | null;
  readonly page: number | null;
  readonly blocked: boolean;
  readonly reasons: readonly ReviewExceptionProjection[];
}

export interface ReviewExceptionCategory {
  readonly id: ExceptionCategoryId;
  readonly label: string;
  readonly tasks: readonly ReviewExceptionTask[];
  readonly exceptionCount: number;
  readonly actionableCount: number;
  readonly blockedCount: number;
}

export interface ReviewExceptionSummary {
  readonly categories: readonly ReviewExceptionCategory[];
  readonly taskCount: number;
  readonly underlyingExceptionCount: number;
  readonly actionableTaskCount: number;
  readonly blockedTaskCount: number;
}

const CATEGORY_DEFINITIONS: readonly { id: ExceptionCategoryId; label: string }[] = [
  { id: "patient-identity", label: "Patient identity" },
  { id: "part2-sud", label: "Part 2 / SUD safeguards" },
  { id: "conflicts", label: "Conflicting extracted values" },
  { id: "high-risk", label: "High-risk clinical information" },
  { id: "vision", label: "Vision disagreements" },
  { id: "other", label: "Other review requirements" },
];

const BLOCKED_KINDS: ReadonlySet<ReviewExceptionKind> = new Set([
  "source-unavailable",
  "redacted",
  "review-locked",
  "wrong-patient",
  "extraction-unavailable",
]);

function categoryFor(reasons: readonly ReviewExceptionProjection[]): ExceptionCategoryId {
  const kinds = new Set(reasons.map((reason) => reason.kind));
  if (kinds.has("identity-unresolved") || kinds.has("wrong-patient")) return "patient-identity";
  if (kinds.has("sud-unresolved") || kinds.has("redacted")) return "part2-sud";
  if (kinds.has("conflict")) return "conflicts";
  if (kinds.has("high-risk")) return "high-risk";
  if (kinds.has("vision-disagreement")) return "vision";
  return "other";
}

function taskKey(exception: ReviewExceptionProjection): string {
  if (exception.kind === "identity-unresolved" || exception.kind === "wrong-patient")
    return `identity:${exception.page ?? exception.id}`;
  if (exception.kind === "sud-unresolved") return "safeguard:sud";
  if (exception.kind === "source-unavailable") return `source:${exception.page ?? exception.id}`;
  if (exception.kind === "review-locked") return "review:locked";
  if (exception.kind === "extraction-unavailable") return exception.id;
  return exception.candidateId ? `candidate:${exception.candidateId}` : exception.id;
}

/**
 * Consolidates presentation only. Every raw exception remains in exactly one task's `reasons` array.
 * Candidate IDs and safeguard/page identities remain the stable task keys.
 */
export function projectExceptionSummary(
  exceptions: readonly ReviewExceptionProjection[],
): ReviewExceptionSummary {
  const grouped = new Map<string, ReviewExceptionProjection[]>();
  for (const exception of exceptions) {
    const key = taskKey(exception);
    grouped.set(key, [...(grouped.get(key) ?? []), exception]);
  }

  const tasks = [...grouped.entries()].map(([id, reasons]) => {
    const ordered = [...reasons].sort(
      (a, b) => a.priority - b.priority || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
    );
    const first = ordered[0] as ReviewExceptionProjection;
    return {
      id,
      categoryId: categoryFor(ordered),
      sectionId: first.sectionId,
      title: first.title,
      candidateId: first.candidateId,
      page: first.page,
      blocked: ordered.some((reason) => BLOCKED_KINDS.has(reason.kind)),
      reasons: ordered,
    } satisfies ReviewExceptionTask;
  });

  const categories = CATEGORY_DEFINITIONS.map((definition) => {
    const categoryTasks = tasks
      .filter((task) => task.categoryId === definition.id)
      .sort(
        (a, b) =>
          Number(a.blocked) - Number(b.blocked) ||
          (a.reasons[0]?.priority ?? 2) - (b.reasons[0]?.priority ?? 2) ||
          a.title.localeCompare(b.title) ||
          a.id.localeCompare(b.id),
      );
    return {
      ...definition,
      tasks: categoryTasks,
      exceptionCount: categoryTasks.reduce((count, task) => count + task.reasons.length, 0),
      actionableCount: categoryTasks.filter((task) => !task.blocked).length,
      blockedCount: categoryTasks.filter((task) => task.blocked).length,
    } satisfies ReviewExceptionCategory;
  }).filter((category) => category.tasks.length > 0);

  return {
    categories,
    taskCount: tasks.length,
    underlyingExceptionCount: exceptions.length,
    actionableTaskCount: tasks.filter((task) => !task.blocked).length,
    blockedTaskCount: tasks.filter((task) => task.blocked).length,
  };
}
