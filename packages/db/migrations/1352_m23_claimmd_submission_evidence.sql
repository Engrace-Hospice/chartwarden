-- compat: expand
-- BIL-1.2.2A: immutable outbound identity facts plus append-only Claim.MD receipt observations.
CREATE TABLE claimmd_submission_evidence (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL,
  location_id uuid,
  claim_id uuid NOT NULL,
  billing_module text NOT NULL CHECK (billing_module IN ('M23','M41')),
  submission_id uuid NOT NULL,
  attempt_key text NOT NULL CHECK (char_length(attempt_key) BETWEEN 1 AND 160),
  vendor text NOT NULL CHECK (vendor = 'claimmd'),
  account_reference text NOT NULL CHECK (account_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  usage text NOT NULL CHECK (usage IN ('test','production')),
  billing_npi text NOT NULL CHECK (billing_npi ~ '^[0-9]{10}$'),
  billing_tin_ciphertext text NOT NULL CHECK (char_length(billing_tin_ciphertext) BETWEEN 32 AND 2048),
  payer_id text NOT NULL CHECK (char_length(payer_id) BETWEEN 1 AND 80),
  claim_type text NOT NULL CHECK (char_length(claim_type) BETWEEN 1 AND 32),
  pcn text NOT NULL CHECK (char_length(pcn) BETWEEN 1 AND 80),
  isa13 text NOT NULL CHECK (char_length(isa13) BETWEEN 1 AND 20),
  gs06 text NOT NULL CHECK (char_length(gs06) BETWEEN 1 AND 20),
  st02 text NOT NULL CHECK (char_length(st02) BETWEEN 1 AND 20),
  service_from text CHECK (service_from IS NULL OR service_from ~ '^[0-9]{8}$'),
  service_to text CHECK (service_to IS NULL OR service_to ~ '^[0-9]{8}$'),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload_format text NOT NULL CHECK (payload_format = 'x12'),
  outbound_reference text NOT NULL CHECK (char_length(outbound_reference) BETWEEN 1 AND 256),
  reserved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_submission_evidence_attempt_uq UNIQUE (organization_id,billing_module,attempt_key),
  CONSTRAINT claimmd_submission_evidence_identity_uq UNIQUE (id,organization_id,account_reference,usage)
);--> statement-breakpoint
CREATE INDEX claimmd_submission_evidence_external_ix ON claimmd_submission_evidence(account_reference,usage,pcn);--> statement-breakpoint
CREATE INDEX claimmd_submission_evidence_claim_ix ON claimmd_submission_evidence(organization_id,claim_id,created_at);--> statement-breakpoint

CREATE TABLE claimmd_submission_receipt_observation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  account_reference text NOT NULL CHECK (account_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  usage text NOT NULL CHECK (usage IN ('test','production')),
  vendor text NOT NULL CHECK (vendor = 'claimmd'),
  source_field text NOT NULL CHECK (source_field IN ('fileid','inboundid','batchid','claimid','claimmd_id','remote_claimid','pcn','responseid','clearinghouseSubmissionId')),
  identifier_namespace text NOT NULL CHECK (identifier_namespace IN ('file','batch','claim','remote_claim','pcn','message','opaque_submission')),
  external_value text NOT NULL CHECK (char_length(external_value) BETWEEN 1 AND 256),
  observation_source text NOT NULL CHECK (observation_source IN ('upload_response','upload_reconciliation','attempt_store_replay','verified_status_response')),
  observed_at timestamptz NOT NULL,
  source_reference text NOT NULL CHECK (char_length(source_reference) BETWEEN 1 AND 256),
  CONSTRAINT claimmd_receipt_observation_replay_uq UNIQUE (evidence_id,source_field,external_value,observation_source),
  CONSTRAINT claimmd_receipt_evidence_scope_fk FOREIGN KEY (evidence_id,organization_id,account_reference,usage)
    REFERENCES claimmd_submission_evidence(id,organization_id,account_reference,usage) ON DELETE RESTRICT
);--> statement-breakpoint
CREATE INDEX claimmd_receipt_observation_external_ix ON claimmd_submission_receipt_observation(account_reference,usage,identifier_namespace,external_value);--> statement-breakpoint
CREATE INDEX claimmd_receipt_evidence_scope_ix ON claimmd_submission_receipt_observation(evidence_id,organization_id,account_reference,usage);--> statement-breakpoint

ALTER TABLE claimmd_submission_evidence ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_submission_evidence FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_submission_evidence_org ON claimmd_submission_evidence FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);--> statement-breakpoint
ALTER TABLE claimmd_submission_receipt_observation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_submission_receipt_observation FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_submission_receipt_org ON claimmd_submission_receipt_observation FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);--> statement-breakpoint
GRANT SELECT,INSERT ON claimmd_submission_evidence TO chartwarden_app;--> statement-breakpoint
GRANT SELECT,INSERT ON claimmd_submission_receipt_observation TO chartwarden_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION claimmd_submission_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'CLAIMMD_SUBMISSION_EVIDENCE_IMMUTABLE' USING ERRCODE = 'check_violation';
END $fn$;--> statement-breakpoint
CREATE TRIGGER trg_claimmd_submission_evidence_immutable BEFORE UPDATE OR DELETE ON claimmd_submission_evidence
  FOR EACH ROW EXECUTE FUNCTION claimmd_submission_evidence_immutable();--> statement-breakpoint
CREATE OR REPLACE FUNCTION claimmd_submission_receipt_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'CLAIMMD_RECEIPT_OBSERVATION_APPEND_ONLY' USING ERRCODE = 'check_violation';
END $fn$;--> statement-breakpoint
CREATE TRIGGER trg_claimmd_submission_receipt_append_only BEFORE UPDATE OR DELETE ON claimmd_submission_receipt_observation
  FOR EACH ROW EXECUTE FUNCTION claimmd_submission_receipt_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_claimmd_submission_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_before jsonb; v_after jsonb; v_id uuid; v_org uuid; v_module text;
BEGIN
  v_id := COALESCE(NEW.id, OLD.id);
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  IF TG_TABLE_NAME = 'claimmd_submission_evidence' THEN
    v_module := COALESCE(NEW.billing_module, OLD.billing_module);
  ELSE
    v_module := 'receipt_observation';
  END IF;
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), ARRAY['billing_tin_ciphertext']) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), ARRAY['billing_tin_ciphertext']) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id,
    outcome, severity, before, after, context, retention_class)
  VALUES (v_org, NULLIF(current_setting('app.user_id',true),'')::uuid, 'system', 'claimmd_submission_evidence.'||lower(TG_OP),
    TG_TABLE_NAME, v_id, COALESCE(NULLIF(current_setting('app.correlation_id',true),''),'system'), 'success', 'info',
    v_before, v_after, jsonb_build_object('billing_module', v_module), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $fn$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_claimmd_submission_evidence() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER trg_audit_claimmd_submission_evidence AFTER INSERT OR UPDATE OR DELETE ON claimmd_submission_evidence
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claimmd_submission_evidence();--> statement-breakpoint
CREATE TRIGGER trg_audit_claimmd_receipt_observation AFTER INSERT OR UPDATE OR DELETE ON claimmd_submission_receipt_observation
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claimmd_submission_evidence();--> statement-breakpoint
