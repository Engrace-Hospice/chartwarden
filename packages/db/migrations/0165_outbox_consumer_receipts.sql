-- M1 outbox per-consumer receipts. A partially wired catalog event remains pending, but consumers
-- that have completed are not re-run on each deferred poll or after a process restart.
CREATE TABLE IF NOT EXISTS "outbox_consumer_receipt" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "event_id" uuid NOT NULL,
  "consumer_name" text NOT NULL,
  "consumer_module" text NOT NULL,
  "completed_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "outbox_consumer_receipt_organization_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade,
  CONSTRAINT "outbox_consumer_receipt_event_fk"
    FOREIGN KEY ("event_id") REFERENCES "outbox_event"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outbox_consumer_receipt_event_consumer_uq"
  ON "outbox_consumer_receipt" ("event_id", "consumer_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_consumer_receipt_org_completed_idx"
  ON "outbox_consumer_receipt" ("organization_id", "completed_at");--> statement-breakpoint
ALTER TABLE "outbox_consumer_receipt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox_consumer_receipt" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "outbox_consumer_receipt_org" ON "outbox_consumer_receipt";--> statement-breakpoint
CREATE POLICY "outbox_consumer_receipt_org" ON "outbox_consumer_receipt"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "outbox_consumer_receipt" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "outbox_consumer_receipt" TO wardenx_admin;--> statement-breakpoint
CREATE TRIGGER "outbox_consumer_receipt_audit"
  AFTER INSERT OR UPDATE OR DELETE ON outbox_consumer_receipt
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
