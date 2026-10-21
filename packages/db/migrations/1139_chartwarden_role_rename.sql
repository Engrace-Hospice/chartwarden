-- 1139 — rename the database roles wardenx_* -> chartwarden_* (ChartWarden rebrand, Phase 4).
--
-- ALTER ROLE ... RENAME keeps every grant, default privilege, ownership, membership and RLS policy
-- attached to the role (they reference its OID, not its name), so nothing is re-granted. SCRAM
-- verifiers do not depend on the role name, so passwords survive the rename too (PostgreSQL clears an MD5
-- verifier on rename, so confirm `password_encryption` is scram-sha-256 before a production run).
--
-- Idempotent and order-tolerant: a role is renamed only when the old name exists and the new one does
-- not (and, when both exist, the new role inherits the old one), so a fresh database (where 0001 just created wardenx_*), an upgraded one, and a re-run all end in
-- the same state. The LOGIN roles and the platform/m36 carriers are created by
-- scripts/db/provision-runtime-roles.ts, not by a migration, so they may be absent here; that script
-- creates them under the new names when they are.
--
-- Legacy alias: ten already-applied function bodies test `pg_has_role(current_user, 'wardenx_destruction',
-- 'MEMBER')` (0272, 0279-0281, 0394, 1056, 1060, 1061, 1107). Applied migrations are checksummed and
-- cannot be edited, so a NOLOGIN, privilege-free role keeps the old name and chartwarden_destruction is
-- made a member of it; membership is transitive, so the login role still tests true. The alias holds no
-- grants and cannot connect. Drop it only after those bodies are rewritten.

DO $$
DECLARE
  pair text[];
BEGIN
  -- Renaming clears an MD5 verifier, which would silently lock the role out: refuse instead of running.
  IF EXISTS (SELECT FROM pg_authid WHERE rolname LIKE 'wardenx\_%' AND rolpassword LIKE 'md5%') THEN
    RAISE EXCEPTION '1139: a wardenx_* role has an MD5 password verifier; renaming would clear it. Re-set it under password_encryption = scram-sha-256 first.';
  END IF;
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['wardenx_app', 'chartwarden_app'],
    ['wardenx_admin', 'chartwarden_admin'],
    ['wardenx_readonly', 'chartwarden_readonly'],
    ['wardenx_audit_writer', 'chartwarden_audit_writer'],
    ['wardenx_platform', 'chartwarden_platform'],
    ['wardenx_platform_login', 'chartwarden_platform_login'],
    ['wardenx_destruction', 'chartwarden_destruction'],
    ['wardenx_destruction_login', 'chartwarden_destruction_login'],
    ['wardenx_m36_reseal', 'chartwarden_m36_reseal'],
    ['wardenx_body_backfill_login', 'chartwarden_body_backfill_login']
  ]
  LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = pair[1])
       AND NOT EXISTS (SELECT FROM pg_roles WHERE rolname = pair[2]) THEN
      EXECUTE format('ALTER ROLE %I RENAME TO %I', pair[1], pair[2]);
    ELSIF EXISTS (SELECT FROM pg_roles WHERE rolname = pair[1])
          AND EXISTS (SELECT FROM pg_roles WHERE rolname = pair[2])
          AND NOT pg_has_role(pair[2], pair[1], 'MEMBER') THEN
      -- Roles are cluster-global: another database in this cluster was already migrated (the new name exists),
      -- and this one just got a fresh wardenx_* role from 0001/0157. Grants and policies here name the old
      -- role, so make the new one a member that inherits them instead of renaming.
      EXECUTE format('GRANT %I TO %I', pair[1], pair[2]);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wardenx_destruction') THEN
    CREATE ROLE wardenx_destruction NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'chartwarden_destruction')
     AND NOT pg_has_role('chartwarden_destruction', 'wardenx_destruction', 'MEMBER') THEN
    GRANT wardenx_destruction TO chartwarden_destruction;
  END IF;
END $$;--> statement-breakpoint

-- 1107's trigger also compares current_user / the `role` setting to the literal old name. The session_user
-- branch already covers a login that is a member of the destruction role; accept the new name directly too.
CREATE OR REPLACE FUNCTION message_ack_event_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (
       current_user IN ('chartwarden_destruction', 'wardenx_destruction')
    OR current_setting('role', true) IN ('chartwarden_destruction', 'wardenx_destruction')
    OR (pg_has_role(session_user, 'wardenx_destruction', 'MEMBER')
        AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user))) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'message_ack_event_append_only: the history cannot be changed or removed' USING ERRCODE = 'check_violation';
END $$;
