-- M36 WP 3.10 - medication-clarification flow (ADR-0067). One column on communication_task, no new table: it fills the
-- source_kind column ADR-0061 D2 reserved. 'message' is every task made by converting a message (WP 3.4); 'medication_question'
-- is a task made by the "Ask a nurse about a medication" entry. The database refuses to assign a medication-question task to
-- the person who asked it (insert, manual reassign, offboarding and handoff acceptance alike), so a question can never route
-- back to the aide who raised it. The column is deliberately NOT in wardenx_app's column-level UPDATE grant (migration 1100):
-- a task's kind is fixed at birth. Non-PHI (an enum); the audit trigger is unchanged.

ALTER TABLE "communication_task" ADD COLUMN "source_kind" text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE "communication_task" ADD CONSTRAINT "communication_task_source_kind_shape"
  CHECK ("source_kind" IN ('message', 'medication_question'));--> statement-breakpoint
ALTER TABLE "communication_task" ADD CONSTRAINT "communication_task_medq_not_creator"
  CHECK ("source_kind" <> 'medication_question' OR "assignee_id" <> "created_by");--> statement-breakpoint
CREATE INDEX "communication_task_medq_idx" ON "communication_task" ("organization_id", "message_id", "created_by")
  WHERE "source_kind" = 'medication_question';
