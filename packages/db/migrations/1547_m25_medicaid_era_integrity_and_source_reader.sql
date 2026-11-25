-- compat: contract
-- L6C2: one-shot, audited access to an already tenant-staged Claim.MD artifact, plus durable
-- idempotency reservations for nonposting review commands.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_m25_era_source') THEN
    CREATE ROLE chartwarden_m25_era_source NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_m25_era_source_resolver') THEN
    CREATE ROLE chartwarden_m25_era_source_resolver NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END $$;
--> statement-breakpoint
ALTER ROLE chartwarden_m25_era_source NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE chartwarden_m25_era_source_resolver NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_shdepend
     WHERE refclassid = 'pg_authid'::regclass
       AND refobjid IN (
         SELECT oid FROM pg_roles
          WHERE rolname IN ('chartwarden_m25_era_source','chartwarden_m25_era_source_resolver')
       )
       AND deptype = 'o'
       -- Roles are cluster-global: only objects in THIS database (or shared ones, dbid 0) count, or a second database
       -- on the cluster could never apply this file once the first one holds the resolver's function.
       AND dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
  ) THEN
    RAISE EXCEPTION 'M25 ERA source roles own database objects; isolate or remove the roles before migration';
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE granted_role text;
BEGIN
  FOR granted_role IN
    SELECT granted.rolname
      FROM pg_auth_members membership
      JOIN pg_roles granted ON granted.oid = membership.roleid
      JOIN pg_roles member ON member.oid = membership.member
     WHERE member.rolname IN ('chartwarden_m25_era_source','chartwarden_m25_era_source_resolver')
  LOOP
    EXECUTE format('REVOKE %I FROM chartwarden_m25_era_source', granted_role);
    EXECUTE format('REVOKE %I FROM chartwarden_m25_era_source_resolver', granted_role);
  END LOOP;
  FOR granted_role IN
    SELECT member.rolname
      FROM pg_auth_members membership
      JOIN pg_roles member ON member.oid = membership.member
     WHERE membership.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'chartwarden_m25_era_source')
  LOOP
    EXECUTE format('REVOKE chartwarden_m25_era_source FROM %I', granted_role);
  END LOOP;
  FOR granted_role IN
    SELECT member.rolname
      FROM pg_auth_members membership
      JOIN pg_roles member ON member.oid = membership.member
     WHERE membership.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'chartwarden_m25_era_source_resolver')
  LOOP
    EXECUTE format('REVOKE chartwarden_m25_era_source_resolver FROM %I', granted_role);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM chartwarden_m25_era_source;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM chartwarden_m25_era_source_resolver;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM chartwarden_m25_era_source;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM chartwarden_m25_era_source_resolver;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM chartwarden_m25_era_source;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM chartwarden_m25_era_source_resolver;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO chartwarden_m25_era_source_resolver;
GRANT USAGE ON SCHEMA public TO chartwarden_m25_era_source;
--> statement-breakpoint
CREATE POLICY claimmd_era_stage_source_resolver_read ON claimmd_era_m25_stage
  FOR SELECT TO chartwarden_m25_era_source_resolver USING (true);
CREATE POLICY claimmd_era_inbox_source_resolver_read ON claimmd_era_inbox
  FOR SELECT TO chartwarden_m25_era_source_resolver USING (true);
CREATE POLICY claimmd_era_delivery_source_resolver_read ON claimmd_era_delivery
  FOR SELECT TO chartwarden_m25_era_source_resolver USING (true);
--> statement-breakpoint
GRANT SELECT (id,organization_id,provider_entity_id,source_inbox_id,vendor,account_reference,usage,era_id,
  file_index,original_835_digest,source_file_digest,state,safe_reason_code)
  ON claimmd_era_m25_stage TO chartwarden_m25_era_source_resolver;
GRANT SELECT (id,stream_id,vendor,account_reference,usage,era_id,capture_state,captured_at,original_835_digest,
  original_835_key_id,original_835_cipher,original_835_file_count) ON claimmd_era_inbox TO chartwarden_m25_era_source_resolver;
GRANT SELECT (inbox_id,resolution_id,resolution_version,vendor,account_reference,usage,era_id,original_835_digest,
  organization_id,provider_entity_id,state,stage_ids) ON claimmd_era_delivery TO chartwarden_m25_era_source_resolver;
GRANT EXECUTE ON FUNCTION audit_writer_insert_platform_event(text,text,uuid,text,text,text,jsonb,text)
  TO chartwarden_m25_era_source_resolver;
--> statement-breakpoint
-- The resolver audits each read through this definer function, and its search_path (0187) does not name pg_temp, so
-- Postgres searches the caller's temp schema first: the source-login holder could create a TEMP audit_event, grant INSERT
-- on it to PUBLIC, and have the audit row land there while the ciphertext is still returned. Pin pg_temp last.
ALTER FUNCTION audit_writer_insert_platform_event(text,text,uuid,text,text,text,jsonb,text)
  SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
CREATE FUNCTION m25_read_staged_claimmd_era(
  p_stage_id uuid,
  p_organization_id uuid,
  p_provider_entity_id uuid
) RETURNS TABLE (
  stage_id uuid,
  source_inbox_id uuid,
  stream_id uuid,
  vendor text,
  account_reference text,
  usage text,
  era_id text,
  file_index integer,
  stage_digest text,
  stage_state text,
  safe_reason_code text,
  captured_at timestamptz,
  inbox_digest text,
  key_id text,
  cipher_text text,
  file_count integer,
  delivery_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s RECORD;
  i RECORD;
  d RECORD;
BEGIN
  SELECT stage.id,stage.organization_id,stage.provider_entity_id,stage.source_inbox_id,stage.vendor,
         stage.account_reference,stage.usage,stage.era_id,stage.file_index,stage.original_835_digest,
         stage.source_file_digest,stage.state,stage.safe_reason_code
    INTO s
    FROM claimmd_era_m25_stage stage
   WHERE stage.id = p_stage_id AND stage.organization_id = p_organization_id
     AND stage.provider_entity_id = p_provider_entity_id
     AND stage.vendor = 'claimmd'
     AND stage.source_file_digest IS NOT NULL
     AND (stage.state = 'staged'
       OR (stage.state = 'possible_duplicate' AND stage.safe_reason_code = 'POSSIBLE_CROSS_SOURCE_DUPLICATE')
       OR (stage.state = 'held' AND stage.safe_reason_code = 'EXACT_CROSS_SOURCE_DUPLICATE'));
  IF NOT FOUND THEN RETURN; END IF;

  SELECT delivery.inbox_id,delivery.resolution_id,delivery.resolution_version,delivery.vendor,
         delivery.account_reference,delivery.usage,delivery.era_id,delivery.original_835_digest,
         delivery.organization_id,delivery.provider_entity_id,delivery.state,delivery.stage_ids
    INTO d
    FROM claimmd_era_delivery delivery
   WHERE delivery.inbox_id = s.source_inbox_id
     AND delivery.organization_id = s.organization_id
     AND delivery.provider_entity_id = s.provider_entity_id
     AND delivery.vendor = s.vendor
     AND delivery.account_reference = s.account_reference
     AND delivery.usage = s.usage
     AND delivery.era_id = s.era_id
     AND delivery.original_835_digest = s.original_835_digest
     AND s.id = ANY(delivery.stage_ids)
     AND delivery.state IN ('delivered','possible_duplicate','exact_duplicate','held');
  IF NOT FOUND THEN RETURN; END IF;

  SELECT inbox.id,inbox.stream_id,inbox.vendor,inbox.account_reference,inbox.usage,inbox.era_id,
         inbox.capture_state,inbox.captured_at,inbox.original_835_digest,inbox.original_835_key_id,
         inbox.original_835_cipher,inbox.original_835_file_count
    INTO i
    FROM claimmd_era_inbox inbox
   WHERE inbox.id = s.source_inbox_id
     AND inbox.stream_id IS NOT NULL
     AND inbox.vendor = s.vendor
     AND inbox.account_reference = s.account_reference
     AND inbox.usage = s.usage
     AND inbox.era_id = s.era_id
     AND inbox.capture_state = 'captured'
     AND inbox.original_835_digest = d.original_835_digest;
  IF NOT FOUND OR i.original_835_cipher IS NULL OR i.original_835_key_id IS NULL
    OR i.original_835_file_count IS NULL OR i.captured_at IS NULL THEN
    RETURN;
  END IF;

  PERFORM audit_writer_insert_platform_event(
    'platform.bypass_invoked',
    'claimmd_era_m25_stage',
    s.id,
    'success',
    'critical',
    'm25-era-source:' || s.id::text || ':' || gen_random_uuid()::text,
    jsonb_build_object('jobId','m25-evaluator-source-reader','reasonCode','CLAIMMD_ERA_SOURCE_READ'),
    'compliance'
  );

  RETURN QUERY SELECT s.id,s.source_inbox_id,i.stream_id,s.vendor,s.account_reference,s.usage,s.era_id,
    s.file_index,s.source_file_digest,s.state,s.safe_reason_code,i.captured_at,
    i.original_835_digest,i.original_835_key_id,i.original_835_cipher,i.original_835_file_count,d.state;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION m25_read_staged_claimmd_era(uuid,uuid,uuid) OWNER TO chartwarden_m25_era_source_resolver;
REVOKE ALL ON FUNCTION m25_read_staged_claimmd_era(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION m25_read_staged_claimmd_era(uuid,uuid,uuid) TO chartwarden_m25_era_source;
--> statement-breakpoint
CREATE TABLE medicaid_era_review_idempotency (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL,
  review_id uuid NOT NULL REFERENCES medicaid_era_review(id) ON DELETE RESTRICT,
  idempotency_key_hash varchar(64) NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  operation varchar(16) NOT NULL CHECK (operation IN ('evaluate','note','transition')),
  operation_fingerprint varchar(64) NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,idempotency_key_hash)
);
--> statement-breakpoint
INSERT INTO medicaid_era_review_idempotency
  (organization_id,provider_entity_id,review_id,idempotency_key_hash,operation,operation_fingerprint,created_at)
SELECT organization_id,provider_entity_id,review_id,idempotency_key_hash,
  CASE WHEN action IN ('assessed','reassessed') THEN 'evaluate'
       WHEN action = 'note' THEN 'note'
       ELSE 'transition' END,
  operation_fingerprint,created_at
FROM medicaid_era_review_history
WHERE idempotency_key_hash IS NOT NULL AND operation_fingerprint IS NOT NULL
ON CONFLICT (organization_id,idempotency_key_hash) DO NOTHING;
--> statement-breakpoint
CREATE INDEX medicaid_era_review_idempotency_review_ix
  ON medicaid_era_review_idempotency(organization_id,provider_entity_id,review_id);
-- The review FK is RESTRICT and medicaid_era_review is not a soft-deleted parent: its delete scan needs an index that
-- leads with review_id (fk-index-coverage.live.test.ts); the index above leads with organization_id.
CREATE INDEX medicaid_era_review_idempotency_review_fk_ix
  ON medicaid_era_review_idempotency(review_id);
--> statement-breakpoint
ALTER TABLE medicaid_era_review_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicaid_era_review_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY medicaid_era_review_idempotency_evaluator ON medicaid_era_review_idempotency
  FOR ALL TO chartwarden_m25_evaluator
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM medicaid_era_review review
       WHERE review.id = medicaid_era_review_idempotency.review_id
         AND review.organization_id = medicaid_era_review_idempotency.organization_id
         AND review.provider_entity_id = medicaid_era_review_idempotency.provider_entity_id
         AND review.assessment_trust_status = 'isolated_evaluator'
    )
  );
GRANT SELECT,INSERT ON medicaid_era_review_idempotency TO chartwarden_m25_evaluator;
REVOKE UPDATE,DELETE ON medicaid_era_review_idempotency FROM chartwarden_m25_evaluator;
