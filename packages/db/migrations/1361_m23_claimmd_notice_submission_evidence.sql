-- compat: expand
-- BIL-1.5A.2: typed immutable notice evidence, separate from claim-only Claim.MD evidence.
CREATE TABLE claimmd_notice_submission_evidence (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL,
  location_id uuid,
  notice_id uuid NOT NULL,
  notice_kind text NOT NULL CHECK (notice_kind IN ('noe','notr','transfer_notice')),
  submission_id uuid NOT NULL,
  attempt_index integer NOT NULL CHECK (attempt_index >= 0),
  vendor text NOT NULL CHECK (vendor = 'claimmd'),
  account_reference text NOT NULL CHECK (account_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  usage text NOT NULL CHECK (usage IN ('test','production')),
  billing_npi text NOT NULL CHECK (billing_npi ~ '^[0-9]{10}$'),
  billing_tin_ciphertext text NOT NULL CHECK (char_length(billing_tin_ciphertext) BETWEEN 32 AND 2048),
  payer_id text NOT NULL CHECK (char_length(payer_id) BETWEEN 1 AND 80),
  interchange_sender_id text NOT NULL CHECK (char_length(interchange_sender_id) BETWEEN 1 AND 80),
  interchange_receiver_id text NOT NULL CHECK (interchange_receiver_id = 'CLAIMMD'),
  functional_sender_id text NOT NULL CHECK (char_length(functional_sender_id) BETWEEN 1 AND 80),
  functional_receiver_id text NOT NULL CHECK (functional_receiver_id = 'CLAIMMD'),
  transaction_set text NOT NULL CHECK (transaction_set = '837I'),
  notice_control_number text NOT NULL CHECK (char_length(notice_control_number) BETWEEN 1 AND 80),
  outbound_business_control_number text CHECK (outbound_business_control_number IS NULL OR char_length(outbound_business_control_number) BETWEEN 1 AND 80),
  isa13 text NOT NULL CHECK (char_length(isa13) BETWEEN 1 AND 20),
  gs06 text NOT NULL CHECK (char_length(gs06) BETWEEN 1 AND 20),
  st02 text NOT NULL CHECK (char_length(st02) BETWEEN 1 AND 20),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  outbound_reference text NOT NULL CHECK (char_length(outbound_reference) BETWEEN 1 AND 256),
  reserved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_notice_evidence_attempt_uq UNIQUE (organization_id,submission_id),
  CONSTRAINT claimmd_notice_evidence_identity_uq UNIQUE (id,organization_id,account_reference,usage)
);--> statement-breakpoint
CREATE INDEX claimmd_notice_evidence_notice_ix ON claimmd_notice_submission_evidence(organization_id,notice_kind,notice_id,created_at);--> statement-breakpoint
CREATE INDEX claimmd_notice_evidence_external_ix ON claimmd_notice_submission_evidence(account_reference,usage,isa13,gs06,st02);--> statement-breakpoint

CREATE TABLE claimmd_notice_receipt_observation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  account_reference text NOT NULL CHECK (account_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  usage text NOT NULL CHECK (usage IN ('test','production')),
  source_field text NOT NULL CHECK (source_field IN ('fileid','inboundid','batchid','claimid','claimmd_id','remote_claimid','pcn','responseid','clearinghouseSubmissionId')),
  identifier_namespace text NOT NULL CHECK (identifier_namespace IN ('file','batch','claim','remote_claim','pcn','message','opaque_submission')),
  external_value text NOT NULL CHECK (char_length(external_value) BETWEEN 1 AND 256),
  observation_source text NOT NULL CHECK (observation_source IN ('upload_response','upload_reconciliation','attempt_store_replay','verified_status_response')),
  observed_at timestamptz NOT NULL,
  source_reference text NOT NULL CHECK (char_length(source_reference) BETWEEN 1 AND 256),
  CONSTRAINT claimmd_notice_receipt_replay_uq UNIQUE (evidence_id,source_field,external_value,observation_source),
  CONSTRAINT claimmd_notice_receipt_scope_fk FOREIGN KEY (evidence_id,organization_id,account_reference,usage)
    REFERENCES claimmd_notice_submission_evidence(id,organization_id,account_reference,usage) ON DELETE RESTRICT
);--> statement-breakpoint
CREATE INDEX claimmd_notice_receipt_external_ix ON claimmd_notice_receipt_observation(account_reference,usage,identifier_namespace,external_value);--> statement-breakpoint
ALTER TABLE claimmd_notice_submission_evidence ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_notice_submission_evidence FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_notice_evidence_org ON claimmd_notice_submission_evidence FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);--> statement-breakpoint
ALTER TABLE claimmd_notice_receipt_observation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_notice_receipt_observation FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_notice_receipt_org ON claimmd_notice_receipt_observation FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);--> statement-breakpoint
GRANT SELECT,INSERT ON claimmd_notice_submission_evidence TO chartwarden_app;--> statement-breakpoint
GRANT SELECT,INSERT ON claimmd_notice_receipt_observation TO chartwarden_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION claimmd_notice_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'CLAIMMD_NOTICE_EVIDENCE_IMMUTABLE' USING ERRCODE = 'check_violation'; END $fn$;--> statement-breakpoint
CREATE TRIGGER trg_claimmd_notice_evidence_immutable BEFORE UPDATE OR DELETE ON claimmd_notice_submission_evidence
  FOR EACH ROW EXECUTE FUNCTION claimmd_notice_evidence_immutable();--> statement-breakpoint
CREATE TRIGGER trg_claimmd_notice_receipt_immutable BEFORE UPDATE OR DELETE ON claimmd_notice_receipt_observation
  FOR EACH ROW EXECUTE FUNCTION claimmd_notice_evidence_immutable();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_claimmd_notice_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_id uuid; v_org uuid;
BEGIN
  v_id := COALESCE(NEW.id, OLD.id); v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id,
    outcome, severity, before, after, context, retention_class)
  VALUES (v_org, NULLIF(current_setting('app.user_id',true),'')::uuid, 'system', 'claimmd_notice_submission_evidence.insert',
    TG_TABLE_NAME, v_id, COALESCE(NULLIF(current_setting('app.correlation_id',true),''),'system'), 'success', 'info', NULL,
    audit_scrub(to_jsonb(NEW), ARRAY['billing_tin_ciphertext']),
    CASE WHEN TG_TABLE_NAME = 'claimmd_notice_submission_evidence' THEN jsonb_build_object('notice_kind', NEW.notice_kind)
      ELSE jsonb_build_object('record_kind', 'receipt_observation') END, 'compliance');
  RETURN NEW;
END $fn$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_claimmd_notice_evidence() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER trg_audit_claimmd_notice_evidence AFTER INSERT ON claimmd_notice_submission_evidence
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claimmd_notice_evidence();--> statement-breakpoint
CREATE TRIGGER trg_audit_claimmd_notice_receipt AFTER INSERT ON claimmd_notice_receipt_observation
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claimmd_notice_evidence();
