-- compat: expand
-- M23-CM-4A: durable, immutable identity for internal notice rendering retries.
-- No beneficiary data, MBI, raw X12 payload, or transport secret is stored in this table.
CREATE TABLE medicare_notice_render_identity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  notice_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  notice_kind text NOT NULL CHECK (notice_kind IN ('noe', 'notr', 'transfer_notice', 'cancellation_notice')),
  related_source_id uuid NOT NULL,
  provider_entity_id uuid NOT NULL,
  jurisdiction text NOT NULL CHECK (jurisdiction IN ('ngs_j6','ngs_jk','cgs_j15','palmetto_jj','palmetto_jm','noridian_jf','noridian_je')),
  vendor text NOT NULL CHECK (vendor IN ('claimmd','stedi','direct_mac')),
  account_reference text NOT NULL,
  usage text NOT NULL CHECK (usage IN ('test','production')),
  route_fingerprint text NOT NULL,
  source_version text NOT NULL,
  mapper_version text NOT NULL,
  control_number text NOT NULL,
  fingerprint text NOT NULL,
  isa13 text NOT NULL CHECK (isa13 ~ '^[0-9]{9}$'),
  rendered_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medicare_notice_render_identity_attempt_uq UNIQUE (organization_id, submission_id),
  CONSTRAINT medicare_notice_render_identity_isa13_uq UNIQUE (usage, isa13)
);
CREATE INDEX medicare_notice_render_identity_notice_ix
  ON medicare_notice_render_identity (organization_id, notice_kind, notice_id, created_at);

ALTER TABLE medicare_notice_render_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicare_notice_render_identity FORCE ROW LEVEL SECURITY;
CREATE POLICY medicare_notice_render_identity_org ON medicare_notice_render_identity
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT ON medicare_notice_render_identity TO chartwarden_app;

CREATE OR REPLACE FUNCTION medicare_notice_render_identity_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'medicare notice render identity is immutable';
END;
$$;
CREATE TRIGGER trg_medicare_notice_render_identity_immutable
  BEFORE UPDATE OR DELETE ON medicare_notice_render_identity
  FOR EACH ROW EXECUTE FUNCTION medicare_notice_render_identity_immutable();

CREATE OR REPLACE FUNCTION audit_phi_write_medicare_notice_render_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system', 'm23.medicare_notice_render_identity.' || lower(TG_OP), 'medicare_notice_render_identity',
    COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', NULL, audit_scrub(to_jsonb(NEW), ARRAY[]::text[]),
    jsonb_build_object('notice_kind', COALESCE(NEW.notice_kind, OLD.notice_kind)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;
ALTER FUNCTION audit_phi_write_medicare_notice_render_identity() OWNER TO wardenx_audit_writer;
CREATE TRIGGER trg_audit_medicare_notice_render_identity AFTER INSERT ON medicare_notice_render_identity
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medicare_notice_render_identity();
