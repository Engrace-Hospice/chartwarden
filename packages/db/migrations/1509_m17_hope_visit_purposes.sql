-- compat: expand
-- M17: make HOPE Update Visits and Symptom Follow-Up Visits first-class schedulable purposes.
-- Scheduling one of these visits does not create or complete the M10 assessment; M10 remains authoritative.
ALTER TYPE "public"."visit_purpose" ADD VALUE IF NOT EXISTS 'huv1';--> statement-breakpoint
ALTER TYPE "public"."visit_purpose" ADD VALUE IF NOT EXISTS 'huv2';--> statement-breakpoint
ALTER TYPE "public"."visit_purpose" ADD VALUE IF NOT EXISTS 'sfv';
