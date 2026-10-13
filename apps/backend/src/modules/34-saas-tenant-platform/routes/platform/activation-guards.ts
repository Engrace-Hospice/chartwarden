// onboarding → active guards (M34 §2.4.12 / D11) for the lifecycle machine's `activate` event: every canonical
// onboarding task is done/skipped, the latest BAA is executed, and it does not expire within 90 days.
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

interface BaaRow {
  readonly baaStatus: string;
  readonly executedOn: string | null;
  readonly expiresOn: string | null;
}

/**
 * The BAA activation judges: the newest EXECUTED one, else the register's first row (which then fails the guard).
 * The register orders `executed_on DESC`, where Postgres puts NULLs first, so a pending renewal would otherwise win.
 */
export function pickGoverningBaa<T extends BaaRow>(rows: readonly T[]): T | undefined {
  const executed = rows
    .filter((r) => r.baaStatus === "executed" && r.executedOn !== null)
    .sort((a, b) => (b.executedOn as string).localeCompare(a.executedOn as string));
  return executed[0] ?? rows[0];
}

export interface ActivationGuardInput {
  readonly canonicalTemplateKeys: readonly string[];
  readonly tasks: readonly { readonly templateKey: string; readonly status: string }[];
  /** The tenant's most recent BAA record (the register lists newest first), if any. */
  readonly latestBaa: { readonly baaStatus: string; readonly expiresOn: string | null } | undefined;
  readonly today: Date;
}

export interface ActivationGuards {
  readonly canonicalTasksComplete: boolean;
  readonly baaExecuted: boolean;
  readonly baaExpiryClearsNinetyDays: boolean;
  readonly tasksCompleted: number;
  readonly tasksSkipped: number;
}

export function evaluateActivationGuards(input: ActivationGuardInput): ActivationGuards {
  const canonical = new Set(input.canonicalTemplateKeys);
  const canonicalTasks = input.tasks.filter((t) => canonical.has(t.templateKey));
  const settled = new Set(
    canonicalTasks
      .filter((t) => t.status === "done" || t.status === "skipped")
      .map((t) => t.templateKey),
  );
  const baaExecuted = input.latestBaa?.baaStatus === "executed";
  const expiresOn = input.latestBaa?.expiresOn ?? null;
  return {
    canonicalTasksComplete: input.canonicalTemplateKeys.every((key) => settled.has(key)),
    baaExecuted,
    // An absent BAA fails this guard too; a null expiry never expires.
    baaExpiryClearsNinetyDays:
      baaExecuted &&
      (expiresOn === null ||
        new Date(`${expiresOn}T00:00:00Z`).getTime() > input.today.getTime() + NINETY_DAYS_MS),
    tasksCompleted: canonicalTasks.filter((t) => t.status === "done").length,
    tasksSkipped: canonicalTasks.filter((t) => t.status === "skipped").length,
  };
}
