-- deploy/production/backup/schema-fingerprint.sql — one md5 over the security-relevant catalog of schema `public` (#857).
--
-- Recorded in every snapshot marker by cw-backup.sh (psql) and recomputed on the restored copy by
-- scripts/backup/verify-restore.ts, which reads THIS file, so both sides hash exactly the same thing.
-- Covers what a lossy restore silently drops: columns, constraints, indexes, RLS enable/force flags, policies,
-- table grants and user triggers. Must stay a single SELECT returning one row with one text column.
SELECT md5(concat_ws(E'\n',
  (SELECT string_agg(format('%s.%s %s %s', c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull), E'\n' ORDER BY c.relname, a.attnum)
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped),
  (SELECT string_agg(format('%s %s %s', c.relname, k.conname, pg_get_constraintdef(k.oid)), E'\n' ORDER BY c.relname, k.conname)
     FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'),
  (SELECT string_agg(indexdef, E'\n' ORDER BY tablename, indexname) FROM pg_indexes WHERE schemaname = 'public'),
  (SELECT string_agg(format('%s rls=%s force=%s', c.relname, c.relrowsecurity, c.relforcerowsecurity), E'\n' ORDER BY c.relname)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')),
  (SELECT string_agg(format('%s %s %s %s %s %s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname)
     FROM pg_policies WHERE schemaname = 'public'),
  (SELECT string_agg(format('%s %s %s', table_name, grantee, privilege_type), E'\n' ORDER BY table_name, grantee, privilege_type)
     FROM information_schema.role_table_grants WHERE table_schema = 'public'),
  (SELECT string_agg(format('%s %s', c.relname, t.tgname), E'\n' ORDER BY c.relname, t.tgname)
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal)
)) AS schema_fingerprint;
