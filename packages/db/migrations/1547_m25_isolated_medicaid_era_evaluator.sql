-- compat: contract
-- L6C2: restore nonposting review writes only for the isolated M25 evaluator identity.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_m25_evaluator') THEN
    CREATE ROLE chartwarden_m25_evaluator NOLOGIN NOBYPASSRLS NOINHERIT;
  END IF;
END $$;
--> statement-breakpoint
-- A pre-existing role name is not proof of safe attributes. Normalize it before assigning privileges.
ALTER ROLE chartwarden_m25_evaluator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_shdepend
     WHERE refclassid = 'pg_authid'::regclass
       AND refobjid = (SELECT oid FROM pg_roles WHERE rolname = 'chartwarden_m25_evaluator')
       AND deptype = 'o'
  ) THEN
    RAISE EXCEPTION 'chartwarden_m25_evaluator owns database objects; isolate or remove the role before migration';
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE member_role text;
BEGIN
  FOREACH member_role IN ARRAY ARRAY[
    'chartwarden_app', 'chartwarden_platform', 'chartwarden_platform_login'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = member_role) THEN
      EXECUTE format('REVOKE chartwarden_m25_evaluator FROM %I', member_role);
    END IF;
  END LOOP;
  FOR member_role IN
    SELECT granted.rolname
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
    WHERE member.rolname = 'chartwarden_m25_evaluator'
  LOOP
    EXECUTE format('REVOKE %I FROM chartwarden_m25_evaluator', member_role);
  END LOOP;
  FOR member_role IN
    SELECT member.rolname
    FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid = membership.member
    WHERE membership.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'chartwarden_m25_evaluator')
  LOOP
    EXECUTE format('REVOKE chartwarden_m25_evaluator FROM %I', member_role);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM chartwarden_m25_evaluator;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM chartwarden_m25_evaluator;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM chartwarden_m25_evaluator;
--> statement-breakpoint
ALTER TABLE medicaid_era_review DROP CONSTRAINT medicaid_era_review_assessment_trust_status_check;
--> statement-breakpoint
ALTER TABLE medicaid_era_review ADD CONSTRAINT medicaid_era_review_assessment_trust_status_check
  CHECK (assessment_trust_status IN ('legacy_unverified', 'isolated_evaluator'));
--> statement-breakpoint
ALTER TABLE medicaid_era_review_history
  ADD COLUMN trust_status varchar(24) NOT NULL DEFAULT 'legacy_unverified'
    CHECK (trust_status IN ('legacy_unverified', 'isolated_evaluator')),
  ADD COLUMN operation_fingerprint varchar(64)
    CHECK (operation_fingerprint IS NULL OR operation_fingerprint ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
CREATE POLICY medicaid_era_review_evaluator ON medicaid_era_review FOR ALL TO chartwarden_m25_evaluator
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND assessment_trust_status = 'isolated_evaluator'
    AND EXISTS (
      SELECT 1 FROM claimmd_era_m25_stage stage
      WHERE stage.id = medicaid_era_review.stage_id
        AND stage.organization_id = medicaid_era_review.organization_id
        AND stage.provider_entity_id = medicaid_era_review.provider_entity_id
    )
  );
--> statement-breakpoint
CREATE POLICY claimmd_era_m25_stage_evaluator_read ON claimmd_era_m25_stage
  FOR SELECT TO chartwarden_m25_evaluator
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY medicaid_era_review_history_evaluator ON medicaid_era_review_history
  FOR INSERT TO chartwarden_m25_evaluator
  WITH CHECK (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND trust_status = 'isolated_evaluator'
    AND EXISTS (
      SELECT 1 FROM medicaid_era_review review
      WHERE review.id = medicaid_era_review_history.review_id
        AND review.organization_id = medicaid_era_review_history.organization_id
        AND review.provider_entity_id = medicaid_era_review_history.provider_entity_id
        AND review.assessment_trust_status = 'isolated_evaluator'
    )
  );
--> statement-breakpoint
CREATE POLICY medicaid_era_review_history_evaluator_read ON medicaid_era_review_history
  FOR SELECT TO chartwarden_m25_evaluator
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO chartwarden_m25_evaluator;
GRANT SELECT ON claimmd_era_m25_stage, medicaid_era_review, medicaid_era_review_history TO chartwarden_m25_evaluator;
GRANT INSERT, UPDATE ON medicaid_era_review TO chartwarden_m25_evaluator;
GRANT INSERT ON medicaid_era_review_history TO chartwarden_m25_evaluator;
--> statement-breakpoint
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['chartwarden_platform', 'chartwarden_platform_login'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL ON medicaid_era_review, medicaid_era_review_history FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END $$;
