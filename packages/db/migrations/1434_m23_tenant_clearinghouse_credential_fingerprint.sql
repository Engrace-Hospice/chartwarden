-- compat: contract
-- M23 tenant clearinghouse (owner decision 2026-11-08): one vendor account belongs to ONE organization. A tenant's own Claim.MD
-- (or Stedi) account is polled per tenant, so two organizations sealing the same account key would each read the other's
-- responses. The sealed secret cannot be compared (each org's envelope is different), so the config now carries
--   credential_fingerprint  HMAC-SHA256 under a key derived from the credential KEK (never a plain hash) over the vendor and
--                           the account key; NULL when the row holds no credential (`outside`). Written by the service with
--                           every credential (a rotation recomputes it, `outside` clears it, so the slot frees up).
-- The unique index spans organizations on purpose: RLS hides the other org's row from the reader, but a unique index is
-- checked regardless of RLS, so a second organization's save fails with a unique violation the service maps to a typed 409
-- that never names the holder. Existing rows stay NULL until their credential is next saved (tenant clearinghouses are not
-- yet in production). Declared `contract` (arch:migration-compat): a new unique index and CHECK are contracting by the repo's
-- rule even though the previous release never writes this column, so deploy.sh halts for an operator rather than auto-rolling
-- back over it.
ALTER TABLE "tenant_clearinghouse_config" ADD COLUMN IF NOT EXISTS "credential_fingerprint" text;--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" DROP CONSTRAINT IF EXISTS "tenant_clearinghouse_config_fingerprint_shape";--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" ADD CONSTRAINT "tenant_clearinghouse_config_fingerprint_shape" CHECK (
  "credential_fingerprint" IS NULL OR "credential_fingerprint" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_clearinghouse_config_fingerprint_uq" ON "tenant_clearinghouse_config" ("credential_fingerprint")
  WHERE "credential_fingerprint" IS NOT NULL;--> statement-breakpoint
-- UPDATE stays column-level (1417); INSERT is table-wide already.
GRANT UPDATE ("credential_fingerprint") ON "tenant_clearinghouse_config" TO chartwarden_app;--> statement-breakpoint

-- The write-audit row scrubs the fingerprint as it scrubs the sealed secret (a keyed digest of a credential stays out of the
-- audit store); `secret_changed` already tells a reader the credential moved. Same body as 1417 otherwise.
CREATE OR REPLACE FUNCTION audit_phi_write_tenant_clearinghouse_config() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['secret_cipher', 'credential_fingerprint']::text[]; v_secret_changed boolean;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  v_secret_changed := CASE TG_OP
    WHEN 'INSERT' THEN NEW.secret_cipher IS NOT NULL
    WHEN 'UPDATE' THEN OLD.secret_cipher IS DISTINCT FROM NEW.secret_cipher
    ELSE OLD.secret_cipher IS NOT NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'tenant_clearinghouse_config.' || lower(TG_OP), 'tenant_clearinghouse_config', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'warn', v_before, v_after, jsonb_build_object('secret_changed', v_secret_changed), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_tenant_clearinghouse_config() OWNER TO chartwarden_audit_writer;
