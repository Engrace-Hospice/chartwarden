-- compat: contract
-- M3 (slice 2) - the role key `external_auditor` belongs to the SYSTEM role. M3's auditor grant creates it in a tenant org on the first
-- magic-link redemption (org-owned, system_default, category external_auditor) and attaches every auditor to it; the M35 staff meter
-- tells that row from a look-alike by exactly those three facts. A tenant that could create its own role under the key would get a row
-- the grant finds by key (so an auditor lands on a tenant-editable role) and one it could attach to staff to try to hide them from the
-- bill. The route refuses it (POST /api/v1/roles, 422 RESERVED_ROLE); this trigger is the backstop for every other writer, in the
-- shape of the 0318 CHECK that keeps platform authority off tenant rows.
-- Declared `contract`: a write the previous release allowed (a tenant role under that key) is now refused. Existing rows are not touched.
CREATE OR REPLACE FUNCTION role_system_managed_key_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.key = 'external_auditor'
     AND NOT (NEW.organization_id IS NOT NULL AND NEW.system_default AND NEW.category = 'external_auditor') THEN
    RAISE EXCEPTION 'role %: the key external_auditor is the system auditor role, which only the auditor grant creates', NEW.key
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "role_system_managed_key_guard" ON "role";--> statement-breakpoint
CREATE TRIGGER "role_system_managed_key_guard" BEFORE INSERT OR UPDATE OF "key", "system_default", "category" ON "role"
  FOR EACH ROW EXECUTE FUNCTION role_system_managed_key_guard();
