-- compat: expand
-- Tenant-first index for claimmd_era_match_decision (migration 1394), which shipped with only a
-- (stage_id, ...) index. `arch:org-indexes` requires organization_id in the first two key columns of
-- some index on every org-scoped table: every statement here carries the RLS predicate
-- organization_id = current_setting('app.org_id'), and the planner cannot prune by tenant without one.
-- Same shape as 0207_org_scoped_rls_indexes.sql: (organization_id, <event time>); created_at is the
-- table's only timestamp and the review queries order by it. Additive and idempotent, nothing is rewritten.
CREATE INDEX IF NOT EXISTS "claimmd_era_match_decision_org_ix" ON "claimmd_era_match_decision" ("organization_id", "created_at");
