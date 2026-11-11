-- compat: expand
-- BIL-3.4: immutable attempt-specific line facts derived from the exact outbound 837 payload.
CREATE TABLE claimmd_submission_line_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  attempt_key text NOT NULL CHECK (char_length(attempt_key) BETWEEN 1 AND 160),
  internal_claim_line_id uuid NOT NULL,
  line_position integer NOT NULL CHECK (line_position > 0),
  line_item_control_number text CHECK (line_item_control_number IS NULL OR char_length(line_item_control_number) BETWEEN 1 AND 30),
  revenue_code text,
  procedure_code text,
  service_from text CHECK (service_from IS NULL OR service_from ~ '^[0-9]{8}$'),
  service_to text CHECK (service_to IS NULL OR service_to ~ '^[0-9]{8}$'),
  units text,
  charge_cents bigint,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  account_reference text NOT NULL CHECK (account_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  usage text NOT NULL CHECK (usage IN ('test','production')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_submission_line_evidence_scope_fk FOREIGN KEY (evidence_id,organization_id,account_reference,usage)
    REFERENCES claimmd_submission_evidence(id,organization_id,account_reference,usage) ON DELETE RESTRICT,
  CONSTRAINT claimmd_submission_line_evidence_position_uq UNIQUE (evidence_id,line_position),
  CONSTRAINT claimmd_submission_line_evidence_ref_uq UNIQUE (evidence_id,line_item_control_number)
);--> statement-breakpoint
CREATE INDEX claimmd_submission_line_evidence_claim_ix ON claimmd_submission_line_evidence(organization_id,claim_id,submission_id);--> statement-breakpoint
ALTER TABLE claimmd_submission_line_evidence ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_submission_line_evidence FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_submission_line_evidence_org ON claimmd_submission_line_evidence FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid AND EXISTS (
    SELECT 1 FROM claimmd_submission_evidence e WHERE e.id = claimmd_submission_line_evidence.evidence_id
      AND e.organization_id = claimmd_submission_line_evidence.organization_id
      AND e.provider_entity_id = claimmd_submission_line_evidence.provider_entity_id
      AND e.claim_id = claimmd_submission_line_evidence.claim_id
      AND e.submission_id = claimmd_submission_line_evidence.submission_id
      AND e.attempt_key = claimmd_submission_line_evidence.attempt_key
      AND e.account_reference = claimmd_submission_line_evidence.account_reference
      AND e.usage = claimmd_submission_line_evidence.usage
      AND e.payload_sha256 = claimmd_submission_line_evidence.payload_sha256
  ));--> statement-breakpoint
CREATE POLICY claimmd_submission_line_evidence_internal_read ON claimmd_submission_line_evidence FOR SELECT TO claimmd_capture USING (true);--> statement-breakpoint
GRANT SELECT,INSERT ON claimmd_submission_line_evidence TO chartwarden_app;--> statement-breakpoint
GRANT SELECT ON claimmd_submission_line_evidence TO claimmd_capture;--> statement-breakpoint
CREATE TRIGGER trg_claimmd_submission_line_evidence_immutable BEFORE UPDATE OR DELETE ON claimmd_submission_line_evidence
  FOR EACH ROW EXECUTE FUNCTION claimmd_submission_evidence_immutable();--> statement-breakpoint
-- Keep audit metadata accurate for line-evidence inserts; the original function predates this table.
CREATE OR REPLACE FUNCTION audit_phi_write_claimmd_submission_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_before jsonb; v_after jsonb; v_id uuid; v_org uuid; v_module text;
BEGIN
  v_id := COALESCE(NEW.id, OLD.id);
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  IF TG_TABLE_NAME = 'claimmd_submission_evidence' THEN
    v_module := COALESCE(NEW.billing_module, OLD.billing_module);
  ELSIF TG_TABLE_NAME = 'claimmd_submission_line_evidence' THEN
    v_module := 'submission_line_evidence';
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
CREATE TRIGGER trg_audit_claimmd_submission_line_evidence AFTER INSERT OR UPDATE OR DELETE ON claimmd_submission_line_evidence
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claimmd_submission_evidence();
