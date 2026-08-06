-- M1 §4.8 worker consumer-idempotency ledger (WX-PR-014). Every M30-style BullMQ worker opens its
-- process() with an already_processed short-circuit against this table before applying any effect, so a
-- job replayed from the DLQ (or re-delivered after a crash before its ack) never double-applies. Keyed
-- directly on the BullMQ job id — a lookup/insert by exact job_id, never a cross-job scan, so no PE/
-- location three-column requirement (no PHI here either).
CREATE TABLE IF NOT EXISTS "processing_log" (
  "job_id" text PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "queue_name" text NOT NULL,
  "outcome" jsonb NOT NULL,
  "processed_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "processing_log_organization_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "processing_log_org_processed_idx"
  ON "processing_log" ("organization_id", "processed_at");--> statement-breakpoint
ALTER TABLE "processing_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "processing_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "processing_log_org" ON "processing_log";--> statement-breakpoint
CREATE POLICY "processing_log_org" ON "processing_log"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "processing_log" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "processing_log" TO wardenx_admin;--> statement-breakpoint
CREATE TRIGGER "processing_log_audit"
  AFTER INSERT OR UPDATE OR DELETE ON processing_log
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
