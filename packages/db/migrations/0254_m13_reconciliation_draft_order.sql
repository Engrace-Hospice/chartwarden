-- M12's live `m13.reconciliation.draft_order_requested` consumer (F-16x, #248): the §2.8 D17 back-reference
-- + an idempotency ledger against redelivery. `medication_order` is PARTITION BY RANGE(created_at), so a
-- direct unique constraint on (organization_id, triggering_reconciliation_decision_id) cannot be created
-- (Postgres requires the partition key in every unique index on a partitioned table — the same reason
-- `dosespot_prescription_id`'s uniqueness is enforced at the app layer, not the DB, per that column's own
-- schema comment) — the ledger table is the M12 `medication_order_idg_decision_application` precedent
-- (migration 0168) applied to the reconciliation handshake instead of the IDG one.
ALTER TABLE "medication_order"
  ADD COLUMN IF NOT EXISTS "triggering_reconciliation_decision_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medication_order_triggering_reconciliation_decision_idx"
  ON "medication_order" ("organization_id", "triggering_reconciliation_decision_id")
  WHERE "triggering_reconciliation_decision_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "medication_order_reconciliation_decision_application" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE restrict,
  "reconciliation_decision_id" uuid NOT NULL,
  "medication_order_id" uuid NOT NULL,
  "applied_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "med_order_recon_application_org_decision_unique"
  ON "medication_order_reconciliation_decision_application" ("organization_id", "reconciliation_decision_id");--> statement-breakpoint
ALTER TABLE "medication_order_reconciliation_decision_application" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "medication_order_reconciliation_decision_application" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medication_order_reconciliation_decision_application_org"
  ON "medication_order_reconciliation_decision_application" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "medication_order_reconciliation_decision_application" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "medication_order_reconciliation_decision_application" TO wardenx_admin;--> statement-breakpoint
CREATE TRIGGER "medication_order_reconciliation_decision_application_audit"
  AFTER INSERT OR UPDATE OR DELETE ON medication_order_reconciliation_decision_application
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
