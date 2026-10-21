-- FIXTURE — the remediation half. `fixture_superseded_self` was org-unscoped when 0001 created it;
-- this migration drops and replaces it with the org conjunct, which is how a real RLS fix ships
-- (the offending CREATE POLICY text never leaves the migration that introduced it).
--
-- A gate that reads file text and stops there can never go green again after a correct fix. This
-- policy must NOT be reported.
DROP POLICY IF EXISTS fixture_superseded_self ON fixture_super;--> statement-breakpoint
CREATE POLICY fixture_superseded_self ON fixture_super
  FOR ALL TO chartwarden_app
  USING (
    organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
