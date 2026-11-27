-- compat: contract
-- CW-MON-01 follow-up 2 (#1185) — the audit.archive job's SECURITY DEFINER functions get a duty role of their own, and the platform login
-- loses every path to them.
--
-- THE GAP THIS CLOSES. Migration 1566 took the BYPASSRLS platform login's direct read of `audit_event` away, but the platform carrier
-- (`chartwarden_platform`, which only that login inherits) still held EXECUTE, granted by the runtime-role provisioner, on the three
-- functions of the audit.archive job (migration 0432, 1053): `audit_archive_candidates(integer)` (closed partitions and their row counts),
-- `audit_archive_read_batch(text, uuid, integer)` (WHOLE rows as jsonb, `before` and `after` included, of every tenant's closed monthly
-- partition) and `audit_archive_detach(text, bigint, boolean)` (takes a closed partition out of `audit_event`; the table is kept, never
-- dropped, and no audit row is written; its legal-hold guard trusts the caller's `p_manifest_verified`). So the login could read a closed
-- month in full and take it out of every `audit_event` scan. After this migration it can do neither: no role but the duty role below holds
-- EXECUTE.
--
-- THE DUTY ROLE. `chartwarden_audit_archiver` is a new NOLOGIN carrier with no BYPASSRLS, no privilege on any table and no membership of
-- anything. It holds USAGE on `public` and EXPLICIT EXECUTE grants on exactly four functions (like every role it also inherits what
-- PUBLIC holds): the three above and `audit_writer_insert_platform_event`
-- (the platform audit writer, because the job's `withPlatformContext` entry writes its critical `platform.bypass_invoked` row on the
-- connection it runs on). Nothing grants it to `chartwarden_platform`, `chartwarden_platform_login`, `chartwarden_app` or any other
-- role; the one member it may have is the login `chartwarden_audit_archive_login`, which only the operator's provisioner creates
-- (CHARTWARDEN_AUDIT_ARCHIVE_PASSWORD; migrations never carry a credential) and which the backend reaches as DATABASE_AUDIT_ARCHIVE_URL.
-- The job runs on that login's pool and never on the platform pool, so its behaviour is unchanged: the same functions, the same
-- arguments, the same critical bypass row.
--
-- THE FUNCTIONS ARE NOT CHANGED. They stay SECURITY DEFINER, each with `search_path = public, pg_catalog, pg_temp` (migration 1556 put
-- pg_temp last), and each validates its partition name against `pg_inherits` before using it. Their OWNER is whoever ran the migrations
-- (the `postgres` superuser in production): detaching a partition needs ownership of `audit_event`, and reading every tenant's closed
-- month needs BYPASSRLS, so a non-login owner would first have to own the audit trail and every partition rotation creates. That is a
-- separate, much larger change and is NOT done here; what this migration removes is every way for a login other than the archive's
-- to call them.
--
-- WHAT THE REVOKE REMOVES. Catalog-driven, not a list of names: every EXECUTE grant on the four archive functions to any role other than
-- the owner and the duty role (PUBLIC, the tenant pool, the platform carrier and login, an admin or reader role, anything a later grant
-- added) is revoked, so a role the repo does not know of cannot keep a path.
--
-- CONTRACT, and why: the REVOKE removes a privilege the previous release's audit.archive job (it runs on the platform pool) still uses,
-- and the new release is what reads DATABASE_AUDIT_ARCHIVE_URL. deploy.sh therefore holds this migration for an operator (exit 75,
-- previous release untouched), together with any other held contract migration (1566 while it is unapplied); the operator applies the
-- batch and rolls the release together (docs/runbooks/security-alert-review.md section 7). The job is monthly (cron `30 3 2 * *`) and
-- only runs where AUDIT_ARCHIVE_BUCKET is set, so in the gap the previous release's job fails with 42501 at worst once, loudly (its queue
-- retries and the DLQ alert fires) and moves nothing; a closed partition is never detached by a failed run. Rolling back to the previous
-- release after this migration is not possible for the same reason: roll forward.
--
-- Idempotent: IF NOT EXISTS, ALTER ROLE normalisation, GRANT, and a REVOKE of privileges that may not be held.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_audit_archiver') THEN
    CREATE ROLE chartwarden_audit_archiver NOLOGIN NOBYPASSRLS NOINHERIT;
  END IF;
END $$;--> statement-breakpoint
-- A pre-existing role of this name is not proof of safe attributes: normalise it before it is given anything.
ALTER ROLE chartwarden_audit_archiver NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_shdepend
     WHERE refclassid = 'pg_authid'::regclass
       AND refobjid = (SELECT oid FROM pg_roles WHERE rolname = 'chartwarden_audit_archiver')
       AND deptype = 'o'
  ) THEN
    RAISE EXCEPTION 'chartwarden_audit_archiver owns database objects; isolate or remove the role before migration';
  END IF;
END $$;--> statement-breakpoint
-- The duty role is a member of nothing, and nobody holds it except the archive login: the platform carrier and login, the tenant pool and
-- any other role are removed from it, so no membership can hand its EXECUTE on.
DO $$
DECLARE
  related record;
BEGIN
  FOR related IN
    SELECT granted.rolname AS granted_name, member.rolname AS member_name
      FROM pg_auth_members membership
      JOIN pg_roles granted ON granted.oid = membership.roleid
      JOIN pg_roles member ON member.oid = membership.member
     WHERE (member.rolname = 'chartwarden_audit_archiver'
            OR (granted.rolname = 'chartwarden_audit_archiver'
                AND member.rolname <> 'chartwarden_audit_archive_login'))
  LOOP
    EXECUTE format('REVOKE %I FROM %I', related.granted_name, related.member_name);
  END LOOP;
END $$;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM chartwarden_audit_archiver;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM chartwarden_audit_archiver;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM chartwarden_audit_archiver;--> statement-breakpoint
COMMENT ON ROLE chartwarden_audit_archiver IS
  'CW-MON-01 follow-up 2: the only role with EXECUTE on the audit.archive SECURITY DEFINER functions (audit_archive_candidates / _read_batch / _detach) and the platform audit writer. NOLOGIN, no BYPASSRLS, member of nothing; its one member is chartwarden_audit_archive_login (operator-provisioned, DATABASE_AUDIT_ARCHIVE_URL). Never grant it to the platform carrier or login.';--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO chartwarden_audit_archiver;--> statement-breakpoint

-- Revoke every other grantee of the four archive functions (PUBLIC included), read from the catalog. The owner's own privilege is not
-- touched (a function's owner always holds EXECUTE), and the duty role's grant is made below.
DO $$
DECLARE
  held record;
BEGIN
  FOR held IN
    SELECT p.oid::regprocedure AS signature, a.grantee
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     WHERE ns.nspname = 'public'
       AND p.proname IN ('audit_archive_closed_partitions', 'audit_archive_candidates',
                         'audit_archive_read_batch', 'audit_archive_detach')
       AND a.privilege_type = 'EXECUTE'
       AND a.grantee <> p.proowner
       AND a.grantee <> (SELECT oid FROM pg_roles WHERE rolname = 'chartwarden_audit_archiver')
  LOOP
    IF held.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', held.signature);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', held.signature,
                     (SELECT rolname FROM pg_roles WHERE oid = held.grantee));
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.audit_archive_candidates(integer) TO chartwarden_audit_archiver;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.audit_archive_read_batch(text, uuid, integer) TO chartwarden_audit_archiver;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.audit_archive_detach(text, bigint, boolean) TO chartwarden_audit_archiver;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.audit_writer_insert_platform_event(text, text, uuid, text, text, text, jsonb, text)
  TO chartwarden_audit_archiver;
