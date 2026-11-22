-- compat: expand
-- L2B adds an M24-owned append-only evidence ledger. It records distinct observations about clinical
-- document availability, notification, payer receipt and authorization. It stores no clinical document
-- body, does not assert EOCCO policy, and does not authorize submission.
CREATE TYPE m24_payer_authorization_event_kind AS ENUM (
  'clinical_document_available', 'notification_prepared', 'notification_sent', 'receipt_acknowledged',
  'authorization_pending', 'authorization_approved', 'authorization_denied', 'authorization_expired',
  'authorization_revoked', 'unknown_unverified'
);--> statement-breakpoint
CREATE TYPE m24_payer_authorization_evidence_status AS ENUM (
  'unverified', 'verified', 'rejected', 'superseded'
);--> statement-breakpoint

CREATE TABLE medicaid_payer_authorization_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL REFERENCES provider_entity(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL,
  patient_payer_id uuid NOT NULL,
  admission_id uuid NOT NULL,
  canonical_payer_id uuid NOT NULL,
  service_state text NOT NULL,
  service_from date NOT NULL,
  service_to date NOT NULL,
  level_of_care text,
  event_kind m24_payer_authorization_event_kind NOT NULL,
  evidence_status m24_payer_authorization_evidence_status NOT NULL DEFAULT 'unverified',
  evidence_source text NOT NULL,
  evidence_reference text,
  clinical_document_id uuid,
  encrypted_authorization_reference text,
  verified_at timestamptz,
  verified_by_membership_id uuid,
  recorded_by_membership_id uuid NOT NULL,
  supersedes_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medicaid_payer_auth_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT medicaid_payer_auth_supersedes_org_fk
    FOREIGN KEY (organization_id, supersedes_id)
    REFERENCES medicaid_payer_authorization_event (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT medicaid_payer_auth_service_range_valid CHECK (service_from <= service_to),
  CONSTRAINT medicaid_payer_auth_state_valid CHECK (length(service_state) = 2),
  CONSTRAINT medicaid_payer_auth_loc_valid CHECK (
    level_of_care IS NULL OR level_of_care IN ('RHC', 'CHC', 'IRC', 'GIP', 'NF_RB')
  ),
  CONSTRAINT medicaid_payer_auth_source_valid CHECK (
    evidence_source IN ('m6_document_reference', 'operator_record', 'payer_response', 'payer_portal', 'authorized_channel_receipt')
  ),
  CONSTRAINT medicaid_payer_auth_verified_provenance CHECK (
    evidence_status <> 'verified' OR
    (verified_at IS NOT NULL AND verified_by_membership_id IS NOT NULL AND evidence_reference IS NOT NULL)
    AND verified_by_membership_id <> recorded_by_membership_id
  ),
  CONSTRAINT medicaid_payer_auth_reference_shape CHECK (
    evidence_reference IS NULL OR
    evidence_reference ~ '^(doc|payer-response|payer-portal|ticket):[A-Za-z0-9._/-]{1,190}$'
  )
);--> statement-breakpoint
CREATE INDEX medicaid_payer_auth_patient_payer_window_ix ON medicaid_payer_authorization_event
  (organization_id, patient_id, patient_payer_id, admission_id, canonical_payer_id, service_from, service_to);--> statement-breakpoint

ALTER TABLE medicaid_payer_authorization_event ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE medicaid_payer_authorization_event FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY medicaid_payer_authorization_event_org ON medicaid_payer_authorization_event FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON medicaid_payer_authorization_event TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON medicaid_payer_authorization_event TO chartwarden_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_medicaid_payer_authorization_evidence_status() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_provider_org uuid;
BEGIN
  SELECT organization_id INTO v_provider_org FROM provider_entity WHERE id = NEW.provider_entity_id;
  IF v_provider_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'payer authorization provider entity must belong to the evidence organization';
  END IF;
  IF current_user = 'chartwarden_app' AND NEW.evidence_status <> 'unverified' THEN
    RAISE EXCEPTION 'payer authorization evidence verification requires a separate reviewer path';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_payer_authorization_evidence_status
  BEFORE INSERT ON medicaid_payer_authorization_event
  FOR EACH ROW EXECUTE FUNCTION guard_medicaid_payer_authorization_evidence_status();--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_medicaid_payer_authorization_event_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'medicaid_payer_authorization_event is append-only';
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_payer_authorization_event_append_only
  BEFORE UPDATE OR DELETE ON medicaid_payer_authorization_event
  FOR EACH ROW EXECUTE FUNCTION guard_medicaid_payer_authorization_event_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_write_medicaid_payer_authorization_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_after jsonb;
BEGIN
  v_after := audit_scrub(to_jsonb(NEW), ARRAY[
    'patient_id', 'patient_payer_id', 'admission_id', 'clinical_document_id',
    'evidence_reference', 'encrypted_authorization_reference'
  ]::text[]);
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    NEW.organization_id, NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'medicaid_payer_authorization_event.insert', TG_TABLE_NAME, NEW.id,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', NULL, v_after, '{}'::jsonb, 'compliance'
  );
  RETURN NEW;
END $$;--> statement-breakpoint
ALTER FUNCTION audit_write_medicaid_payer_authorization_event() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER trg_audit_medicaid_payer_authorization_event
  AFTER INSERT ON medicaid_payer_authorization_event
  FOR EACH ROW EXECUTE FUNCTION audit_write_medicaid_payer_authorization_event();
