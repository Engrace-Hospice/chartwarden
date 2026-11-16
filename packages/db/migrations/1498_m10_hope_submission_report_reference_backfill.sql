-- compat: expand
-- M10 HOPE - fill `hope_submission.report_reference` (added by 1496) for the batches a result was already recorded for.
-- It is its own file, after 1497, on purpose: the runner executes a file in one transaction, and this UPDATE fires the
-- write-audit trigger on every row it touches. Before 1497 that trigger converted the whole row (`to_jsonb(OLD)` and
-- `to_jsonb(NEW)`), detoasting the multi-MB `acceptance_report` (the package ZIP as base64) two to four times per row, all
-- while this transaction held the row locks. From 1497 on the trigger never reads the package column.
-- The reference is read from `acceptance_report->>'reportReference'`, which detoasts that whole jsonb value, so it is computed
-- ONCE per batch: in a MATERIALIZED CTE (an optimisation fence: left inline, the planner would evaluate the same expression
-- again in the WHERE and in the SET). That is the single read of the package per batch, and only for batches a result was
-- recorded for (`result_imported_at`; the reference is written only by that import, so a packaged or cancelled batch has none
-- and its ZIP is not read). The UPDATE rewrites the row but not the TOASTed package: the pointer is carried over.
-- Replay-safe: it never overwrites a value (`report_reference IS NULL`) and `updated_at` is not touched, so running it again
-- changes nothing. The ledger runs a file once, though: a result recorded after this file by a release that does not know the
-- column writes the jsonb copy only, and that batch keeps a NULL `report_reference` (shown as no reference) until its next result
-- import writes both (see 1496).
-- The audit rows this UPDATE writes show `report_reference` as `"<changed>"` (1497 scrubs it).
WITH recorded AS MATERIALIZED (
  SELECT "id", "acceptance_report"->>'reportReference' AS "reference"
    FROM "hope_submission"
   WHERE "result_imported_at" IS NOT NULL
     AND "report_reference" IS NULL
)
UPDATE "hope_submission" AS h
   SET "report_reference" = recorded."reference"
  FROM recorded
 WHERE h."id" = recorded."id"
   AND h."report_reference" IS NULL
   AND recorded."reference" IS NOT NULL;
