-- compat: expand
-- Supporting indexes for two foreign keys the live FK-coverage suite (GAP-178, 0480) flags. Neither existing index
-- LEADS with the FK's columns: patient_code_status_patient_idx starts with organization_id, and
-- message_emergency_recipient_unique starts with emergency_id (usable for the cascade lookup, but not a leading match
-- for the FK, which the suite requires); the code-status FK is checked on every patient delete.
-- Plain builds and IF NOT EXISTS, like 0480.
CREATE INDEX IF NOT EXISTS "patient_code_status_patient_id_fk_idx" ON "patient_code_status" ("patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_emergency_recipient_emergency_fk_idx" ON "message_emergency_recipient" ("organization_id", "emergency_id");
