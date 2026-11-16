// apps/backend/src/modules/10-hope/hope-submission-result-writes.ts — the three bulk writes of `importSubmissionResult`.
//
// A Final Validation Report can carry up to MAX_RETAINED_RESULTS rows. The import used to write one UPDATE per item, one
// UPDATE per assessment and one INSERT per report row, all behind the submission row lock (which cancel, mark-uploaded and the
// download advance wait on for at most 5 s, then answer `M10_RECORD_BUSY`), and every statement fired the write-audit
// triggers. Each write here is ONE statement per chunk (BULK_CHUNK_ROWS rows, so the bind-parameter count stays far below
// Postgres' 65535 whatever the report size), with the same rows, columns and values the per-row statements wrote.
//
// LOCK ORDER is unchanged: the submission row (taken by the caller), then the batch's items, then its assessments. The
// assessment update is the named exception to the assessment-row lock (see hope-assessment-lock.ts): it stamps
// `iqies_record_id` and nothing else, under the submission lock.
import { type DbClient, schema } from "@chartwarden/db";
import { ConflictError } from "@chartwarden/types";
import { sql } from "drizzle-orm";
import { SETTLED_ITEM_STATUSES } from "./hope-submission-result";

const SUBITEM = schema.hopeSubmissionItems;
const ASSESS = schema.hopeAssessments;
const RESULT = schema.hopeSubmissionResultEvents;

/** Rows per statement: the widest row (a result event) binds 13 values, so a chunk binds about 6500 of the 65535 allowed. */
export const BULK_CHUNK_ROWS = 500;

/** One item's CMS verdict: its status, the record id to store (the report's, else what the item already had) and the raw row. */
export interface ItemOutcome {
  readonly itemId: string;
  readonly status: string;
  readonly iqiesRecordId: string | null;
  readonly result: Record<string, unknown>;
}

export type ResultEventRow = typeof RESULT.$inferInsert;

const chunksOf = <T>(rows: readonly T[]): T[][] => {
  const chunks: T[][] = [];
  for (let from = 0; from < rows.length; from += BULK_CHUNK_ROWS) {
    chunks.push(rows.slice(from, from + BULK_CHUNK_ROWS));
  }
  return chunks;
};

/**
 * Store the verdicts on the items of ONE batch. Both predicates are explicit on top of the row lock and RLS: the item belongs
 * to this organization and batch, and is not settled (a CMS verdict is final: the caller never sends a settled item, and this
 * keeps a settled one from being rewritten whatever the caller sends). The statement RETURNS the ids it updated and their count
 * must equal the outcomes sent: a predicate that misses (an item gone, settled or moved meanwhile) would otherwise leave fewer
 * items stored than the batch status the caller derives from `finalStatus` assumes. A mismatch throws a 409 that names no id or
 * value, and the transaction rolls back, so nothing of the import is kept.
 */
export async function writeItemOutcomes(
  t: DbClient,
  organizationId: string,
  submissionId: string,
  outcomes: readonly ItemOutcome[],
  now: Date,
): Promise<void> {
  for (const rows of chunksOf(outcomes)) {
    const values = sql.join(
      rows.map(
        (o) =>
          sql`(${o.itemId}::uuid, ${o.status}::hope_submission_item_status, ${o.iqiesRecordId}::text, ${JSON.stringify(o.result)}::jsonb)`,
      ),
      sql`, `,
    );
    const updated = await t.execute(sql`
      UPDATE ${SUBITEM} AS i
         SET item_status = v.item_status,
             iqies_record_id = v.iqies_record_id,
             iqies_validation_result = v.iqies_validation_result,
             processed_at = ${now.toISOString()}::timestamptz,
             updated_at = ${now.toISOString()}::timestamptz
        FROM (VALUES ${values}) AS v(id, item_status, iqies_record_id, iqies_validation_result)
       WHERE i.id = v.id
         AND i.organization_id = ${organizationId}::uuid
         AND i.hope_submission_id = ${submissionId}::uuid
         AND i.item_status NOT IN (${sql.join(
           SETTLED_ITEM_STATUSES.map((status) => sql`${status}::hope_submission_item_status`),
           sql`, `,
         )})
       RETURNING i.id`);
    if (updated.rows.length !== rows.length) {
      throw new ConflictError(
        "The batch's items changed while the result was being recorded, so nothing was saved. Reload the batch and record the result again.",
      );
    }
  }
}

/**
 * Stamp the accepted records' iQIES ids on their assessments (`assessment id -> record id`, one entry per assessment: the
 * caller keeps the last, as the sequential updates did). Only `iqies_record_id` and `updated_at` change.
 */
export async function stampAssessmentRecordIds(
  t: DbClient,
  organizationId: string,
  stamps: ReadonlyMap<string, string>,
  now: Date,
): Promise<void> {
  for (const rows of chunksOf([...stamps])) {
    const values = sql.join(
      rows.map(([assessmentId, recordId]) => sql`(${assessmentId}::uuid, ${recordId}::text)`),
      sql`, `,
    );
    await t.execute(sql`
      UPDATE ${ASSESS} AS a
         SET iqies_record_id = v.iqies_record_id,
             updated_at = ${now.toISOString()}::timestamptz
        FROM (VALUES ${values}) AS v(id, iqies_record_id)
       WHERE a.id = v.id
         AND a.organization_id = ${organizationId}::uuid`);
  }
}

/** Append the report rows (the audit trail of what CMS said). A row already stored for this report is skipped, as before. */
export async function insertResultEvents(
  t: DbClient,
  rows: readonly ResultEventRow[],
): Promise<void> {
  for (const chunk of chunksOf(rows)) {
    await t.insert(RESULT).values(chunk).onConflictDoNothing();
  }
}
