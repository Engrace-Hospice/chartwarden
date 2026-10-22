-- 1151 — ChartWarden rebrand: rewrite the two stored identifiers that still carry the old name.
--
--   1. "user".email   link-<linkId>@principals.wardenx.invalid  ->  link-<linkId>@principals.chartwarden.invalid
--      (the credential-less principal minted on first redemption of a collaborator / funeral-home link; the link row pins
--      it by principal_user_id, so nothing but the find-or-create lookup keys on the address).
--   2. tenant_fhir_config.tenant_fhir_host / identifier_uri_base   urn:wardenx:org:<id>  ->  urn:chartwarden:org:<id>
--      (only a tenant that stored the platform's own URN fallback is touched; a tenant's real host / URI base is not).
--
-- Idempotent: every UPDATE is guarded by the old-value predicate, so a re-run changes nothing. A principal whose new-form
-- address already exists is skipped (user_email_idx is unique) rather than failing the file; the application reads both
-- forms (collaborator-link-store-db.ts), so the skipped row keeps working.
-- No DDL, no object is renamed. MIGRATOR ROLE: tenant_fhir_config has FORCEd org RLS, so this must run as the
-- DATABASE_ADMIN_URL role (superuser / BYPASSRLS), like 1069; the guard below fails loudly otherwise.
-- Not renamed on purpose: audit_event rows (an audit trail is not rewritten).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'migration 1151 must run as a superuser / BYPASSRLS role (DATABASE_ADMIN_URL): tenant_fhir_config has FORCEd RLS, so % could not rewrite every tenant', current_user;
  END IF;
END $$;--> statement-breakpoint

UPDATE "user" u
   SET email = replace(u.email, '@principals.wardenx.invalid', '@principals.chartwarden.invalid')
 WHERE u.email LIKE 'link-%@principals.wardenx.invalid'
   AND NOT EXISTS (
     SELECT 1 FROM "user" n
      WHERE n.email = replace(u.email, '@principals.wardenx.invalid', '@principals.chartwarden.invalid')
   );--> statement-breakpoint

UPDATE tenant_fhir_config
   SET tenant_fhir_host = replace(tenant_fhir_host, 'urn:wardenx:org:', 'urn:chartwarden:org:'),
       identifier_uri_base = replace(identifier_uri_base, 'urn:wardenx:org:', 'urn:chartwarden:org:')
 WHERE tenant_fhir_host LIKE 'urn:wardenx:org:%' OR identifier_uri_base LIKE 'urn:wardenx:org:%';
