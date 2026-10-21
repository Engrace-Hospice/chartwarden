// @chartwarden/reporting — translator step 3: compile `filters[]` into a PARAMETERIZED WHERE fragment
// (M33 §4.2, D4).
//
// Every filter becomes a predicate against a WHITELISTED column (`t."<dimensionKey>"`, asserted present
// in the base catalog) with each tenant VALUE bound as a `$n` placeholder — never string-interpolated.
// This is the zero-SQL-injection-surface guarantee: the only thing that reaches the SQL TEXT from a
// filter is the (catalog-validated, regex-guarded) column identifier; the values travel in the params
// array. The semantic legality of each comparator/value was already proven by `spec-validator.ts`; this
// step re-asserts column membership as defense-in-depth and lays down the bound placeholders.
import type { schema } from "@chartwarden/db";
import { ReportTranslatorError, quoteIdent } from "./spec-validator";

/** SQL operator text per scalar comparator. `le`/`ge`/`ne` map to their SQL spellings. */
const SCALAR_OP: Readonly<Record<string, string>> = {
  eq: "=",
  ne: "<>",
  lt: "<",
  le: "<=",
  gt: ">",
  ge: ">=",
};

/** A compiled WHERE fragment: the predicate text (no leading `WHERE`), its bound params, and the next
 * free placeholder index so the caller can chain the scope predicate + LIMIT after it. */
export interface CompiledWhere {
  /** Predicate text joined by ` AND `, or "" when there are no filters. */
  readonly sql: string;
  /** The bound values, in `$startIndex … $nextIndex-1` order. */
  readonly params: schema.FilterValue[];
  /** The next free `$n` index after this fragment's params. */
  readonly nextIndex: number;
}

/** The relation alias the MV wrapper function is given in the FROM clause (`… AS t`). */
export const REL_ALIAS = "t";

function col(
  dimensionKey: string,
  allowed: ReadonlyMap<string, schema.DimensionCatalog["dataType"]>,
): string {
  // WHITELIST: a filter may only ever reference a dimension the base catalog publishes. Post
  // spec-validation this cannot fail; we re-assert so a translator bug fails closed, never open.
  if (!allowed.has(dimensionKey)) {
    throw new ReportTranslatorError(
      "COLUMN_NOT_WHITELISTED",
      `Filter references non-whitelisted column "${dimensionKey}".`,
    );
  }
  return `${REL_ALIAS}.${quoteIdent(dimensionKey)}`;
}

/**
 * Compiles `filters[]` into a parameterized predicate. `allowed` is the base's dimension whitelist
 * (`dimensionKey → dataType`); `startIndex` is the first `$n` placeholder to use (the SQL step reserves
 * `$1` for the MV wrapper's `p_org_id`, so filters typically start at `$2`).
 *
 * Pure. Returns `{ sql, params, nextIndex }`. NEVER returns interpolated values.
 */
export function compileFilters(
  filters: readonly schema.ReportFilter[],
  allowed: ReadonlyMap<string, schema.DimensionCatalog["dataType"]>,
  startIndex = 1,
): CompiledWhere {
  const clauses: string[] = [];
  const params: schema.FilterValue[] = [];
  let idx = startIndex;

  for (const f of filters) {
    const c = col(f.dimensionKey, allowed);

    switch (f.comparator) {
      case "is_null":
        clauses.push(`${c} IS NULL`);
        break;
      case "is_not_null":
        clauses.push(`${c} IS NOT NULL`);
        break;
      case "in":
      case "not_in": {
        const arr = f.value as readonly (string | number)[];
        const placeholders = arr.map(() => `$${idx++}`);
        for (const v of arr) params.push(v);
        const op = f.comparator === "in" ? "IN" : "NOT IN";
        clauses.push(`${c} ${op} (${placeholders.join(", ")})`);
        break;
      }
      case "between": {
        const [lo, hi] = f.value as [string, string];
        clauses.push(`${c} BETWEEN $${idx++} AND $${idx++}`);
        params.push(lo, hi);
        break;
      }
      default: {
        // eq/ne/lt/le/gt/ge — a single bound scalar.
        const op = SCALAR_OP[f.comparator];
        if (op === undefined) {
          throw new ReportTranslatorError(
            "FILTER_TYPE_MISMATCH",
            `Unknown comparator "${f.comparator}".`,
          );
        }
        clauses.push(`${c} ${op} $${idx++}`);
        params.push(f.value as string | number | boolean);
        break;
      }
    }
  }

  return { sql: clauses.join(" AND "), params, nextIndex: idx };
}
