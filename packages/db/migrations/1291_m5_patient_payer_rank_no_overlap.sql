-- 1291: M5 `patient_payer` — one coverage per (organization, patient, rank) on any day (issue #845, audit CW-QA-0001).
-- compat: contract (adds a constraint and repairs rows; the pre-#845 writer, which closed a row ON its successor's start
-- date, is refused by it, so this ships with the new writer)
--
-- `effective_from` / `effective_to` are both INCLUSIVE (the reader's convention, `coverage-intervals.ts`). The pre-#845
-- writer closed a replaced row ON its successor's start date, so both rank-1 rows were in force on the transition day and
-- Medicare claim assembly could pick Medicare while a commercial plan was also recorded as primary. The writer now closes
-- the prior row the day BEFORE; this constraint makes the rule a database invariant, so neither a concurrent replacement
-- nor a direct write can reintroduce the overlap.
--
-- A row whose `effective_to` precedes its `effective_from` is never in force (an empty window). The constraint skips such
-- rows: daterange() cannot even be built from them, and they cannot overlap anything.
--
-- REPAIR FIRST, deterministically: within each (organization_id, patient_id, rank), valid rows are ordered by
-- (effective_from, created_at, id) and any row that overlaps the NEXT one is shrunk to end the day before the next one
-- starts. Each row then ends before its successor starts, so no two valid rows overlap. A row whose successor starts on
-- the same day shrinks to an empty window (no longer in force); its id survives for any claim that stamped it. The update
-- fires the PHI write-audit trigger, so every repaired row leaves an audit_event.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

WITH ordered AS (
  SELECT
    "id",
    "effective_to",
    lead("effective_from") OVER (
      PARTITION BY "organization_id", "patient_id", "rank"
      ORDER BY "effective_from", "created_at", "id"
    ) AS "next_from"
  FROM "patient_payer"
  WHERE "effective_to" IS NULL OR "effective_to" >= "effective_from"
)
UPDATE "patient_payer" p
SET "effective_to" = o."next_from" - 1
FROM ordered o
WHERE p."id" = o."id"
  AND o."next_from" IS NOT NULL
  AND (o."effective_to" IS NULL OR o."effective_to" >= o."next_from");--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "patient_payer" ADD CONSTRAINT "patient_payer_rank_no_overlap" EXCLUDE USING gist (
    "organization_id" WITH =,
    "patient_id" WITH =,
    "rank" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  ) WHERE ("effective_to" IS NULL OR "effective_to" >= "effective_from");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
