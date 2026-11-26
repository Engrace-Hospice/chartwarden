import type { ReviewExceptionKind, ReviewExceptionProjection } from "./review-exceptions";
import type { ReviewFieldGroupProjection } from "./review-projection";
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
  /** First reason's secondary line (field, value, page); absent for tasks with no single candidate. */
  readonly subject?: string;
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

/** The block of the safeguard panel a task points at. */
export type SafeguardFocus =
  | { readonly kind: "sud" }
  | { readonly kind: "identity"; readonly page: number };

/** Where opening a task leads: a field decision, or the combined safeguard panel. */
export type ReviewTaskTarget =
  | { readonly kind: "candidate"; readonly candidateId: string }
  | {
      readonly kind: "safeguard";
      readonly page: number | null;
      readonly focus: SafeguardFocus | null;
    };

/** What the safeguard panel shows, and the one place that says which of its blocks is current. */
export interface SafeguardSelection {
  readonly page: number | null;
  readonly focus: SafeguardFocus | null;
  /** The priorities row to mark: a block's task, or the task of a safeguard that has no block. */
  readonly taskId: string | null;
  /** True when a person just chose it (scroll to it, focus it); false for a restore or a click inside the panel. */
  readonly reveal: boolean;
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

// Task keys are stable and double as the ids a remembered task is stored under.
export const SUD_TASK_ID = "safeguard:sud";

export function candidateTaskId(candidateId: string): string {
  return `candidate:${candidateId}`;
}

export function identityTaskId(page: number): string {
  return `identity:${page}`;
}

/** The key of the task a safeguard block belongs to. */
export function safeguardTaskId(focus: SafeguardFocus): string {
  return focus.kind === "sud" ? SUD_TASK_ID : identityTaskId(focus.page);
}

function taskKey(exception: ReviewExceptionProjection): string {
  if (exception.kind === "identity-unresolved" || exception.kind === "wrong-patient")
    return exception.page === null ? `identity:${exception.id}` : identityTaskId(exception.page);
  if (exception.kind === "sud-unresolved") return SUD_TASK_ID;
  if (exception.kind === "source-unavailable") return `source:${exception.page ?? exception.id}`;
  if (exception.kind === "review-locked") return "review:locked";
  if (exception.kind === "extraction-unavailable") return exception.id;
  return exception.candidateId ? candidateTaskId(exception.candidateId) : exception.id;
}

/** The task id of a target a reviewer opened, or null when it is not one worth returning to. */
export function targetTaskId(target: ReviewTaskTarget): string | null {
  if (target.kind === "candidate") return candidateTaskId(target.candidateId);
  return target.focus ? safeguardTaskId(target.focus) : null;
}

/**
 * A safeguard task (unresolved SUD, unresolved identity) opens its safeguard block even when it
 * borrowed a candidate id to name a page; that id must never decide where the task leads. Every
 * other task with a candidate opens that candidate, and the rest open the safeguard panel.
 */
export function exceptionTaskTarget(task: ReviewExceptionTask): ReviewTaskTarget {
  const kinds = new Set(task.reasons.map((reason) => reason.kind));
  if (kinds.has("sud-unresolved"))
    return { kind: "safeguard", page: task.page, focus: { kind: "sud" } };
  if (kinds.has("identity-unresolved"))
    return {
      kind: "safeguard",
      page: task.page,
      focus: task.page === null ? null : { kind: "identity", page: task.page },
    };
  if (task.candidateId) return { kind: "candidate", candidateId: task.candidateId };
  return { kind: "safeguard", page: task.page, focus: null };
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
    const subject = ordered.find((reason) => reason.subject)?.subject;
    return {
      id,
      categoryId: categoryFor(ordered),
      sectionId: first.sectionId,
      title: first.title,
      ...(subject ? { subject } : {}),
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
          (a.subject ?? "").localeCompare(b.subject ?? "", "en-US", { numeric: true }) ||
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

/**
 * The tasks the reviewer is working in: the open safeguard's task, or, for an open field, its own task
 * and every task of its group (the group's task is keyed by another observation than the one open).
 */
export function openTaskIds(
  summary: ReviewExceptionSummary,
  groups: readonly ReviewFieldGroupProjection[],
  open: { readonly candidateId: string | null; readonly safeguardTaskId: string | null },
): ReadonlySet<string> {
  const ids = new Set<string>();
  const { candidateId } = open;
  if (candidateId === null) {
    if (open.safeguardTaskId) ids.add(open.safeguardTaskId);
    return ids;
  }
  ids.add(candidateTaskId(candidateId));
  const members = groups.find((group) => group.candidateIds.includes(candidateId))
    ?.candidateIds ?? [candidateId];
  for (const category of summary.categories)
    for (const task of category.tasks)
      if (task.reasons.some((reason) => reason.candidateId && members.includes(reason.candidateId)))
        ids.add(task.id);
  return ids;
}
