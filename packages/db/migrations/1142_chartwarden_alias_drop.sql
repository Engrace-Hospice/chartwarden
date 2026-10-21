-- 1142 — drop the legacy `wardenx_destruction` NOLOGIN alias role (ChartWarden rebrand, DB-internals PR-A).
--
-- 1139 renamed wardenx_* -> chartwarden_* but kept a privilege-free NOLOGIN `wardenx_destruction` alias
-- (chartwarden_destruction a member of it) because nine already-applied, checksummed function bodies test
-- `pg_has_role(..., 'wardenx_destruction', 'MEMBER')` (0272, 0279-0281, 0394, 1056, 1060, 1061, 1107).
-- Applied migrations are never edited, so this migration rewrites those *live* bodies in place from
-- pg_get_functiondef (every attribute — SET search_path, SECURITY, volatility, owner, ACL, comment — rides
-- through CREATE OR REPLACE untouched; only the role literal changes), then drops the alias.
--
-- Guards (destruction / append-only paths; a wrong rewrite would either block legal destruction or, worse,
-- open a delete path): chartwarden_destruction must exist; afterwards no function body may mention the
-- alias; every rewritten function keeps its signature, owner, ACL, config, security and volatility; and no
-- view, policy, trigger, column default or CHECK constraint may mention the alias (none do today; the
-- migration fails loudly if one appears rather than leaving a dangling reference to a dropped role).
--
-- MULTI-DATABASE ORDER CAVEAT. Roles are cluster-global but function bodies are per-database, and a
-- body that names a missing role makes pg_has_role() raise (the guard then fails closed: destruction
-- DELETEs error). pg_shdepend cannot see other databases' function bodies, so this migration CANNOT prove
-- that a sibling database in the same cluster is already rewritten. The first database to run this drops
-- the role for the whole cluster, so a sibling still on <= 1141 has destruction guards that error until it
-- runs 1142 too. Migrate every database of a cluster back to back (a NOTICE lists the other connectable
-- databases). The DROP is skipped with a NOTICE when the role is already gone (re-run / sibling database dropped it),
-- and raises when the role still owns or is granted anything here.

DO $$
DECLARE
  fn record;
  def text;
  before_state jsonb := '{}'::jsonb;
  after_state jsonb := '{}'::jsonb;
  state_sql constant text := $q$
    SELECT jsonb_build_object('sig', p.oid::regprocedure::text, 'owner', p.proowner::regrole::text,
      'acl', p.proacl::text, 'cfg', p.proconfig, 'secdef', p.prosecdef, 'vol', p.provolatile::text,
      'lang', p.prolang, 'strict', p.proisstrict, 'leak', p.proleakproof)
    FROM pg_proc p WHERE p.oid = $1 $q$;
  one jsonb;
  stale text;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chartwarden_destruction') THEN
    RAISE EXCEPTION '1142: role chartwarden_destruction does not exist (1139 must run first); refusing to rewrite the destruction guards';
  END IF;

  -- Non-function references to the alias: fail loudly, never silently orphan them.
  SELECT string_agg(x, ', ') INTO stale FROM (
    SELECT 'view ' || schemaname || '.' || viewname AS x FROM pg_views
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND definition LIKE '%wardenx\_destruction%'
    UNION ALL SELECT 'policy ' || schemaname || '.' || tablename || '.' || policyname FROM pg_policies
      WHERE coalesce(qual, '') || coalesce(with_check, '') || array_to_string(roles, ',') LIKE '%wardenx\_destruction%'
    UNION ALL SELECT 'default ' || adrelid::regclass::text FROM pg_attrdef
      WHERE pg_get_expr(adbin, adrelid) LIKE '%wardenx\_destruction%'
    UNION ALL SELECT 'check ' || conrelid::regclass::text || '.' || conname FROM pg_constraint
      WHERE pg_get_constraintdef(oid) LIKE '%wardenx\_destruction%'
    UNION ALL SELECT 'trigger ' || tgrelid::regclass::text || '.' || tgname FROM pg_trigger
      WHERE NOT tgisinternal AND pg_get_triggerdef(oid) LIKE '%wardenx\_destruction%'
    UNION ALL SELECT 'rule ' || ev_class::regclass::text FROM pg_rewrite
      WHERE ev_class >= 16384 AND pg_get_ruledef(oid) LIKE '%wardenx\_destruction%'
  ) s;
  IF stale IS NOT NULL THEN
    RAISE EXCEPTION '1142: non-function objects still reference wardenx_destruction: %', stale;
  END IF;

  FOR fn IN
    SELECT p.oid FROM pg_proc p
    WHERE p.prokind IN ('f', 'p') AND p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
      AND p.prosrc LIKE '%wardenx\_destruction%'
    ORDER BY p.oid
  LOOP
    EXECUTE state_sql INTO one USING fn.oid;
    before_state := before_state || jsonb_build_object(fn.oid::text, one);
    def := replace(pg_get_functiondef(fn.oid), 'wardenx_destruction', 'chartwarden_destruction');
    -- 1139's message_ack guard already listed both names; collapse the now-duplicated IN-list entry.
    def := replace(def, '''chartwarden_destruction'', ''chartwarden_destruction''', '''chartwarden_destruction''');
    EXECUTE def;
    EXECUTE state_sql INTO one USING fn.oid;
    after_state := after_state || jsonb_build_object(fn.oid::text, one);
  END LOOP;

  IF before_state <> after_state THEN
    RAISE EXCEPTION '1142: a rewritten function changed owner/ACL/config/security/volatility: before=% after=%', before_state, after_state;
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO stale FROM pg_proc p
    WHERE p.prokind IN ('f', 'p') AND p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
      AND p.prosrc LIKE '%wardenx\_destruction%';
  IF stale IS NOT NULL THEN
    RAISE EXCEPTION '1142: function bodies still mention wardenx_destruction: %', stale;
  END IF;
END $$;--> statement-breakpoint

DO $$
DECLARE
  alias_oid oid;
  deps int;
  others text;
BEGIN
  SELECT oid INTO alias_oid FROM pg_roles WHERE rolname = 'wardenx_destruction';
  IF alias_oid IS NULL THEN
    RAISE NOTICE '1142: wardenx_destruction already gone; nothing to drop';
    RETURN;
  END IF;

  -- Anything the alias owns or is granted (ACLs, default ACLs, ownership) anywhere in the cluster would be
  -- orphaned or block the DROP. This also happens in the shared-cluster branch of 1139 (old role kept real
  -- grants because another database was renamed first): that state needs a manual cleanup, so fail loudly.
  SELECT count(*) INTO deps FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = alias_oid;
  IF deps > 0 THEN
    RAISE EXCEPTION '1142: wardenx_destruction still has % dependent object(s) (owner/ACL); it is not the privilege-free alias 1139 creates. Move those grants to chartwarden_destruction, then re-run.', deps;
  END IF;

  SELECT string_agg(datname, ', ') INTO others FROM pg_database
    WHERE datallowconn AND NOT datistemplate AND datname NOT IN (current_database(), 'postgres');
  IF others IS NOT NULL THEN
    RAISE NOTICE '1142: dropping cluster-global role wardenx_destruction; other databases (%) must already be on >= 1142 or their destruction guards will error', others;
  END IF;

  -- Membership first (REVOKE) so the failure mode of DROP ROLE is only about real dependents.
  IF EXISTS (SELECT FROM pg_auth_members WHERE roleid = alias_oid) THEN
    EXECUTE 'REVOKE wardenx_destruction FROM chartwarden_destruction';
  END IF;
  IF EXISTS (SELECT FROM pg_auth_members WHERE member = alias_oid) THEN
    RAISE EXCEPTION '1142: wardenx_destruction is itself a member of another role; unexpected, refusing to drop';
  END IF;
  BEGIN
    EXECUTE 'DROP ROLE wardenx_destruction';
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION '1142: DROP ROLE wardenx_destruction failed (%): %', SQLSTATE, SQLERRM;
  END;
END $$;
