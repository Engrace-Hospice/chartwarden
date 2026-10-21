/**
 * ChartWarden — row accessors for the seed scripts (F-012 / #34).
 *
 * `scripts/` compiles under the repo's own `noUncheckedIndexedAccess`, which types `result.rows[0]`
 * as `T | undefined`. Across the seed tree there are 37 such reads, and essentially all of them
 * follow an `INSERT … RETURNING` or a `SELECT … LIMIT 1` whose row the script genuinely requires.
 *
 * The tempting fix is `rows[0]!` at each site. That silences the checker without stating anything,
 * and it turns the one case that IS empty — a SELECT that matched nothing because a prior seed step
 * did not run — into `Cannot read properties of undefined`, thrown at whatever line happens to touch
 * a field next. These helpers make the requirement explicit and fail with the query's own name, so a
 * half-run seed chain says which step is missing instead of which property is undefined.
 */

/** Anything `pg`'s `Client.query` returns: only `rows` is needed here. */
interface RowsResult<T> {
  readonly rows: readonly T[];
}

/**
 * The first row, or a thrown error naming `what`.
 *
 * For a query whose row the caller REQUIRES — an `INSERT … RETURNING`, or a lookup the next
 * statement depends on.
 */
export function firstRow<T>(result: RowsResult<T>, what: string): T {
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      `${what}: expected at least one row, got none. In a seed chain this usually means an earlier step did not run — check the order in \`db:seed:all\` (package.json).`,
    );
  }
  return row;
}

/** The first row, or `undefined` — for a lookup that is legitimately allowed to miss. */
export function maybeFirstRow<T>(result: RowsResult<T>): T | undefined {
  return result.rows[0];
}

/**
 * The element at `index`, or a thrown error naming `what`.
 *
 * For the hand-maintained parallel arrays the seeds pair up (patient details beside addresses, and
 * so on), where the invariant is "these two lists are the same length" and nothing states it.
 */
export function requireAt<T>(list: readonly T[], index: number, what: string): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`${what}: no entry at index ${index} (length ${list.length}).`);
  }
  return item;
}
