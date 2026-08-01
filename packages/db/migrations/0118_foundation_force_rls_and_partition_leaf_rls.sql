-- M1 Foundation — close the two structural RLS holes: the OWNER bypass and the PARTITION-LEAF gap.
--
-- Both were found by querying a live schema, not by reading policy text. Neither is a missing policy;
-- both are ways to reach rows the policies were written to protect.
--
-- ── HOLE 1: RLS was ENABLED but never FORCED (370 tables) ────────────────────────────────────────────
-- `ENABLE ROW LEVEL SECURITY` does not apply to the table's OWNER. Every policy in this repo is
-- `TO wardenx_app`, and today the owner is the migrating superuser, so nothing was visibly wrong.
-- But scripts/db/migrate.ts connects as `DATABASE_ADMIN_URL ?? DATABASE_URL` — run the migrator once
-- with only DATABASE_URL set and `wardenx_app` BECOMES THE OWNER of all 370 tables, at which point
-- every policy stops applying to the application's own role. There is no `rolbypassrls` flag to catch
-- that: the boot guard in apps/backend/src/index.ts checks BYPASSRLS, and ownership is not BYPASSRLS.
-- FORCE removes the exemption, so ownership stops being a silent superpower.
--
-- ── HOLE 2: no partition LEAF had RLS (429 leaves under 47 partitioned parents) ──────────────────────
-- Policies live on the parent and are applied when rows are reached THROUGH the parent. Reading a
-- partition DIRECTLY applies that partition's own policies — and every leaf had `relrowsecurity =
-- false`, i.e. none. The only thing preventing direct-leaf access was the absence of a GRANT, and
-- there is no `ALTER DEFAULT PRIVILEGES ... REVOKE` here, so one routine
-- `GRANT SELECT ON ALL TABLES IN SCHEMA public TO wardenx_app` would have exposed every partition of
-- audit_event, clinical_assessment, medication_order, administration_record, evv_event, visit and
-- claim cross-tenant, with no policy to stop it. m32-rls-isolation.live.test.ts documents this.
--
-- Verified empirically on a live cluster before writing this, because the interaction is easy to get
-- wrong from memory. With a granted `wardenx_app` and a leaf carrying NO policies:
--     leaf RLS off →  direct-leaf SELECT returns the row      (the hole)
--     leaf RLS on  →  direct-leaf SELECT returns 0 rows       (default-deny, hole closed)
--                     read THROUGH the parent still returns the row
--                     INSERT and UPDATE through the parent still succeed
-- So a leaf needs RLS enabled and needs NO policies of its own: parent-routed DML is unaffected, and
-- direct-leaf DML is refused. Adding leaf policies would be redundant and would drift from the parent.
--
-- Catalog-driven and idempotent: re-running is a no-op, and a table that legitimately has no RLS
-- (the NON_ORG_SCOPED reference tables) is left alone — this only FORCEs what already had RLS on.

-- 1. FORCE on every table that already has RLS enabled (parents and unpartitioned tables alike).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS t
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relrowsecurity
      AND NOT c.relforcerowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', r.t);
  END LOOP;
END $$;--> statement-breakpoint

-- 2. ENABLE + FORCE on every existing partition leaf. No policies are created: absent policies mean
--    default-deny for direct access, which is exactly the intent.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS t
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_inherits i ON i.inhrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', r.t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', r.t);
  END LOOP;
END $$;--> statement-breakpoint

-- 3. FUTURE partitions. There are 43 `create_*_partition(...)` helpers plus a monthly rotation worker,
--    and a leaf minted by any of them would otherwise land unprotected. Rather than edit 43 functions
--    (and depend on every future one remembering), an event trigger secures any new leaf at creation.
--    This covers partitions created by the helpers, by the rotation worker, and by hand.
CREATE OR REPLACE FUNCTION wardenx_secure_new_partition() RETURNS event_trigger AS $$
DECLARE obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    -- Only a real table that is a partition OF something, in public.
    IF obj.object_type = 'table'
       AND obj.schema_name = 'public'
       AND EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = obj.objid)
       AND EXISTS (SELECT 1 FROM pg_class WHERE oid = obj.objid AND relkind = 'r' AND NOT relrowsecurity)
    THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
      EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', obj.object_identity);
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP EVENT TRIGGER IF EXISTS wardenx_secure_new_partition_trg;--> statement-breakpoint
CREATE EVENT TRIGGER wardenx_secure_new_partition_trg
  ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
  EXECUTE FUNCTION wardenx_secure_new_partition();--> statement-breakpoint

COMMENT ON FUNCTION wardenx_secure_new_partition() IS
  'Event trigger: every newly created partition leaf gets RLS enabled + forced. Leaves carry no policies of their own — parent policies govern parent-routed access, and direct-leaf access default-denies.';
