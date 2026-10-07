// apps/backend/src/modules/25-remittance/routes/scope.ts — M25 provider-entity read scoping (GAP-148).
//
// The SQL condition that narrows a read to the actor's SERVER-derived provider-entity scope. Pure (a column and
// a scope in, an SQL fragment out) so the fail-closed rules are unit-tested without a database:
//   * scope `undefined`  — unrestricted (org-wide oversight role / service principal): only the caller's
//                          optional filter applies;
//   * scope `[...]`      — narrowed to exactly those entities; a requested entity outside it matches NOTHING;
//   * scope `[]`         — matches nothing (fail-closed).
// An out-of-scope row therefore reads as ABSENT (a 404 from the by-id reads), never as forbidden.
import { type SQL, eq, inArray, sql } from "drizzle-orm";

type ScopedColumn = Parameters<typeof eq>[0];

export function providerEntityScopeCondition(
  column: ScopedColumn,
  scope: readonly string[] | undefined,
  requested?: string,
): SQL | undefined {
  if (scope === undefined) return requested ? eq(column, requested) : undefined;
  if (requested) return scope.includes(requested) ? eq(column, requested) : sql`false`;
  return scope.length > 0 ? inArray(column, [...scope]) : sql`false`;
}
