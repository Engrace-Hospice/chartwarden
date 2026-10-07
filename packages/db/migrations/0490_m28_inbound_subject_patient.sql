-- GAP-198 — M28 §4.7 `fhir_inbound_owner_module_match` must also compose `caseload_or_scope` on the
-- proposal's patient, but `fhir_inbound_resource` carried no patient reference (the subject lives inside
-- the §3.6-denylisted `payload`). `subject_patient_id` is stamped at STAGING from the resource itself
-- (MedicationStatement.subject.reference = Patient/<uuid>; Patient.id when it is a WardenX uuid) so the
-- decision-time gate never opens the payload.
--
-- NULL means "no resolvable chart": legitimate only for a brand-new Patient proposal (intake); for a
-- MedicationStatement the predicate treats NULL as DENY (fail closed).
--
-- Declared on the PARTITIONED PARENT; ADD COLUMN propagates to every partition. Logical uuid (no FK):
-- the patient table is M5-owned and the proposal outlives chart merges/erasure, like the sibling
-- source_client_id / accepted_aggregate_id.
ALTER TABLE "fhir_inbound_resource" ADD COLUMN IF NOT EXISTS "subject_patient_id" uuid;--> statement-breakpoint

-- Backfill existing rows from the still-present payload. A shredded payload (destroyed sentinel) has
-- neither key, so it stays NULL — those proposals are terminal and no longer reviewable anyway.
UPDATE "fhir_inbound_resource"
SET "subject_patient_id" = lower(
  CASE "resource_type"
    WHEN 'Patient' THEN "payload" ->> 'id'
    WHEN 'MedicationStatement' THEN substring("payload" -> 'subject' ->> 'reference' FROM '^Patient/(.+)$')
  END
)::uuid
WHERE "subject_patient_id" IS NULL
  AND "resource_type" IN ('Patient', 'MedicationStatement')
  AND CASE "resource_type"
        WHEN 'Patient' THEN "payload" ->> 'id'
        WHEN 'MedicationStatement' THEN substring("payload" -> 'subject' ->> 'reference' FROM '^Patient/(.+)$')
      END ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "fhir_inbound_subject_patient_idx"
  ON "fhir_inbound_resource" ("organization_id", "subject_patient_id");
