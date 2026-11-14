-- compat: expand
-- M23-CM-3: durable, tenant-scoped Claim.MD Medicare payer route and explicit enrollment evidence.
-- Environment route JSON is intentionally not imported: it cannot prove M40 ownership, account ownership,
-- or enrollment. Operators must recreate reviewed routes and separately record verification evidence.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

CREATE TABLE claimmd_medicare_payer_route (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL,
  payer_id uuid NOT NULL,
  mac_jurisdiction m23_mac_jurisdiction NOT NULL,
  account_reference text NOT NULL CHECK (account_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  usage text NOT NULL CHECK (usage IN ('test','production')),
  external_payer_id text NOT NULL CHECK (external_payer_id ~ '^[A-Za-z0-9._-]{1,40}$'),
  transaction_type text NOT NULL CHECK (transaction_type = '837i'),
  effective_from date NOT NULL,
  effective_to date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  provenance text NOT NULL CHECK (provenance IN ('manual_configuration','environment_import_reviewed')),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_medicare_route_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT claimmd_medicare_route_no_overlap EXCLUDE USING gist (
    organization_id WITH =, provider_entity_id WITH =, payer_id WITH =,
    account_reference WITH =, usage WITH =, transaction_type WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (status = 'active')
);--> statement-breakpoint
CREATE INDEX claimmd_medicare_route_lookup_idx ON claimmd_medicare_payer_route
  (organization_id, provider_entity_id, payer_id, account_reference, usage, transaction_type, effective_from);--> statement-breakpoint

CREATE TABLE claimmd_medicare_payer_enrollment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL,
  payer_id uuid NOT NULL,
  account_reference text NOT NULL CHECK (account_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  usage text NOT NULL CHECK (usage IN ('test','production')),
  transaction_type text NOT NULL CHECK (transaction_type = '837i'),
  status text NOT NULL CHECK (status IN ('unknown','pending','verified','not_required','rejected','suspended','expired')),
  verification_source text,
  verification_ref text,
  verified_by_membership_id uuid,
  verified_at timestamptz,
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_medicare_enrollment_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT claimmd_medicare_enrollment_evidence CHECK (
    status NOT IN ('verified','not_required') OR
    (verification_source IS NOT NULL AND verification_ref IS NOT NULL
      AND verification_source IN ('vendor_portal','vendor_written_confirmation','documented_policy')
      AND verification_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$'
      AND verified_by_membership_id IS NOT NULL AND verified_at IS NOT NULL)
  ),
  CONSTRAINT claimmd_medicare_enrollment_exemption_source CHECK (status <> 'not_required' OR verification_source = 'documented_policy'),
  CONSTRAINT claimmd_medicare_enrollment_no_overlap EXCLUDE USING gist (
    organization_id WITH =, provider_entity_id WITH =, payer_id WITH =,
    account_reference WITH =, usage WITH =, transaction_type WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  )
);--> statement-breakpoint
CREATE INDEX claimmd_medicare_enrollment_lookup_idx ON claimmd_medicare_payer_enrollment
  (organization_id, provider_entity_id, payer_id, account_reference, usage, transaction_type, effective_from);--> statement-breakpoint

ALTER TABLE claimmd_medicare_payer_route ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_medicare_payer_route FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_medicare_payer_route_org ON claimmd_medicare_payer_route
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE claimmd_medicare_payer_enrollment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_medicare_payer_enrollment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_medicare_payer_enrollment_org ON claimmd_medicare_payer_enrollment
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON claimmd_medicare_payer_route TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE (effective_to, updated_at) ON claimmd_medicare_payer_route TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON claimmd_medicare_payer_enrollment TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE (effective_to, updated_at) ON claimmd_medicare_payer_enrollment TO chartwarden_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_claimmd_medicare_payer_route() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system', 'claimmd_medicare_payer_route.' || lower(TG_OP), 'claimmd_medicare_payer_route',
    COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) END,
    CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) END,
    jsonb_build_object('provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_claimmd_medicare_payer_route() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER trg_audit_claimmd_medicare_payer_route AFTER INSERT OR UPDATE OR DELETE ON claimmd_medicare_payer_route
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claimmd_medicare_payer_route();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_claimmd_medicare_payer_enrollment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system', 'claimmd_medicare_payer_enrollment.' || lower(TG_OP), 'claimmd_medicare_payer_enrollment',
    COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) END,
    CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) END,
    jsonb_build_object('provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_claimmd_medicare_payer_enrollment() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER trg_audit_claimmd_medicare_payer_enrollment AFTER INSERT OR UPDATE OR DELETE ON claimmd_medicare_payer_enrollment
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claimmd_medicare_payer_enrollment();
