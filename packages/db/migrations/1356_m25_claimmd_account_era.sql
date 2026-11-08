-- compat: expand
-- BIL-1.4: account-scoped Claim.MD source capture and non-posting M25 staging.
-- Bootstrap rows are operator-created; no cursor is initialized by this migration.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='claimmd_capture') THEN
    CREATE ROLE claimmd_capture NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO claimmd_capture;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='chartwarden_platform') THEN
  GRANT claimmd_capture TO chartwarden_platform;
END IF; END $$;--> statement-breakpoint

CREATE TABLE claimmd_era_stream (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor text NOT NULL DEFAULT 'claimmd' CHECK (vendor='claimmd'),
  account_reference text NOT NULL CHECK (account_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  usage text NOT NULL CHECK (usage IN ('test','production')),
  stream_kind text NOT NULL DEFAULT 'eras' CHECK (stream_kind='eras'),
  cursor text NOT NULL CHECK (cursor ~ '^[0-9]{1,64}$'),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  lease_owner uuid,
  lease_until timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z_]{1,40}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_era_stream_identity_uq UNIQUE(vendor,account_reference,usage,stream_kind),
  CONSTRAINT claimmd_era_stream_lease_pair CHECK ((lease_owner IS NULL)=(lease_until IS NULL))
);--> statement-breakpoint
CREATE TABLE claimmd_era_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id uuid NOT NULL REFERENCES claimmd_era_stream(id) ON DELETE RESTRICT,
  vendor text NOT NULL DEFAULT 'claimmd' CHECK (vendor='claimmd'),
  account_reference text NOT NULL CHECK (account_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  usage text NOT NULL CHECK (usage IN ('test','production')),
  era_id text NOT NULL CHECK (era_id ~ '^[0-9]{1,64}$'),
  source_metadata_cipher text NOT NULL,
  source_metadata_key_id text NOT NULL,
  source_metadata_digest text NOT NULL CHECK (source_metadata_digest ~ '^[0-9a-f]{64}$'),
  capture_state text NOT NULL DEFAULT 'discovered' CHECK (capture_state IN ('discovered','captured','invalid','needs_review','retryable_failure')),
  original_835_cipher text,
  original_835_key_id text,
  original_835_digest text CHECK (original_835_digest IS NULL OR original_835_digest ~ '^[0-9a-f]{64}$'),
  original_835_file_count integer CHECK (original_835_file_count IS NULL OR original_835_file_count BETWEEN 1 AND 100),
  structured_details_cipher text,
  structured_details_key_id text,
  structured_details_digest text CHECK (structured_details_digest IS NULL OR structured_details_digest ~ '^[0-9a-f]{64}$'),
  discovery_page_digest text NOT NULL CHECK (discovery_page_digest ~ '^[0-9a-f]{64}$'),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z_]{1,40}$'),
  discovered_at timestamptz NOT NULL DEFAULT now(), captured_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_era_inbox_identity_uq UNIQUE(stream_id,era_id),
  CONSTRAINT claimmd_era_inbox_capture_complete CHECK (capture_state <> 'captured' OR
    (original_835_cipher IS NOT NULL AND original_835_key_id IS NOT NULL AND original_835_digest IS NOT NULL AND captured_at IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX claimmd_era_inbox_pending_ix ON claimmd_era_inbox(stream_id,capture_state,discovered_at);--> statement-breakpoint
CREATE TABLE claimmd_era_m25_stage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL,
  location_id uuid,
  source_inbox_id uuid NOT NULL,
  vendor text NOT NULL DEFAULT 'claimmd' CHECK (vendor='claimmd'),
  account_reference text NOT NULL CHECK (account_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  usage text NOT NULL CHECK (usage IN ('test','production')),
  era_id text NOT NULL CHECK (era_id ~ '^[0-9]{1,64}$'),
  file_index integer NOT NULL CHECK (file_index BETWEEN 0 AND 99),
  interchange_control_number text NOT NULL CHECK (interchange_control_number ~ '^[0-9A-Za-z]{1,9}$'),
  transaction_set_control_number text NOT NULL CHECK (transaction_set_control_number ~ '^[0-9A-Za-z]{1,9}$'),
  original_835_digest text NOT NULL CHECK (original_835_digest ~ '^[0-9a-f]{64}$'),
  source_evidence jsonb NOT NULL CHECK (jsonb_typeof(source_evidence)='object'),
  state text NOT NULL CHECK (state IN ('staged','held','possible_duplicate','delivered')),
  safe_reason_code text CHECK (safe_reason_code IS NULL OR safe_reason_code ~ '^[A-Z_]{1,64}$'),
  possible_duplicate_advice_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_era_m25_stage_component_uq UNIQUE(source_inbox_id,file_index,transaction_set_control_number)
);--> statement-breakpoint
CREATE INDEX claimmd_era_m25_stage_org_ix ON claimmd_era_m25_stage(organization_id,provider_entity_id,created_at);--> statement-breakpoint
CREATE INDEX claimmd_era_m25_stage_state_ix ON claimmd_era_m25_stage(organization_id,state,created_at);--> statement-breakpoint

ALTER TABLE claimmd_era_stream ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_era_stream FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_era_stream_capture ON claimmd_era_stream FOR ALL TO claimmd_capture USING(true) WITH CHECK(true);--> statement-breakpoint
ALTER TABLE claimmd_era_inbox ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_era_inbox FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_era_inbox_capture ON claimmd_era_inbox FOR ALL TO claimmd_capture USING(true) WITH CHECK(true);--> statement-breakpoint
ALTER TABLE claimmd_era_m25_stage ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_era_m25_stage FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_era_m25_stage_org ON claimmd_era_m25_stage FOR ALL TO chartwarden_app
  USING(organization_id=nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK(organization_id=nullif(current_setting('app.org_id',true),'')::uuid);--> statement-breakpoint
CREATE POLICY claimmd_era_m25_stage_capture_read ON claimmd_era_m25_stage FOR SELECT TO claimmd_capture USING(true);--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE(cursor,generation,lease_owner,lease_until,last_attempt_at,last_success_at,error_code,updated_at)
  ON claimmd_era_stream TO claimmd_capture;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON claimmd_era_inbox TO claimmd_capture;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON claimmd_era_m25_stage TO chartwarden_app;--> statement-breakpoint
GRANT SELECT ON claimmd_era_m25_stage TO claimmd_capture;--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_claimmd_era_m25_stage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE r claimmd_era_m25_stage; BEGIN
  IF TG_OP='DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  INSERT INTO audit_event(organization_id,actor_user_id,actor_kind,event_type,resource_kind,resource_id,correlation_id,
    outcome,severity,before,after,context,retention_class)
  VALUES(r.organization_id,NULLIF(current_setting('app.user_id',true),'')::uuid,'system',
    'claimmd_era_m25_stage.'||lower(TG_OP),'claimmd_era_m25_stage',r.id,
    COALESCE(NULLIF(current_setting('app.correlation_id',true),''),'system'),'success','info',NULL,
    jsonb_build_object('state',r.state,'reasonCode',r.safe_reason_code,'eraDigest',r.original_835_digest),
    jsonb_build_object('providerEntityId',r.provider_entity_id,'sourceInboxId',r.source_inbox_id),'compliance');
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $fn$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_claimmd_era_m25_stage() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER trg_audit_claimmd_era_m25_stage AFTER INSERT OR UPDATE OR DELETE ON claimmd_era_m25_stage
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claimmd_era_m25_stage();
