-- compat: expand
-- M23-CM-4A.2: encrypted, immutable X12 artifact for an existing render identity.
-- Migration 1489 may already exist in shared environments; this is forward-only.
CREATE TABLE medicare_notice_render_artifact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  render_identity_id uuid NOT NULL REFERENCES medicare_notice_render_identity(id) ON DELETE RESTRICT,
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) >= 32),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  plaintext_byte_length integer NOT NULL CHECK (plaintext_byte_length > 0),
  encryption_key_version text NOT NULL CHECK (encryption_key_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  artifact_version text NOT NULL DEFAULT 'm23-notice-x12-v1',
  state text NOT NULL DEFAULT 'finalized' CHECK (state IN ('finalized','corrupt')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medicare_notice_render_artifact_identity_uq UNIQUE (organization_id, render_identity_id)
);
CREATE INDEX medicare_notice_render_artifact_recovery_ix
  ON medicare_notice_render_artifact (organization_id, render_identity_id, state);
ALTER TABLE medicare_notice_render_artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicare_notice_render_artifact FORCE ROW LEVEL SECURITY;
CREATE POLICY medicare_notice_render_artifact_org ON medicare_notice_render_artifact
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON medicare_notice_render_artifact TO chartwarden_app;

CREATE OR REPLACE FUNCTION medicare_notice_render_artifact_identity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'medicare notice render artifacts are immutable'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.state = 'finalized' AND NEW.state = 'corrupt'
      AND (to_jsonb(NEW) - 'state') = (to_jsonb(OLD) - 'state') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'medicare notice render artifacts are immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM medicare_notice_render_identity i
    WHERE i.id = NEW.render_identity_id AND i.organization_id = NEW.organization_id
  ) THEN RAISE EXCEPTION 'medicare notice artifact identity is outside organization scope'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_medicare_notice_render_artifact_immutable
  BEFORE UPDATE OR DELETE OR INSERT ON medicare_notice_render_artifact
  FOR EACH ROW EXECUTE FUNCTION medicare_notice_render_artifact_identity_guard();

CREATE OR REPLACE FUNCTION audit_phi_write_medicare_notice_render_artifact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (NEW.organization_id, NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system', 'm23.medicare_notice_render_artifact.created', 'medicare_notice_render_artifact', NEW.id,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', NULL, NULL,
    jsonb_build_object('render_identity_id', NEW.render_identity_id, 'state', NEW.state,
      'content_sha256', NEW.content_sha256, 'plaintext_byte_length', NEW.plaintext_byte_length), 'compliance');
  RETURN NEW;
END $$;
ALTER FUNCTION audit_phi_write_medicare_notice_render_artifact() OWNER TO wardenx_audit_writer;
CREATE TRIGGER trg_audit_medicare_notice_render_artifact AFTER INSERT ON medicare_notice_render_artifact
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medicare_notice_render_artifact();

CREATE OR REPLACE FUNCTION audit_medicare_notice_render_artifact_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (NEW.organization_id, NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system', 'm23.medicare_notice_artifact.corrupt', 'medicare_notice_render_artifact', NEW.id,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'failure', 'critical', NULL, NULL, jsonb_build_object('render_identity_id', NEW.render_identity_id), 'compliance');
  RETURN NEW;
END $$;
ALTER FUNCTION audit_medicare_notice_render_artifact_state() OWNER TO wardenx_audit_writer;
CREATE TRIGGER trg_audit_medicare_notice_render_artifact_state AFTER UPDATE OF state ON medicare_notice_render_artifact
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION audit_medicare_notice_render_artifact_state();
