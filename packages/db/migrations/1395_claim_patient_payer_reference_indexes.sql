-- compat: expand
-- #874: payer correction/void holds the stable patient row and patient_payer row while it refuses
-- any non-void M23, M24, or M41 claim that stamped the coverage id. Tenant-leading indexes keep those
-- same-transaction existence checks from scanning shared claim tables while the locks are held.
--
-- This repository's migration runner wraps each file in a transaction, so CREATE INDEX CONCURRENTLY
-- is unavailable. IF NOT EXISTS lets an operator pre-build these exact indexes concurrently out of
-- band on a large deployment; the migration then records them without rebuilding.
CREATE INDEX IF NOT EXISTS "claim_org_patient_payer_ix"
  ON "claim" ("organization_id", "patient_payer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_claim_org_patient_payer_ix"
  ON "medicaid_claim" ("organization_id", "patient_payer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_org_primary_patient_payer_ix"
  ON "commercial_claim" ("organization_id", "primary_patient_payer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_org_secondary_patient_payer_ix"
  ON "commercial_claim" ("organization_id", "secondary_patient_payer_id")
  WHERE "secondary_patient_payer_id" IS NOT NULL;
