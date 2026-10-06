-- M15 §7.6 / M15-F04 — persist the 418.78(e) hour-ratio DENOMINATOR on the existing `volunteer_hour_ledger`
-- row. The nightly hour aggregator now computes the staff patient-care minutes ONCE per (provider entity ×
-- fiscal year) from M8's signed-encounter digests (SignedEncountersReader seam) and stamps the result here;
-- the read paths (getVolunteerHourRatio, DisciplineComplianceProvider.volunteerHourCostRatio) read the
-- persisted value instead of looping one seam call per patient at request time.
--
--   patient_care_minutes             NULL = never computed, OR computed with no resolved-duration visit
--                                    (patient_care_computed_at disambiguates).
--   patient_care_visits_counted      qualifying signed visits whose duration resolved (in the sum).
--   patient_care_visits_unresolved   qualifying signed visits with a null duration — EXCLUDED, never 0.
--   patient_care_computed_at         when the aggregator last computed it (read path flags >48h as stale).
--
-- Additive, nullable, no default; aggregate counters only (no PHI, no patient reference). The existing org RLS
-- policy, FORCE RLS and write-audit trigger cover the new columns.
ALTER TABLE "volunteer_hour_ledger" ADD COLUMN IF NOT EXISTS "patient_care_minutes" bigint;--> statement-breakpoint
ALTER TABLE "volunteer_hour_ledger" ADD COLUMN IF NOT EXISTS "patient_care_visits_counted" integer;--> statement-breakpoint
ALTER TABLE "volunteer_hour_ledger" ADD COLUMN IF NOT EXISTS "patient_care_visits_unresolved" integer;--> statement-breakpoint
ALTER TABLE "volunteer_hour_ledger" ADD COLUMN IF NOT EXISTS "patient_care_computed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "volunteer_hour_ledger" DROP CONSTRAINT IF EXISTS "volunteer_hour_ledger_patient_care_ck";--> statement-breakpoint
ALTER TABLE "volunteer_hour_ledger" ADD CONSTRAINT "volunteer_hour_ledger_patient_care_ck"
  CHECK (
    (patient_care_minutes IS NULL OR patient_care_minutes >= 0)
    AND (patient_care_visits_counted IS NULL OR patient_care_visits_counted >= 0)
    AND (patient_care_visits_unresolved IS NULL OR patient_care_visits_unresolved >= 0)
  );
