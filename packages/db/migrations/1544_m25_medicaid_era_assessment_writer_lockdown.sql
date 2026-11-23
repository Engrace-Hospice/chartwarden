-- compat: contract
-- L6C: the general platform SQL identity is not an evaluator identity. Keep old assessments,
-- mark them unverified and remove every application/platform write path until a separately isolated
-- evaluator/writer capability is implemented and qualified.
ALTER TABLE medicaid_era_review
  ADD COLUMN assessment_trust_status varchar(24) NOT NULL DEFAULT 'legacy_unverified'
    CHECK (assessment_trust_status = 'legacy_unverified');
--> statement-breakpoint
ALTER TABLE medicaid_era_review
  ADD CONSTRAINT medicaid_era_review_nonposting_summary_ck
  CHECK (NOT jsonb_path_exists(safe_summary, '$.**.postingAuthorized ? (@ == true)'));
--> statement-breakpoint
DO $$
DECLARE
  role_name text;
  table_name text;
  column_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['PUBLIC', 'chartwarden_app', 'chartwarden_platform', 'chartwarden_platform_login'] LOOP
    FOREACH table_name IN ARRAY ARRAY['medicaid_era_review', 'medicaid_era_review_history'] LOOP
      IF role_name = 'PUBLIC' OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I FROM %s', table_name,
          CASE WHEN role_name = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(role_name) END);
        FOR column_name IN
          SELECT attname
          FROM pg_attribute
          WHERE attrelid = table_name::regclass
            AND attnum > 0
            AND NOT attisdropped
        LOOP
          EXECUTE format(
            'REVOKE INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON TABLE %2$I FROM %3$s',
            column_name,
            table_name,
            CASE WHEN role_name = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(role_name) END
          );
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT ON medicaid_era_review, medicaid_era_review_history TO chartwarden_app;
--> statement-breakpoint
-- Review duplicate checks execute under tenant RLS. The cross-tenant platform role needs no review
-- read access and must not inspect these financial summaries directly.
