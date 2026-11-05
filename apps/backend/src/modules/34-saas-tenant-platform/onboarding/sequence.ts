// apps/backend/src/modules/34-saas-tenant-platform/onboarding/sequence.ts — the strict-sequence rule (pure).
//
// A step may only be started, completed, attested or skipped when every EARLIER gating step is done or skipped.
// "Gating" = canonical and not optional: an optional step (sample data) and a tenant-added step (non-canonical, never
// part of the activation guard) never lock a later step, but they are themselves subject to the lock. Retired
// templates are never loaded, so they cannot gate. A gating step with no task row counts as unsettled.
//
// Re-opening a settled step does NOT reset later steps: they keep their state, the lock re-applies to any later step
// that is not yet settled, and the activation guard re-checks everything at approval time (see wizard-service.ts).
import { ChartWardenError } from "@chartwarden/types";
import type { StepTask, StepTemplate, TaskStatus } from "./model";

export const isSettled = (status: TaskStatus): boolean => status === "done" || status === "skipped";

const isGating = (t: StepTemplate): boolean => t.canonical && !t.optional;

export function orderedTemplates(templates: readonly StepTemplate[]): StepTemplate[] {
  return [...templates].sort((a, b) => a.sequence - b.sequence);
}

/** Keys the activation guard judges: canonical, non-optional, non-retired (retired are never in `templates`). */
export function gatingTemplateKeys(templates: readonly StepTemplate[]): string[] {
  return orderedTemplates(templates)
    .filter(isGating)
    .map((t) => t.key);
}

/** The first earlier gating step that is not settled, or null when `key` is not locked. */
export function lockedByStep(
  templates: readonly StepTemplate[],
  tasks: readonly StepTask[],
  key: string,
): string | null {
  const statusByKey = new Map(tasks.map((t) => [t.templateKey, t.status]));
  for (const t of orderedTemplates(templates)) {
    if (t.key === key) return null;
    if (!isGating(t)) continue;
    const status = statusByKey.get(t.key);
    if (status === undefined || !isSettled(status)) return t.key;
  }
  return null;
}

/** The first gating step not yet settled (the wizard's "you are here"), or null when every one is. */
export function currentStepKey(
  templates: readonly StepTemplate[],
  tasks: readonly StepTask[],
): string | null {
  const statusByKey = new Map(tasks.map((t) => [t.templateKey, t.status]));
  for (const t of orderedTemplates(templates)) {
    if (!isGating(t)) continue;
    const status = statusByKey.get(t.key);
    if (status === undefined || !isSettled(status)) return t.key;
  }
  return null;
}

/** Throws the typed 409 when an earlier gating step is unsettled. */
export function assertStepActionable(
  templates: readonly StepTemplate[],
  tasks: readonly StepTask[],
  key: string,
): void {
  const blocking = lockedByStep(templates, tasks, key);
  if (blocking === null) return;
  const title = templates.find((t) => t.key === blocking)?.title ?? blocking;
  throw new ChartWardenError(
    "ONBOARDING_STEP_OUT_OF_ORDER",
    `an earlier onboarding step is not finished yet: ${title} (${blocking}). Steps must be completed in order.`,
    409,
    [{ field: "templateKey", code: blocking, message: `${title} must be done or skipped first` }],
  );
}
