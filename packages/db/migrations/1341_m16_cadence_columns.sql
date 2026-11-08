-- compat: expand
-- ADR-0109 D4 / D9 - three nullable columns on existing M16 tables; no row is rewritten and old code ignores them.
--   * bereavement_outreach.cadence_mark: the cadence-floor mark ('three_month', 'closeout_letter', ...) a row was generated for, so a tier
--     change can top the schedule up idempotently. NULL on rows written before this column; `inferLegacyMark` classifies those.
--   * bereaved_contact.care_goals_cipher: the contact's 1-3 care goals, sealed with the tenant DEK like the other *_cipher columns (the eraser
--     nulls it). Not on the audit denylist for the same reason as email_cipher: it is already unreadable ciphertext.
--   * bereavement_plan_closure.discharge_summary_document_id: the M22 render of the internal discharge summary (logical uuid, like
--     bereavement_summary_document_id; M16 imports no M22 schema).
-- The existing table-level grants (SELECT, INSERT, UPDATE to the app role) cover the new columns.
ALTER TABLE "bereavement_outreach" ADD COLUMN IF NOT EXISTS "cadence_mark" text;--> statement-breakpoint
ALTER TABLE "bereaved_contact" ADD COLUMN IF NOT EXISTS "care_goals_cipher" text;--> statement-breakpoint
ALTER TABLE "bereavement_plan_closure" ADD COLUMN IF NOT EXISTS "discharge_summary_document_id" uuid;
