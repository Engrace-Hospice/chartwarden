-- compat: expand
-- M34 - the platform BAA register is written on the platform carrier, which held only SELECT and DELETE on
-- platform_tenant_baa_record (the read list and the offboarding eraser). POST /api/v1/platform/baa-register and
-- PATCH /api/v1/platform/baa-register/:id therefore failed with 42501 on the real platform pool, and every tenant stayed
-- blocked at the `baa_executed` step. The inject tests run as a superuser and could not see it.
--
-- WHO WROTE IT. Two nullable columns record the user who filed a record and the user who last changed it. Go-live approval
-- refuses an approver who wrote the governing BAA (409 GO_LIVE_APPROVER_WROTE_BAA): the BAA guard must not rest on one
-- operator who both recorded the agreement and approved the go-live that depends on it. Rows written before this migration
-- carry NULL and cannot be judged; the M4 row-audit trigger still names the writer of every change.
--
-- The narrowest grant that makes the two routes work, and no more:
--   INSERT (cols)  the create route files a row: the tenant and organisation it belongs to, the addendum version, status, the
--                  three dates, the two breach contacts, the executed document and who filed it. The column list leaves out the
--                  subcontractor disclosure set and the tenant compliance officer's attestation (compliance_officer_attestation_
--                  membership_id / attested_at): that attestation is the tenant's own statement. The repository's insert names
--                  exactly these columns (Drizzle would otherwise list every column with DEFAULT, which needs privilege on each).
--   UPDATE (cols)  the PATCH route changes status, the three dates, the two breach contacts, the document link and who last
--                  changed it. It can never rewrite which tenant or organisation a row belongs to, its addendum version, who
--                  filed it, the subcontractor disclosure set, or the tenant compliance officer's attestation.
-- The carrier held no INSERT or UPDATE here before, so nothing is revoked (which also keeps this `expand`: arch:migration-compat
-- reads a REVOKE as contracting). The carrier exists only where scripts/db/provision-runtime-roles.ts has run, and that script
-- re-grants the same on every run, REVOKE-ing first so a re-provision also takes back any table-wide grant (both must agree).
ALTER TABLE "platform_tenant_baa_record" ADD COLUMN IF NOT EXISTS "recorded_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "platform_tenant_baa_record" ADD COLUMN IF NOT EXISTS "updated_by_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    GRANT INSERT ("organization_id", "tenant_account_id", "addendum_version", "baa_status", "executed_on", "effective_on", "expires_on", "breach_notification_contact_email", "breach_notification_contact_phone", "document_id", "recorded_by_user_id") ON "platform_tenant_baa_record" TO chartwarden_platform;
    GRANT UPDATE ("baa_status", "executed_on", "effective_on", "expires_on", "breach_notification_contact_email", "breach_notification_contact_phone", "document_id", "updated_by_user_id") ON "platform_tenant_baa_record" TO chartwarden_platform;
  END IF;
END $$;
