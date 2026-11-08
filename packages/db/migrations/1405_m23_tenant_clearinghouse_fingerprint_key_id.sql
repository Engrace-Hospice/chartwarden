-- compat: contract
-- M23 tenant clearinghouse (owner decision 2026-11-08, security review of 1404): a credential's fingerprint names the KEY it was
-- computed under. The fingerprint key derives from the credential KEK, so a KEK change would leave every reservation recorded
-- under the old key unmatched, and a retired credential (rotated away, or freed by `outside`) cannot be recomputed: its plaintext
-- is gone. So:
--   credential_fingerprint_key_id  the public id of the fingerprint key (16 hex, one-way from the key; it names the key, never
--                                  reveals it), on the reservation and on the config's current fingerprint. NULL = recorded
--                                  before this migration, under the KEK that was current then.
-- While a retired KEK is configured (M23_CLEARINGHOUSE_FINGERPRINT_RETIRED_KEKS), every save reserves the credential under the
-- current AND each retired key, so a reservation recorded under the retired key still collides on 1404's unique index; dropping
-- the retired KEK ends the protection of reservations only it computed (ops runbook §8.3).
--
-- Also (same review): the reservation write-audit scrubs the release reason too (an operator's reason may name the organization
-- an account moved to, and the trail is tenant-visible; the platform-ops audit row keeps it), and the platform carrier reads only
-- the columns its boot check needs. Declared `contract` by the repo's rule (CHECKs and a REVOKE), though the previous release still
-- works over it: the new columns are nullable, and its boot check reads only id, fingerprint and released_at.
ALTER TABLE "tenant_clearinghouse_credential_reservation" ADD COLUMN IF NOT EXISTS "credential_fingerprint_key_id" text;--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_credential_reservation" DROP CONSTRAINT IF EXISTS "tenant_clearinghouse_credential_reservation_key_id_ck";--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_credential_reservation" ADD CONSTRAINT "tenant_clearinghouse_credential_reservation_key_id_ck" CHECK (
  "credential_fingerprint_key_id" IS NULL OR "credential_fingerprint_key_id" ~ '^[0-9a-f]{16}$');--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" ADD COLUMN IF NOT EXISTS "credential_fingerprint_key_id" text;--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" DROP CONSTRAINT IF EXISTS "tenant_clearinghouse_config_fingerprint_key_id_ck";--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" ADD CONSTRAINT "tenant_clearinghouse_config_fingerprint_key_id_ck" CHECK (
  "credential_fingerprint_key_id" IS NULL OR "credential_fingerprint_key_id" ~ '^[0-9a-f]{16}$');--> statement-breakpoint
-- UPDATE stays column-level (1386, 1403); INSERT is table-wide already on both tables.
GRANT UPDATE ("credential_fingerprint_key_id") ON "tenant_clearinghouse_config" TO chartwarden_app;--> statement-breakpoint

-- The platform carrier's boot check needs the fingerprint, its key and whether it is held; never the organization or the reason.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    REVOKE SELECT ON "tenant_clearinghouse_credential_reservation" FROM chartwarden_platform;
    GRANT SELECT ("id", "credential_fingerprint", "credential_fingerprint_key_id", "released_at")
      ON "tenant_clearinghouse_credential_reservation" TO chartwarden_platform;
  END IF;
END $$;
--> statement-breakpoint

-- Same body as 1404 but for v_cols: the release reason is scrubbed like the fingerprint.
CREATE OR REPLACE FUNCTION audit_phi_write_tenant_clearinghouse_credential_reservation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['credential_fingerprint', 'release_reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'tenant_clearinghouse_credential_reservation.' || lower(TG_OP), 'tenant_clearinghouse_credential_reservation', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'warn', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_tenant_clearinghouse_credential_reservation() OWNER TO chartwarden_audit_writer;
