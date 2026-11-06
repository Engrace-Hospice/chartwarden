-- compat: expand
-- M34 - the platform BAA register is written on the platform carrier, which held only SELECT and DELETE on
-- platform_tenant_baa_record (the read list and the offboarding eraser). POST /api/v1/platform/baa-register and
-- PATCH /api/v1/platform/baa-register/:id therefore failed with 42501 on the real platform pool, and every tenant stayed
-- blocked at the `baa_executed` step. The inject tests run as a superuser and could not see it.
--
-- The narrowest grant that makes the two routes work, and no more:
--   INSERT         the create route files a row (organization_id, tenant_account_id, addendum_version, status, dates, contacts).
--   UPDATE (cols)  the PATCH route changes status, the three dates, the two breach contacts and the document link. It can never
--                  rewrite which tenant or organisation a row belongs to, its addendum version, the subcontractor disclosure
--                  set, or the tenant compliance officer's attestation (compliance_officer_attestation_membership_id /
--                  attested_at): that attestation is the tenant's own statement and is written on the tenant surface.
-- REVOKE UPDATE first so a re-provision takes back an older table-wide grant. The carrier exists only where
-- scripts/db/provision-runtime-roles.ts has run, and that script re-grants the same on every run (both must agree).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    GRANT INSERT ON "platform_tenant_baa_record" TO chartwarden_platform;
    REVOKE UPDATE ON "platform_tenant_baa_record" FROM chartwarden_platform;
    GRANT UPDATE ("baa_status", "executed_on", "effective_on", "expires_on", "breach_notification_contact_email", "breach_notification_contact_phone", "document_id") ON "platform_tenant_baa_record" TO chartwarden_platform;
  END IF;
END $$;
