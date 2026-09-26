// apps/backend/src/modules/10-hope/jobs/correlated-sql.ts — outer-row references for raw correlated
// subqueries, and the one such subquery M10 uses twice (F-086).
//
// THE BUG THIS EXISTS TO PREVENT. `sql`… ${ASSESS.id} …`` renders the column UNQUALIFIED — just `"id"` —
// whenever the enclosing statement has a single table and needs no disambiguation, and QUALIFIED as
// `"hope_assessment"."id"` when it has a join. That difference is invisible at the call site and it
// decides whether a correlated subquery correlates at all, because PostgreSQL resolves a bare column
// name against the INNERMOST scope first — which, inside `(select … from <some table> alias …)`, is the
// subquery's own table.
//
// M10 had the same fragment in two files. In `submission-store.ts` the enclosing select has an
// `innerJoin`, so Drizzle qualified it and it worked. In `assemble-store.ts` it does not, so Drizzle
// emitted:
//
//     exists (select 1 from hope_submission_item i where i.hope_assessment_id = "id" …)
//                                                        └ i.id — `i.hope_assessment_id = i.id`, never true
//     (select o.iqies_record_id from hope_assessment o where o.id = "corrects_assessment_id" …)
//                                                                   └ o.corrects_assessment_id — never non-null
//
// Both are VALID SQL that always answers "no", so there was no error to see: the first made every
// already-batched assessment look un-batched, and the second made every correction look like one whose
// original iQIES never accepted. Two copies of one fragment, one of them wrong, and the only difference
// between them was whether their query happened to have a join. Hence one definition, here.
import { type AnyColumn, type SQL, getTableName, sql } from "drizzle-orm";

/**
 * A FULLY-QUALIFIED `"table"."column"` reference to a row of the OUTER query.
 *
 * Resolved through {@link getTableName} rather than written as a string literal, so a table rename is a
 * compile error rather than a silent `false`.
 */
export function outerColumn(table: Parameters<typeof getTableName>[0], column: AnyColumn): SQL {
  return sql`${sql.identifier(getTableName(table))}.${sql.identifier(column.name)}`;
}

/**
 * D7 — the iQIES record id of the assessment this one CORRECTS, or null.
 *
 * Null for an ordinary first submission and for a correction whose original was never accepted, which is
 * `planCorrectionRfa`'s `skip` branch. Resolved by a self-join on `corrects_assessment_id`: the same
 * table under a different alias, which is exactly the shape that made the unqualified reference resolve
 * to the subquery's own row.
 */
export function correctsIqiesRecordIdSql(
  table: Parameters<typeof getTableName>[0],
  correctsAssessmentId: AnyColumn,
): SQL<string | null> {
  return sql<
    string | null
  >`(select o.iqies_record_id from hope_assessment o where o.id = ${outerColumn(
    table,
    correctsAssessmentId,
  )} limit 1)`;
}
