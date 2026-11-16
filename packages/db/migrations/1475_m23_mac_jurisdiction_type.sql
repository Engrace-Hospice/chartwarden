-- compat: expand
-- M23 recovery prerequisite for immutable migrations 1489/1490. Those deployed migrations use
-- m23_mac_jurisdiction, but the historical chain only created mac_jurisdiction. Keep their files
-- and checksums unchanged; this idempotent repair sorts before them on fresh installs and runs as
-- a no-op on databases where the deployed type already exists.
DO $migration$
DECLARE
  actual_labels text[];
  expected_labels constant text[] := ARRAY[
    'ngs_j6',
    'ngs_jk',
    'cgs_j15',
    'palmetto_jj',
    'palmetto_jm',
    'noridian_jf',
    'noridian_je'
  ];
BEGIN
  IF to_regtype('public.m23_mac_jurisdiction') IS NULL THEN
    CREATE TYPE public.m23_mac_jurisdiction AS ENUM (
      'ngs_j6',
      'ngs_jk',
      'cgs_j15',
      'palmetto_jj',
      'palmetto_jm',
      'noridian_jf',
      'noridian_je'
    );
  ELSE
    SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
      INTO actual_labels
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE n.nspname = 'public'
       AND t.typname = 'm23_mac_jurisdiction';

    IF actual_labels IS DISTINCT FROM expected_labels THEN
      RAISE EXCEPTION 'public.m23_mac_jurisdiction has unexpected labels';
    END IF;
  END IF;
END
$migration$;

-- Migration 0075 stores legacy credentials using mac_jurisdiction, while the later schema and
-- migration 1489 target m23_mac_jurisdiction. PostgreSQL does not implicitly assign one enum type
-- to another, even when their labels match. Keep the historical source column and add only this
-- label-preserving assignment conversion so 1489's backfill can run without editing deployed SQL.
CREATE OR REPLACE FUNCTION public.m23_mac_jurisdiction_from_legacy(value public.mac_jurisdiction)
RETURNS public.m23_mac_jurisdiction
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $cast$
  SELECT value::text::public.m23_mac_jurisdiction
$cast$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_cast c
      JOIN pg_type source_type ON source_type.oid = c.castsource
      JOIN pg_namespace source_ns ON source_ns.oid = source_type.typnamespace
      JOIN pg_type target_type ON target_type.oid = c.casttarget
      JOIN pg_namespace target_ns ON target_ns.oid = target_type.typnamespace
     WHERE source_ns.nspname = 'public'
       AND source_type.typname = 'mac_jurisdiction'
       AND target_ns.nspname = 'public'
       AND target_type.typname = 'm23_mac_jurisdiction'
  ) THEN
    CREATE CAST (public.mac_jurisdiction AS public.m23_mac_jurisdiction)
      WITH FUNCTION public.m23_mac_jurisdiction_from_legacy(public.mac_jurisdiction)
      AS ASSIGNMENT;
  END IF;
END
$migration$;
