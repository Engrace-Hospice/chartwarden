-- compat: expand
-- L2B adds an empty tenant/provider-scoped home for future payer rates. No rate is loaded or verified.
CREATE TABLE medicaid_payer_rate_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL REFERENCES provider_entity(id) ON DELETE RESTRICT,
  canonical_payer_id uuid NOT NULL,
  program_kind text NOT NULL,
  service_state text NOT NULL,
  locality_code text NOT NULL,
  service_category text NOT NULL,
  unit_basis text NOT NULL,
  bucket_from integer,
  bucket_to integer,
  rate_cents integer NOT NULL,
  charge_ceiling_cents integer,
  quality_reporting_status text NOT NULL DEFAULT 'unknown',
  source_kind text NOT NULL,
  verification_status text NOT NULL DEFAULT 'unverified',
  effective_from date NOT NULL,
  effective_to date,
  source_document_ref text,
  verified_at timestamptz,
  verified_by_membership_id uuid,
  recorded_by_membership_id uuid NOT NULL,
  supersedes_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medicaid_payer_rate_policy_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT medicaid_payer_rate_policy_supersedes_org_fk
    FOREIGN KEY (organization_id, supersedes_id)
    REFERENCES medicaid_payer_rate_policy (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT medicaid_payer_rate_policy_identity_uq UNIQUE NULLS NOT DISTINCT
    (organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
     locality_code, service_category, unit_basis, bucket_from, bucket_to, effective_from),
  CONSTRAINT medicaid_payer_rate_policy_program_valid
    CHECK (program_kind IN ('oregon_ffs', 'managed_care')),
  CONSTRAINT medicaid_payer_rate_policy_state_valid CHECK (length(service_state) = 2),
  CONSTRAINT medicaid_payer_rate_policy_locality_valid CHECK (btrim(locality_code) <> ''),
  CONSTRAINT medicaid_payer_rate_policy_service_valid
    CHECK (service_category IN ('RHC', 'CHC', 'IRC', 'GIP', 'IN_HOME_RESPITE')),
  CONSTRAINT medicaid_payer_rate_policy_unit_valid
    CHECK (unit_basis IN ('per_day', 'per_hour')),
  CONSTRAINT medicaid_payer_rate_policy_bucket_valid
    CHECK ((bucket_from IS NULL AND bucket_to IS NULL) OR
      (bucket_from IS NOT NULL AND bucket_to IS NOT NULL AND bucket_from > 0 AND bucket_to >= bucket_from)),
  CONSTRAINT medicaid_payer_rate_policy_amount_valid
    CHECK (rate_cents > 0 AND (charge_ceiling_cents IS NULL OR charge_ceiling_cents > 0)),
  CONSTRAINT medicaid_payer_rate_policy_quality_valid
    CHECK (quality_reporting_status IN ('unknown', 'not_applicable', 'meets', 'does_not_meet')),
  CONSTRAINT medicaid_payer_rate_policy_source_valid
    CHECK (source_kind IN ('oha_ffs_schedule', 'cco_contract', 'other_payer_contract')),
  CONSTRAINT medicaid_payer_rate_policy_status_valid
    CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected', 'expired', 'revoked', 'superseded')),
  CONSTRAINT medicaid_payer_rate_policy_period_valid CHECK (effective_to IS NULL OR effective_from <= effective_to),
  CONSTRAINT medicaid_payer_rate_policy_version_valid CHECK (version > 0),
  CONSTRAINT medicaid_payer_rate_policy_verified_provenance CHECK (
    verification_status <> 'verified' OR
    (source_document_ref IS NOT NULL AND verified_at IS NOT NULL AND verified_by_membership_id IS NOT NULL
      AND verified_by_membership_id <> recorded_by_membership_id)
  ),
  CONSTRAINT medicaid_payer_rate_policy_document_ref_shape CHECK (
    source_document_ref IS NULL OR source_document_ref ~ '^doc:[A-Za-z0-9._/-]{1,190}$'
  ),
  CONSTRAINT medicaid_payer_rate_policy_ffs_scope CHECK (
    source_kind <> 'oha_ffs_schedule' OR program_kind = 'oregon_ffs'
  ),
  CONSTRAINT medicaid_payer_rate_policy_contract_scope CHECK (
    source_kind = 'oha_ffs_schedule' OR program_kind = 'managed_care'
  )
);--> statement-breakpoint
CREATE INDEX medicaid_payer_rate_policy_lookup_ix ON medicaid_payer_rate_policy
  (organization_id, provider_entity_id, canonical_payer_id, service_state, locality_code,
   service_category, unit_basis, effective_from, effective_to);--> statement-breakpoint

ALTER TABLE medicaid_payer_rate_policy ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE medicaid_payer_rate_policy FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY medicaid_payer_rate_policy_org ON medicaid_payer_rate_policy FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON medicaid_payer_rate_policy TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON medicaid_payer_rate_policy TO chartwarden_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_medicaid_payer_rate_policy_status() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_provider_org uuid;
BEGIN
  SELECT organization_id INTO v_provider_org FROM provider_entity WHERE id = NEW.provider_entity_id;
  IF v_provider_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'payer rate provider entity must belong to the rate organization';
  END IF;
  IF current_user = 'chartwarden_app' AND NEW.verification_status <> 'unverified' THEN
    RAISE EXCEPTION 'payer rate policy verification requires a separate reviewer path';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_payer_rate_policy_status
  BEFORE INSERT ON medicaid_payer_rate_policy
  FOR EACH ROW EXECUTE FUNCTION guard_medicaid_payer_rate_policy_status();--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_medicaid_payer_rate_policy_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'medicaid_payer_rate_policy is append-only';
END $$;--> statement-breakpoint
CREATE TRIGGER trg_medicaid_payer_rate_policy_append_only
  BEFORE UPDATE OR DELETE ON medicaid_payer_rate_policy
  FOR EACH ROW EXECUTE FUNCTION guard_medicaid_payer_rate_policy_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_write_medicaid_payer_rate_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_after jsonb;
BEGIN
  v_after := audit_scrub(to_jsonb(NEW), ARRAY['source_document_ref']::text[]);
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    NEW.organization_id, NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'medicaid_payer_rate_policy.insert', TG_TABLE_NAME, NEW.id,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', NULL, v_after, '{}'::jsonb, 'compliance'
  );
  RETURN NEW;
END $$;--> statement-breakpoint
ALTER FUNCTION audit_write_medicaid_payer_rate_policy() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER trg_audit_medicaid_payer_rate_policy
  AFTER INSERT ON medicaid_payer_rate_policy
  FOR EACH ROW EXECUTE FUNCTION audit_write_medicaid_payer_rate_policy();
