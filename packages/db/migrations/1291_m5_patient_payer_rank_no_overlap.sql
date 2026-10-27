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
--
-- VISIBILITY: every repaired row a claim already references (M23 `claim.patient_payer_id`, M24
-- `medicaid_claim.patient_payer_id`, M41 `commercial_claim.primary_/secondary_patient_payer_id`) is reported with a NOTICE
-- (row id, org, old -> new dates, claim ids; no PHI), plus a total. It does not block: those claims keep resolving the row
-- by id. Production is demo data and is reseeded rather than remediated by script.
--
-- MIGRATOR ROLE: patient_payer has FORCEd org RLS, so this must run as the DATABASE_ADMIN_URL role (superuser /
-- BYPASSRLS), like 1151; under an RLS-subject role the repair would silently see zero rows, so the guard fails loudly.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'migration 1291 must run as a superuser / BYPASSRLS role (DATABASE_ADMIN_URL): patient_payer has FORCEd RLS, so % could not repair every tenant', current_user;
  END IF;
END $$;--> statement-breakpoint

CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

DO $$
DECLARE
  r record;
  claim_ids text;
  repaired int := 0;
  claim_referenced int := 0;
BEGIN
  FOR r IN
    WITH ordered AS (
      SELECT
        "id",
        "organization_id",
        "effective_from",
        "effective_to",
        lead("effective_from") OVER (
          PARTITION BY "organization_id", "patient_id", "rank"
          ORDER BY "effective_from", "created_at", "id"
        ) AS "next_from"
      FROM "patient_payer"
      WHERE "effective_to" IS NULL OR "effective_to" >= "effective_from"
    )
    SELECT * FROM ordered
    WHERE "next_from" IS NOT NULL AND ("effective_to" IS NULL OR "effective_to" >= "next_from")
    ORDER BY "organization_id", "id"
  LOOP
    SELECT string_agg(ref, ', ') INTO claim_ids FROM (
      SELECT 'm23:' || c."id" AS ref FROM "claim" c
        WHERE c."patient_payer_id" = r."id" AND c."organization_id" = r."organization_id"
      UNION ALL
      SELECT 'm24:' || m."id" FROM "medicaid_claim" m
        WHERE m."patient_payer_id" = r."id" AND m."organization_id" = r."organization_id"
      UNION ALL
      SELECT 'm41:' || k."id" FROM "commercial_claim" k
        WHERE r."id" IN (k."primary_patient_payer_id", k."secondary_patient_payer_id")
          AND k."organization_id" = r."organization_id"
    ) refs;
    IF claim_ids IS NOT NULL THEN
      claim_referenced := claim_referenced + 1;
      RAISE NOTICE '1291 repair: patient_payer % (org %) % .. % -> % .. %, referenced by claims %',
        r."id", r."organization_id", r."effective_from", coalesce(r."effective_to"::text, 'open'),
        r."effective_from", r."next_from" - 1, claim_ids;
    END IF;
    UPDATE "patient_payer" SET "effective_to" = r."next_from" - 1 WHERE "id" = r."id";
    repaired := repaired + 1;
  END LOOP;
  RAISE NOTICE '1291 repair: % patient_payer row(s) shrunk, % of them referenced by a claim', repaired, claim_referenced;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "patient_payer" ADD CONSTRAINT "patient_payer_rank_no_overlap" EXCLUDE USING gist (
    "organization_id" WITH =,
    "patient_id" WITH =,
    "rank" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  ) WHERE ("effective_to" IS NULL OR "effective_to" >= "effective_from");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
