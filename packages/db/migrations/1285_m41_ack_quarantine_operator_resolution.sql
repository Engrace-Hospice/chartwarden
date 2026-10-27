-- 1285: M41 acknowledgment quarantine - the operator exit (issue #820).
-- `abandoned_operator`: a person closed one unresolved quarantine row through the authenticated route (the only exit for a `malformed`
--                       row, which keeps no event and so has nothing to replay). One m41.claim.ack_abandoned event names the operator.
-- No row is rewritten here. Idempotent.
ALTER TABLE "commercial_ack_quarantine" DROP CONSTRAINT IF EXISTS "commercial_ack_quarantine_resolution_check";--> statement-breakpoint
ALTER TABLE "commercial_ack_quarantine" ADD CONSTRAINT "commercial_ack_quarantine_resolution_check" CHECK ("resolution" IS NULL OR "resolution" IN ('applied','applied_status_inquiry','abandoned_no_submission','abandoned_scope_mismatch','abandoned_vendor_mismatch','abandoned_aged','abandoned_invalid','abandoned_no_event','abandoned_foreign_vendor','abandoned_operator'));
