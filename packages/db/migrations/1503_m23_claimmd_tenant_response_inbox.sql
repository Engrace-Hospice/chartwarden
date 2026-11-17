-- compat: expand
-- M23-CM-5A.3A: tenant-owned response inbox foundation; no poller/cursor cutover is performed here.
CREATE TABLE claimmd_tenant_response_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  tenant_config_id uuid NOT NULL REFERENCES tenant_clearinghouse_config(id) ON DELETE RESTRICT,
  vendor text NOT NULL DEFAULT 'claimmd' CHECK (vendor = 'claimmd'),
  usage text NOT NULL CHECK (usage IN ('test','production')),
  state text NOT NULL CHECK (state IN ('verified','retired')),
  verified_by_membership_id uuid NOT NULL,
  verification_reference text NOT NULL CHECK (verification_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  verified_at timestamptz NOT NULL,
  coverage_started_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_tenant_response_account_scope_uq UNIQUE (id,organization_id,usage)
);
CREATE UNIQUE INDEX claimmd_tenant_response_account_active_uq
  ON claimmd_tenant_response_account(organization_id,usage) WHERE state='verified';
CREATE INDEX claimmd_tenant_response_account_config_ix
  ON claimmd_tenant_response_account(tenant_config_id,usage,created_at);

CREATE TABLE claimmd_tenant_response_account_credential (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  usage text NOT NULL CHECK (usage IN ('test','production')),
  credential_fingerprint text NOT NULL CHECK (credential_fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_key_id text NOT NULL CHECK (char_length(fingerprint_key_id) BETWEEN 1 AND 128),
  verified_by_membership_id uuid NOT NULL,
  verification_reference text NOT NULL CHECK (verification_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  verified_at timestamptz NOT NULL,
  CONSTRAINT claimmd_tenant_response_account_credential_scope_uq UNIQUE (id,organization_id,account_id)
);--> statement-breakpoint
ALTER TABLE claimmd_tenant_response_account_credential ADD CONSTRAINT claimmd_tenant_response_account_credential_account_fk
  FOREIGN KEY (account_id,organization_id,usage)
  REFERENCES claimmd_tenant_response_account(id,organization_id,usage) ON DELETE RESTRICT;--> statement-breakpoint
CREATE UNIQUE INDEX claimmd_tenant_response_account_credential_uq
  ON claimmd_tenant_response_account_credential(account_id,credential_fingerprint,fingerprint_key_id);--> statement-breakpoint
CREATE INDEX claimmd_tenant_response_account_credential_org_ix
  ON claimmd_tenant_response_account_credential(organization_id,account_id,verified_at);--> statement-breakpoint
CREATE FUNCTION claimmd_tenant_response_account_credential_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'CLAIMMD_TENANT_RESPONSE_CREDENTIAL_IMMUTABLE' USING ERRCODE='check_violation'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM claimmd_tenant_response_account a
      JOIN tenant_clearinghouse_config c ON c.id=a.tenant_config_id AND c.organization_id=a.organization_id
    WHERE a.id=NEW.account_id AND a.organization_id=NEW.organization_id AND a.usage=NEW.usage
      AND a.state='verified' AND c.credential_fingerprint=NEW.credential_fingerprint
      AND c.credential_fingerprint_key_id=NEW.fingerprint_key_id AND c.vendor='claimmd'
      AND c.status='active' AND c.mode=NEW.usage AND c.baa_verified_at IS NOT NULL AND c.baa_revoked_at IS NULL
  ) THEN RAISE EXCEPTION 'CLAIMMD_TENANT_RESPONSE_CREDENTIAL_BINDING_INVALID' USING ERRCODE='check_violation'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM membership m WHERE m.id=NEW.verified_by_membership_id
      AND m.organization_id=NEW.organization_id AND m.status='active'
  ) THEN RAISE EXCEPTION 'CLAIMMD_TENANT_RESPONSE_CREDENTIAL_VERIFIER_INVALID' USING ERRCODE='check_violation'; END IF;
  RETURN NEW;
END $fn$;--> statement-breakpoint
CREATE TRIGGER claimmd_tenant_response_account_credential_guard BEFORE INSERT OR UPDATE OR DELETE
  ON claimmd_tenant_response_account_credential FOR EACH ROW EXECUTE FUNCTION claimmd_tenant_response_account_credential_guard();--> statement-breakpoint

CREATE FUNCTION claimmd_tenant_response_account_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE cfg tenant_clearinghouse_config%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.state <> 'verified' OR NEW.state <> 'retired' OR
       (to_jsonb(NEW) - 'state') <> (to_jsonb(OLD) - 'state') THEN
      RAISE EXCEPTION 'CLAIMMD_TENANT_RESPONSE_ACCOUNT_IMMUTABLE' USING ERRCODE='check_violation';
    END IF;
    RETURN NEW;
  ELSIF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'CLAIMMD_TENANT_RESPONSE_ACCOUNT_IMMUTABLE' USING ERRCODE='check_violation';
  END IF;
  IF NEW.state <> 'verified' THEN
    RAISE EXCEPTION 'CLAIMMD_TENANT_RESPONSE_ACCOUNT_STATE_INVALID' USING ERRCODE='check_violation';
  END IF;
  SELECT * INTO cfg FROM tenant_clearinghouse_config
    WHERE id=NEW.tenant_config_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR cfg.vendor <> 'claimmd' OR cfg.status <> 'active' OR cfg.mode <> NEW.usage OR
     cfg.baa_verified_at IS NULL OR cfg.baa_revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'CLAIMMD_TENANT_RESPONSE_ACCOUNT_CONFIG_INVALID' USING ERRCODE='check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM membership m WHERE m.id=NEW.verified_by_membership_id
      AND m.organization_id=NEW.organization_id AND m.status='active'
  ) THEN
    RAISE EXCEPTION 'CLAIMMD_TENANT_RESPONSE_ACCOUNT_VERIFIER_INVALID' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $fn$;--> statement-breakpoint
CREATE TRIGGER claimmd_tenant_response_account_guard BEFORE INSERT OR UPDATE OR DELETE
  ON claimmd_tenant_response_account FOR EACH ROW EXECUTE FUNCTION claimmd_tenant_response_account_guard();--> statement-breakpoint

CREATE TABLE claimmd_tenant_response_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  usage text NOT NULL CHECK (usage IN ('test','production')),
  after_cursor text NOT NULL CHECK (after_cursor ~ '^[0-9]{1,30}$'),
  next_cursor text NOT NULL CHECK (next_cursor ~ '^[0-9]{1,30}$'),
  source_format text NOT NULL CHECK (source_format IN ('json','xml')),
  envelope_version integer NOT NULL DEFAULT 1 CHECK (envelope_version=1),
  key_version text NOT NULL CHECK (char_length(key_version) BETWEEN 1 AND 128),
  payload_cipher bytea NOT NULL CHECK (octet_length(payload_cipher) BETWEEN 29 AND 8388800),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  parent_count integer NOT NULL CHECK (parent_count BETWEEN 0 AND 20000),
  item_count integer NOT NULL CHECK (item_count BETWEEN 0 AND 200000),
  capture_id uuid NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_tenant_response_batch_account_fk FOREIGN KEY (account_id,organization_id,usage)
    REFERENCES claimmd_tenant_response_account(id,organization_id,usage) ON DELETE RESTRICT,
  CONSTRAINT claimmd_tenant_response_batch_page_uq UNIQUE (account_id,usage,after_cursor,next_cursor),
  CONSTRAINT claimmd_tenant_response_batch_scope_uq UNIQUE (id,organization_id,account_id)
);--> statement-breakpoint
CREATE INDEX claimmd_tenant_response_batch_org_time_ix
  ON claimmd_tenant_response_batch(organization_id,account_id,captured_at DESC);--> statement-breakpoint

CREATE TABLE claimmd_tenant_response_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  response_id text CHECK (response_id IS NULL OR response_id ~ '^[0-9]{1,30}$'),
  source_cursor text NOT NULL CHECK (source_cursor ~ '^[0-9]{1,30}$'),
  parent_index integer NOT NULL CHECK (parent_index BETWEEN 0 AND 19999),
  message_index integer NOT NULL CHECK (message_index BETWEEN -1 AND 199999),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  capture_state text NOT NULL CHECK (capture_state IN ('captured','needs_review','malformed')),
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_tenant_response_item_batch_fk FOREIGN KEY (batch_id,organization_id,account_id)
    REFERENCES claimmd_tenant_response_batch(id,organization_id,account_id) ON DELETE RESTRICT,
  CONSTRAINT claimmd_tenant_response_item_fallback_uq UNIQUE (batch_id,parent_index,message_index,payload_digest)
);--> statement-breakpoint
CREATE UNIQUE INDEX claimmd_tenant_response_item_vendor_uq
  ON claimmd_tenant_response_item(account_id,response_id) WHERE response_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX claimmd_tenant_response_item_pending_ix
  ON claimmd_tenant_response_item(organization_id,account_id,capture_state,captured_at);--> statement-breakpoint

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['claimmd_tenant_response_account','claimmd_tenant_response_account_credential','claimmd_tenant_response_batch','claimmd_tenant_response_item'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO chartwarden_app USING (organization_id=nullif(current_setting(''app.org_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''app.org_id'',true),'''')::uuid)',t||'_org',t);
  END LOOP;
END $$;--> statement-breakpoint
GRANT SELECT,INSERT ON claimmd_tenant_response_account TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE (state) ON claimmd_tenant_response_account TO chartwarden_app;--> statement-breakpoint
GRANT SELECT,INSERT ON claimmd_tenant_response_account_credential TO chartwarden_app;--> statement-breakpoint
GRANT SELECT,INSERT ON claimmd_tenant_response_batch,claimmd_tenant_response_item TO chartwarden_app;--> statement-breakpoint

CREATE FUNCTION claimmd_tenant_response_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'CLAIMMD_TENANT_RESPONSE_EVIDENCE_IMMUTABLE' USING ERRCODE='check_violation'; END $fn$;--> statement-breakpoint
CREATE TRIGGER claimmd_tenant_response_batch_immutable BEFORE UPDATE OR DELETE ON claimmd_tenant_response_batch
  FOR EACH ROW EXECUTE FUNCTION claimmd_tenant_response_immutable();--> statement-breakpoint
CREATE TRIGGER claimmd_tenant_response_item_immutable BEFORE UPDATE OR DELETE ON claimmd_tenant_response_item
  FOR EACH ROW EXECUTE FUNCTION claimmd_tenant_response_immutable();

CREATE FUNCTION audit_phi_write_claimmd_tenant_response() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_row jsonb; v_id uuid; v_org uuid;
BEGIN
  v_row := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  v_id := (v_row->>'id')::uuid;
  v_org := (v_row->>'organization_id')::uuid;
  INSERT INTO audit_event(organization_id,actor_user_id,actor_kind,event_type,resource_kind,resource_id,correlation_id,
    outcome,severity,before,after,context,retention_class)
  VALUES(v_org,NULLIF(current_setting('app.user_id',true),'')::uuid,'system',
    'claimmd_tenant_response.'||lower(TG_OP),TG_TABLE_NAME,v_id,
    COALESCE(NULLIF(current_setting('app.correlation_id',true),''),'system'),'success','info',
    CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD),ARRAY['payload_cipher','credential_fingerprint']) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW),ARRAY['payload_cipher','credential_fingerprint']) ELSE NULL END,
    jsonb_build_object('usage',v_row->>'usage','account_id',v_row->>'account_id'),'compliance');
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_claimmd_tenant_response() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER claimmd_tenant_response_account_audit AFTER INSERT OR UPDATE ON claimmd_tenant_response_account
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claimmd_tenant_response();--> statement-breakpoint
CREATE TRIGGER claimmd_tenant_response_account_credential_audit AFTER INSERT ON claimmd_tenant_response_account_credential
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claimmd_tenant_response();--> statement-breakpoint
CREATE TRIGGER claimmd_tenant_response_batch_audit AFTER INSERT ON claimmd_tenant_response_batch
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claimmd_tenant_response();--> statement-breakpoint
CREATE TRIGGER claimmd_tenant_response_item_audit AFTER INSERT ON claimmd_tenant_response_item
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claimmd_tenant_response();
