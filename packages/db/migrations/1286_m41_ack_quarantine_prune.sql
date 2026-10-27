-- 1286: M41 acknowledgment quarantine retention (issue #824). The weekly prune job deletes RESOLVED rows older than its horizon.
-- The app role had SELECT/INSERT and a column-limited UPDATE only; grant DELETE (RLS still confines it to the caller's organization) and
-- refuse an unresolved delete in the database, so a bug in the job can never drop a row still held for replay or review.
GRANT DELETE ON "commercial_ack_quarantine" TO chartwarden_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION commercial_ack_quarantine_guard_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.resolved_at IS NULL AND current_user = 'chartwarden_app' THEN
    RAISE EXCEPTION 'commercial_ack_quarantine: an unresolved row cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_commercial_ack_quarantine_guard_delete" ON "commercial_ack_quarantine";--> statement-breakpoint
CREATE TRIGGER "trg_commercial_ack_quarantine_guard_delete" BEFORE DELETE ON "commercial_ack_quarantine" FOR EACH ROW EXECUTE FUNCTION commercial_ack_quarantine_guard_delete();
