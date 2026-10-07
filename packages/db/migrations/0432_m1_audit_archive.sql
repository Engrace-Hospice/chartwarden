-- 0432_m1_audit_archive.sql — the `audit.archive` cold-tier mechanism (GAP-113; M1 spec §4.8, M4 §4.4).
--
-- WHAT THIS IS. Module 1 owns the MECHANISM that moves closed `audit_event` month-partitions out of the hot tier;
-- Module 4 owns the POLICY (retention classes, legal holds, destruction certificates). The monthly
-- `audit.archive` job (apps/backend/src/bootstrap/jobs/audit-archive.ts) reads each closed partition through the
-- two read-side functions below, writes it to the object store as NDJSON+gzip parts with a checksummed manifest,
-- VERIFIES every object back from the store, and only then — and only when an operator has opted in — detaches
-- the partition through the third function. Nothing here ever DROPS a partition: destruction is M4's
-- certificate-driven act (`audit.execute_destruction`), and §4.8.1 is explicit that a partition whose archive
-- failed must never go.
--
-- WHY DEFINER-RIGHTS FUNCTIONS (the 0224 pattern). Reading every tenant's audit trail and detaching a partition
-- need BYPASSRLS and table ownership respectively; `wardenx_platform` has neither and should not be handed
-- either. Each function takes a partition NAME that is looked up in `pg_inherits` (a child of `audit_event`,
-- closed, not DEFAULT) before it is ever interpolated with %I — no identifier the caller supplies is executed
-- unvalidated. `search_path` is pinned (public first, matching 0224).
--
-- "CLOSED" means the partition's upper bound is at or before the start of the CURRENT month: the month
-- currently collecting writes (and the one rotation pre-creates ahead) can never be archived or detached.

-- The bound text for a child partition: `FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2026-02-01 00:00:00+00')`.
CREATE OR REPLACE FUNCTION audit_archive_closed_partitions()
RETURNS TABLE (partition_name text, range_from date, range_to date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT ch.relname::text,
         substring(pg_get_expr(ch.relpartbound, ch.oid) from 'FROM \(''([0-9]{4}-[0-9]{2}-[0-9]{2})')::date,
         substring(pg_get_expr(ch.relpartbound, ch.oid) from 'TO \(''([0-9]{4}-[0-9]{2}-[0-9]{2})')::date
  FROM pg_inherits i
  JOIN pg_class ch ON ch.oid = i.inhrelid
  JOIN pg_class parent ON parent.oid = i.inhparent
  JOIN pg_namespace n ON n.oid = parent.relnamespace
  WHERE parent.relname = 'audit_event'
    AND n.nspname = 'public'
    AND pg_get_expr(ch.relpartbound, ch.oid) <> 'DEFAULT'
    AND substring(pg_get_expr(ch.relpartbound, ch.oid) from 'TO \(''([0-9]{4}-[0-9]{2}-[0-9]{2})')::date
        <= date_trunc('month', now())::date
$$;--> statement-breakpoint

-- Closed partitions older than the hot window, oldest first, with their row counts.
CREATE OR REPLACE FUNCTION audit_archive_candidates(p_hot_months int)
RETURNS TABLE (partition_name text, range_from date, range_to date, row_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  r record;
  n bigint;
BEGIN
  IF p_hot_months < 1 OR p_hot_months > 120 THEN
    RAISE EXCEPTION 'audit_archive_candidates: p_hot_months must be between 1 and 120, got %', p_hot_months;
  END IF;
  FOR r IN
    SELECT c.partition_name AS pn, c.range_from AS rf, c.range_to AS rt
    FROM audit_archive_closed_partitions() c
    WHERE c.range_to <= (date_trunc('month', now()) - make_interval(months => p_hot_months))::date
    ORDER BY c.range_from
  LOOP
    EXECUTE format('SELECT count(*) FROM %I', r.pn) INTO n;
    partition_name := r.pn; range_from := r.rf; range_to := r.rt; row_count := n;
    RETURN NEXT;
  END LOOP;
END;
$$;--> statement-breakpoint

-- One keyset page of a closed partition's rows, as jsonb, ordered by id. `p_limit` is clamped.
CREATE OR REPLACE FUNCTION audit_archive_read_batch(p_partition text, p_after_id uuid, p_limit int)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit_archive_closed_partitions() c WHERE c.partition_name = p_partition) THEN
    RAISE EXCEPTION 'audit_archive_read_batch: % is not a closed audit_event partition', p_partition;
  END IF;
  RETURN QUERY EXECUTE format(
    'SELECT to_jsonb(t) FROM %I t WHERE ($1::uuid IS NULL OR t.id > $1::uuid) ORDER BY t.id LIMIT $2', p_partition)
    USING p_after_id, GREATEST(1, LEAST(COALESCE(p_limit, 1000), 10000));
END;
$$;--> statement-breakpoint

-- Detach a closed partition from `audit_event` AFTER the caller has archived and verified it. Refuses if the
-- partition's row count is not exactly what was archived (something was written to a closed month meanwhile).
-- The detached table is KEPT (renamed nothing, dropped never): it simply stops being scanned through the parent.
-- Reattach with `ALTER TABLE audit_event ATTACH PARTITION ...` if the range must be searchable again.
CREATE OR REPLACE FUNCTION audit_archive_detach(p_partition text, p_expected_rows bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  actual bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit_archive_closed_partitions() c WHERE c.partition_name = p_partition) THEN
    RAISE EXCEPTION 'audit_archive_detach: % is not a closed audit_event partition', p_partition;
  END IF;
  EXECUTE format('SELECT count(*) FROM %I', p_partition) INTO actual;
  IF actual <> p_expected_rows THEN
    RAISE EXCEPTION 'audit_archive_detach: % holds % rows but % were archived — refusing to detach',
      p_partition, actual, p_expected_rows;
  END IF;
  EXECUTE format('ALTER TABLE audit_event DETACH PARTITION %I', p_partition);
  RETURN 'detached';
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION audit_archive_closed_partitions() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_archive_candidates(int) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_archive_read_batch(text, uuid, int) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_archive_detach(text, bigint) FROM PUBLIC;--> statement-breakpoint

COMMENT ON FUNCTION audit_archive_candidates(int) IS
  'GAP-113: closed audit_event partitions older than the hot window (oldest first) with row counts. Catalog-driven; takes no identifier from the caller.';--> statement-breakpoint
COMMENT ON FUNCTION audit_archive_read_batch(text, uuid, int) IS
  'GAP-113: one keyset page (by id) of a CLOSED audit_event partition as jsonb, for the audit.archive job. The partition name is validated against pg_inherits before use.';--> statement-breakpoint
COMMENT ON FUNCTION audit_archive_detach(text, bigint) IS
  'GAP-113: detach a closed audit_event partition after it was archived and verified; refuses on a row-count mismatch. Never drops.';
