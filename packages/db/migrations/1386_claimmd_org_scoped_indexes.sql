-- compat: expand
-- Org-leading indexes for the four Claim.MD tables that arch:org-indexes flags (shape and reasoning:
-- 0207_org_scoped_rls_indexes.sql). Every statement against them carries the RLS predicate
-- organization_id = current_setting('app.org_id')::uuid; without an index leading on organization_id the planner
-- cannot prune by tenant. Each pairs organization_id with the table's own event time.
CREATE INDEX IF NOT EXISTS claimmd_era_delivery_org_ix ON claimmd_era_delivery (organization_id, prepared_at);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS claimmd_era_resolution_history_org_ix ON claimmd_era_resolution_history (organization_id, created_at);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS claimmd_notice_receipt_observation_org_ix ON claimmd_notice_receipt_observation (organization_id, observed_at);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS claimmd_response_resolution_history_org_ix ON claimmd_response_resolution_history (organization_id, created_at);
