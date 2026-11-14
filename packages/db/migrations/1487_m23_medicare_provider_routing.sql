-- compat: expand
-- M23-CM-2: Medicare routing is a non-secret business fact, independent of direct-MAC portal credentials.
-- Legacy created_at is the earliest evidenced configuration date, not proof of earlier historical validity.
CREATE TABLE medicare_provider_routing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL,
  mac_jurisdiction m23_mac_jurisdiction NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  provenance text NOT NULL CHECK (provenance IN ('manual', 'legacy_mac_credential')),
  source_legacy_credential_id uuid,
  set_by_membership_id uuid NOT NULL,
  set_reason text NOT NULL CHECK (set_reason IN ('provider_documentation', 'cms_notice', 'legacy_review', 'correction', 'legacy_import_unverified')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medicare_provider_routing_validity_ck CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX medicare_provider_routing_lookup_idx ON medicare_provider_routing (organization_id, provider_entity_id, effective_from);
CREATE UNIQUE INDEX medicare_provider_routing_legacy_source_uq ON medicare_provider_routing (source_legacy_credential_id) WHERE source_legacy_credential_id IS NOT NULL;
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE medicare_provider_routing ADD CONSTRAINT medicare_provider_routing_no_overlap
  EXCLUDE USING gist (organization_id WITH =, provider_entity_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&);

CREATE TABLE medicare_provider_routing_backfill_issue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid,
  legacy_credential_id uuid NOT NULL UNIQUE,
  reason_code text NOT NULL CHECK (reason_code IN ('provider_missing_or_wrong_org', 'canonical_route_exists', 'invalid_legacy_interval')),
  candidate_jurisdictions text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Backfill only where provider ownership is verifiable and no canonical record already exists.
-- Credential creation date is the earliest supportable date; no earlier historical period is inferred.
INSERT INTO medicare_provider_routing (organization_id, provider_entity_id, mac_jurisdiction, effective_from,
  source_legacy_credential_id,
  provenance, set_by_membership_id, set_reason, created_at)
SELECT c.organization_id, c.provider_entity_id, c.mac_jurisdiction, (c.created_at AT TIME ZONE 'UTC')::date, c.id,
  'legacy_mac_credential', c.set_by_membership_id,
  'legacy_import_unverified', c.created_at
FROM mac_submitter_credential c
JOIN provider_entity p ON p.id = c.provider_entity_id AND p.organization_id = c.organization_id
WHERE NOT EXISTS (
  SELECT 1 FROM medicare_provider_routing r
  WHERE r.organization_id = c.organization_id AND r.provider_entity_id = c.provider_entity_id
)
ON CONFLICT DO NOTHING;

-- Existing canonical data, if migration is rerun by an operator, is never overwritten; record this for review.
INSERT INTO medicare_provider_routing_backfill_issue (organization_id, provider_entity_id, legacy_credential_id, reason_code, candidate_jurisdictions)
SELECT c.organization_id, c.provider_entity_id, c.id, 'canonical_route_exists', ARRAY[c.mac_jurisdiction::text]
FROM mac_submitter_credential c
JOIN provider_entity p ON p.id = c.provider_entity_id AND p.organization_id = c.organization_id
WHERE EXISTS (SELECT 1 FROM medicare_provider_routing r WHERE r.organization_id=c.organization_id AND r.provider_entity_id=c.provider_entity_id AND r.source_legacy_credential_id IS DISTINCT FROM c.id)
ON CONFLICT (legacy_credential_id) DO NOTHING;

INSERT INTO medicare_provider_routing_backfill_issue (organization_id, provider_entity_id, legacy_credential_id, reason_code, candidate_jurisdictions)
SELECT c.organization_id, c.provider_entity_id, c.id, 'provider_missing_or_wrong_org', ARRAY[c.mac_jurisdiction::text]
FROM mac_submitter_credential c
LEFT JOIN provider_entity p ON p.id = c.provider_entity_id AND p.organization_id = c.organization_id
WHERE p.id IS NULL
ON CONFLICT (legacy_credential_id) DO NOTHING;

ALTER TABLE medicare_provider_routing ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicare_provider_routing FORCE ROW LEVEL SECURITY;
CREATE POLICY medicare_provider_routing_org ON medicare_provider_routing
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE medicare_provider_routing_backfill_issue ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicare_provider_routing_backfill_issue FORCE ROW LEVEL SECURITY;
CREATE POLICY medicare_provider_routing_issue_org ON medicare_provider_routing_backfill_issue
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON medicare_provider_routing TO chartwarden_app;
GRANT SELECT ON medicare_provider_routing_backfill_issue TO chartwarden_app;

CREATE OR REPLACE FUNCTION medicare_provider_routing_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'medicare provider routing is append-only'; END IF;
  IF (to_jsonb(NEW) - 'effective_to') <> (to_jsonb(OLD) - 'effective_to')
     OR OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL OR NEW.effective_to < OLD.effective_from THEN
    RAISE EXCEPTION 'only closing an open Medicare routing interval is permitted';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER medicare_provider_routing_append_only BEFORE UPDATE OR DELETE ON medicare_provider_routing
  FOR EACH ROW EXECUTE FUNCTION medicare_provider_routing_guard();

CREATE OR REPLACE FUNCTION audit_phi_write_medicare_provider_routing() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'medicare_provider_routing.' || lower(TG_OP), 'medicare_provider_routing', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;
ALTER FUNCTION audit_phi_write_medicare_provider_routing() OWNER TO chartwarden_audit_writer;
CREATE TRIGGER trg_audit_medicare_provider_routing AFTER INSERT OR UPDATE OR DELETE ON medicare_provider_routing
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medicare_provider_routing();
