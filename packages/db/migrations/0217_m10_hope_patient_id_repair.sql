-- M10 HOPE — repair `patient_id` values that are actually ADMISSION ids (#45, 2026-08-25).
--
-- `hope_assessment.patient_id` is declared "M5 patient (app-validated; no cross-module FK)": the whole
-- corpus keeps foreign keys inside the owning module, so no `patient_id` outside M5's own tables is
-- constrained and Postgres accepts any uuid. The M10 record path did not keep the app half of that
-- contract — when no `hope_timepoint_schedule` row existed for (admission, RFA) it wrote the
-- `admissionId` into `patient_id`. No production code inserts a schedule row at all, so in a real
-- deployment that fallback is not an edge case: it is the only path, and every HOPE assessment ever
-- recorded through the API names a subject that does not exist in `patient`.
--
-- The corruption propagates once: signing a triggered assessment copies its `patient_id` onto the
-- `symptom_follow_up_visit` row, and completing that SFV copies it back onto the RFA-04 assessment.
-- Both are repaired here from the same authority.
--
-- Detection is exact, not heuristic: the fabricated value is the row's OWN `admission_id`, so
-- `patient_id = admission_id` identifies precisely the rows the defective expression wrote. A correct
-- row can never match — a patient and an admission never share a uuid. Re-running is therefore a no-op.
--
-- `hope_timepoint_schedule` is deliberately NOT repaired: nothing in the codebase inserts one, so it has
-- no rows written by the defective path, and a blind repair there would be speculation, not remediation.
--
-- UNRESOLVABLE ROWS: a row whose `admission_id` matches no `admission` in the same organization cannot
-- be attributed and is LEFT AS IT IS — deleting a CMS-reportable clinical record to tidy a data defect
-- would be worse than leaving it visibly broken. The DO block below RAISEs a WARNING naming the count
-- per table so the operator sees it in the migration output instead of discovering it later. There is no
-- FK to add afterwards (adding one would break the corpus-wide module-boundary convention), so leaving
-- them costs the migration nothing and hides nothing.
--
-- Privilege: like the 0184 backfill this is a cross-organization UPDATE and assumes the migrator role
-- bypasses RLS (superuser / BYPASSRLS). `scripts/db/migrate.ts` provisions roles, so it already does.
-- The write-audit triggers fire normally and record the repair in `audit_event`, which is intended.

UPDATE "hope_assessment" ha
   SET "patient_id" = a."patient_id",
       "updated_at" = now()
  FROM "admission" a
 WHERE ha."patient_id" = ha."admission_id"
   AND a."id" = ha."admission_id"
   AND a."organization_id" = ha."organization_id";--> statement-breakpoint

UPDATE "symptom_follow_up_visit" sfv
   SET "patient_id" = a."patient_id",
       "updated_at" = now()
  FROM "admission" a
 WHERE sfv."patient_id" = sfv."admission_id"
   AND a."id" = sfv."admission_id"
   AND a."organization_id" = sfv."organization_id";--> statement-breakpoint

DO $$
DECLARE
  v_assessments bigint;
  v_sfvs bigint;
BEGIN
  SELECT count(*) INTO v_assessments FROM "hope_assessment" WHERE "patient_id" = "admission_id";
  SELECT count(*) INTO v_sfvs FROM "symptom_follow_up_visit" WHERE "patient_id" = "admission_id";
  IF v_assessments > 0 OR v_sfvs > 0 THEN
    RAISE WARNING
      'M10 #45 repair: % hope_assessment and % symptom_follow_up_visit row(s) still carry an admission id in patient_id — their admission_id matches no admission row in the same organization. Left unchanged; they must be attributed by hand.',
      v_assessments, v_sfvs;
  END IF;
END $$;
