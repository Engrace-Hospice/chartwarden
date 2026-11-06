// @chartwarden/shared/route-kit — small database-result helpers every service-db file re-wrote.
// A driver error is wrapped by Drizzle (`DrizzleQueryError`, `.cause`) and sometimes once more by a
// repository, so the cause chain is walked. The raw error is never logged here: its message embeds the
// bound parameters (PHI).
import { ChartWardenError } from "@chartwarden/types";

const PG_UNIQUE_VIOLATION = "23505";
const MAX_CAUSE_DEPTH = 6;

/** The constraint a Postgres unique violation names, walking the cause chain; null for any other error. */
export function uniqueViolationConstraint(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    const { code, constraint } = current as { code?: unknown; constraint?: unknown };
    if (code === PG_UNIQUE_VIOLATION) return typeof constraint === "string" ? constraint : "";
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** A Postgres unique violation anywhere in the cause chain (optionally on one named constraint). */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const violated = uniqueViolationConstraint(err);
  return violated !== null && (constraint === undefined || violated === constraint);
}

/** The domain error for a unique violation on one of `byConstraint`'s constraints, else `err` itself. */
export function mapUniqueViolation(
  err: unknown,
  byConstraint: Readonly<Record<string, () => Error>>,
): unknown {
  const constraint = uniqueViolationConstraint(err);
  const toError = constraint ? byConstraint[constraint] : undefined;
  return toError ? toError() : err;
}

/**
 * The first row of a `RETURNING`/`SELECT`. Empty is `onEmpty()` when given, otherwise a 500 (the row was
 * just written, so its absence is a bug, not a client error).
 */
export function firstOrThrow<T>(
  rows: readonly T[],
  message: string,
  onEmpty?: () => Error,
): T {
  const row = rows[0];
  if (row !== undefined) return row;
  throw onEmpty ? onEmpty() : new ChartWardenError("INTERNAL_ERROR", message, 500);
}
