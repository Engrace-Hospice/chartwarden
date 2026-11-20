-- compat: expand
-- M8 (WF09): the recorded fall a "follow-up after a fall" visit follows up. Both columns are nullable and unused by the previous
-- release, so this is a pure expand.
--
--   fall_incident_id  the M30 incident_report (kind 'fall') the clinician linked while drafting the note. Logical, app-validated
--                     reference like visit_id / face_to_face_encounter_id: incident_report is partitioned with a composite key, so
--                     no foreign key can point at it
--   fall_occurred_on  that incident's org-local date, copied when the link is made. The note states it, and a signed note must keep
--                     saying the same thing whatever happens to the incident report afterwards, so it is a snapshot, not a join
--
-- No new table, so the existing encounter RLS policy and trg_audit_encounter cover the new columns.
ALTER TABLE "encounter" ADD COLUMN "fall_incident_id" uuid;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "fall_occurred_on" date;
