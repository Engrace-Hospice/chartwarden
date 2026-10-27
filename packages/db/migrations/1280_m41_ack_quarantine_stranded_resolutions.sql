-- 1280: M41 acknowledgment quarantine - explicit end states for stranded held rows (issue #820 follow-up).
-- `abandoned_no_event`      : a scope_mismatch / vendor_mismatch row written BEFORE migration 1279 kept no event, so nothing can ever be
--                             re-applied. The sweep now closes it out loud (an m41.claim.ack_abandoned event) instead of skipping it forever.
-- `abandoned_foreign_vendor`: an operator-driven sweep of a held row that belongs to another clearinghouse's stream than the current
--                             binding, before it ages out on its own. Also an m41.claim.ack_abandoned event.
-- No row is rewritten here: existing rows keep their state until the (audited) sweep reaches them. Idempotent.
ALTER TABLE "commercial_ack_quarantine" DROP CONSTRAINT IF EXISTS "commercial_ack_quarantine_resolution_check";--> statement-breakpoint
ALTER TABLE "commercial_ack_quarantine" ADD CONSTRAINT "commercial_ack_quarantine_resolution_check" CHECK ("resolution" IS NULL OR "resolution" IN ('applied','applied_status_inquiry','abandoned_no_submission','abandoned_scope_mismatch','abandoned_vendor_mismatch','abandoned_aged','abandoned_invalid','abandoned_no_event','abandoned_foreign_vendor'));
