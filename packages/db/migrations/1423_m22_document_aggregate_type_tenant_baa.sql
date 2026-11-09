-- compat: expand
-- M22 `document_aggregate_type` - the signed business associate agreement between ChartWarden and a tenant, filed at onboarding step 3.
-- A platform operator uploads it for the tenant (the one document kind the `tenant_baa_document.upload_platform` key admits, migration
-- 1424); the BAA register row then links it by id. Additive only. Own migration: PG forbids using a value added earlier in the same
-- transaction, so this stands alone ahead of any migration that reads or writes it (the 1109 / 1174 precedent). Idempotent.
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'tenant_baa';
