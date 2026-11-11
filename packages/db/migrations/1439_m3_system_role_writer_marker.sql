-- compat: contract
-- M3 (slice 2) - the system auditor row also needs the auditor grant's own marker (tightens the 1415 trigger).
-- 1415 told the system row from a look-alike by three facts on the row: org-owned, system_default, category external_auditor. The app
-- role (chartwarden_app) holds INSERT and UPDATE on every `role` column (migration 0009), so any code running as it could write all
-- three, and a tenant-created role under the key would then pass the guard. The row's facts are therefore not enough: the guard also
-- asks for a transaction-local setting, app.system_role_writer = 'auditor_grant', which only M3's auditor grant sets
-- (auditor-access-grant.ts, `set_config(..., true)`, the shape migration 1126 uses for app.ack_supervisor_reassign). It stops every
-- other code path from writing the system row; it is not a defence against a session that can run arbitrary SQL as the app role.
-- Declared `contract`: a write the previous release allowed (the system-shaped row without the marker) is now refused. Existing rows
-- are not touched.
CREATE OR REPLACE FUNCTION role_system_managed_key_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.key = 'external_auditor'
     AND NOT (NEW.organization_id IS NOT NULL AND NEW.system_default AND NEW.category = 'external_auditor'
              AND COALESCE(current_setting('app.system_role_writer', true), '') = 'auditor_grant') THEN
    RAISE EXCEPTION 'role %: the key external_auditor is the system auditor role, which only the auditor grant creates', NEW.key
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
