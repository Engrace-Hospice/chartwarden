-- compat: expand
-- SECURITY DEFINER functions: `pg_temp` becomes the LAST element of every search_path.
--
-- A search_path that does not name pg_temp is searched with the session's temp schema FIRST for relations and types. A role that
-- may create temporary tables could create one with the name a definer function uses and have the function read or write that
-- object instead of the real one. For the per-table write-audit triggers (audit_phi_write_<table>, one per audited table,
-- generated with `SET search_path = pg_catalog, public`) the audit row would land in a temp table named audit_event, or the
-- write would fail, instead of the append-only log. About eighty other definers share the form (the membership picker, the
-- invitation lookup, the mdm / nppes / terminology / report writers, the partition and archive maintenance functions).
-- Migrations 1486 and 1555 already use the hardened form for the support-session functions.
--
-- Appending pg_temp keeps every name resolving to the same real object it resolves to today (the order of the other elements is
-- unchanged); it only stops a temp object shadowing any of them. The set is read from the catalog, not listed: every SECURITY
-- DEFINER function outside the system schemas that is not an extension member. A function that already ends in pg_temp is left
-- alone, so the migration is idempotent. A function with no search_path at all is left alone with a WARNING, because giving it
-- one changes how it resolves names (it uses the caller's path today); none exists, and the live suite fails if one appears.
-- A pg_temp anywhere but last is an error: it needs a hand fix, not a guess.
--
-- `public` ahead of pg_temp is acceptable only while no caller can create objects in `public` (a function created there could
-- win overload resolution). PostgreSQL 15 and later do not grant CREATE on `public` to PUBLIC, but a cluster upgraded from 14 or
-- older keeps that grant; the block below WARNs when it is present so the deploy log shows it.
--
-- ALTER FUNCTION ... SET changes one configuration entry; it keeps the owner, the ACL and the body, and it needs the owner or a
-- superuser (the migration runner is one). The generator now emits the same form, and the live suite fails if a later migration
-- brings the old one back.
DO $$
DECLARE
  f record;
  elements text[];
  n integer := 0;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_namespace ns,
           LATERAL aclexplode(coalesce(ns.nspacl, acldefault('n', ns.nspowner))) a
     WHERE ns.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE'
  ) THEN
    RAISE WARNING 'schema public grants CREATE to PUBLIC (a cluster upgraded from PostgreSQL 14 or older): remove that grant';
  END IF;

  FOR f IN
    SELECT p.oid::regprocedure AS sig,
           CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS kind,
           (SELECT substr(c, length('search_path=') + 1)
              FROM unnest(p.proconfig) AS c
             WHERE c LIKE 'search_path=%') AS path
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE p.prosecdef
       AND ns.nspname <> 'information_schema'
       AND ns.nspname NOT LIKE 'pg\_%'
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
       )
     ORDER BY p.oid
  LOOP
    IF f.path IS NULL THEN
      RAISE WARNING 'definer % has no search_path; left unchanged', f.sig;
      CONTINUE;
    END IF;
    elements := string_to_array(f.path, ',');
    IF btrim(elements[cardinality(elements)]) = 'pg_temp' THEN
      CONTINUE;
    END IF;
    IF position('pg_temp' IN f.path) > 0 THEN
      RAISE EXCEPTION 'definer % has pg_temp in the middle of its search_path (%); fix it by hand', f.sig, f.path;
    END IF;
    EXECUTE format('ALTER %s %s SET search_path = %s, pg_temp', f.kind, f.sig, f.path);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'definer search_path: pg_temp made last on % function(s)', n;
END
$$;
