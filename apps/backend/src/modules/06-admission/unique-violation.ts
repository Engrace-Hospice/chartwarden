// apps/backend/src/modules/06-admission/unique-violation.ts — the backstop behind M6's explicit conflict
// pre-checks. A pre-check inside the transaction answers the common case with a precise M6 code; two
// concurrent writers can still both pass it, and the loser then hits the unique index. Postgres reports
// that as `23505` carrying the constraint name, wrapped by Drizzle in a `DrizzleQueryError` (`.cause`), and
// unmapped it reached the caller as `500 INTERNAL_ERROR`. This maps the named constraint to the same
// domain error the pre-check throws. Anything else is returned untouched.
//
// The raw error is never logged here: a DrizzleQueryError's message embeds the bound parameters (PHI).

/** Postgres `unique_violation`. */
const PG_UNIQUE_VIOLATION = "23505";
/** Drizzle wraps once; a repository may wrap once more. */
const MAX_CAUSE_DEPTH = 5;

/** The constraint a `23505` names, walking the `.cause` chain; null for any other error. */
export function uniqueViolationConstraint(err: unknown): string | null {
  let cursor: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cursor instanceof Error; depth++) {
    const { code, constraint } = cursor as { code?: unknown; constraint?: unknown };
    if (code === PG_UNIQUE_VIOLATION) return typeof constraint === "string" ? constraint : null;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return null;
}

/** The domain error for a unique violation on one of `byConstraint`'s constraints, else `err` itself. */
export function mapUniqueViolation(
  err: unknown,
  byConstraint: Readonly<Record<string, () => Error>>,
): unknown {
  const constraint = uniqueViolationConstraint(err);
  const toError = constraint === null ? undefined : byConstraint[constraint];
  return toError ? toError() : err;
}
