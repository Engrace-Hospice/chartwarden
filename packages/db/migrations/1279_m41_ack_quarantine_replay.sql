-- 1279: M41 acknowledgment quarantine - a replay path beyond `no_receipt` (issue #820).
-- 1275 kept the validated event only for `no_receipt`. Now `scope_mismatch` and `vendor_mismatch` keep theirs too, so the pull can re-check
-- them as they stand (never re-routed to another provider entity or vendor) instead of leaving them as a dead letter; `malformed` has
-- nothing valid to keep and stays review-only. A held answer that is asked about (claim status) past the 45-day window and thereby
-- applied is resolved `applied_status_inquiry`. Abandonment itself is now an `m41.claim.ack_abandoned` outbox event (code side).
-- Rows written before this migration have a NULL event for the two mismatch reasons; the replay skips those (nothing to re-apply).
-- Idempotent.
-- 1275 declared both checks inline (Postgres auto-named them), so drop whatever CHECK carries the old definitions, by definition.
DO $do$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'commercial_ack_quarantine'::regclass AND contype = 'c'
       AND (pg_get_constraintdef(oid) LIKE '%jsonb_typeof%' OR pg_get_constraintdef(oid) LIKE '%abandoned_aged%')
  LOOP
    EXECUTE format('ALTER TABLE commercial_ack_quarantine DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$do$;--> statement-breakpoint
ALTER TABLE "commercial_ack_quarantine" ADD CONSTRAINT "commercial_ack_quarantine_event_check" CHECK ("event" IS NULL OR ("reason" IN ('no_receipt','scope_mismatch','vendor_mismatch') AND jsonb_typeof("event") = 'object'));--> statement-breakpoint
ALTER TABLE "commercial_ack_quarantine" ADD CONSTRAINT "commercial_ack_quarantine_resolution_check" CHECK ("resolution" IS NULL OR "resolution" IN ('applied','applied_status_inquiry','abandoned_no_submission','abandoned_scope_mismatch','abandoned_vendor_mismatch','abandoned_aged','abandoned_invalid'));--> statement-breakpoint
DROP INDEX IF EXISTS "commercial_ack_quarantine_held_ix";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_ack_quarantine_held_ix" ON "commercial_ack_quarantine" ("organization_id", "provider_entity_id") WHERE "reason" IN ('no_receipt','scope_mismatch','vendor_mismatch') AND "resolved_at" IS NULL;
