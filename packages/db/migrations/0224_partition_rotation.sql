-- 0224_partition_rotation.sql — the time-partition rotation surface (F-033 / #93).
--
-- WHAT WAS MISSING. 43 tables are RANGE-partitioned on a date/timestamp column and each ships a
-- `create_<something>_partition(date)` function that creates one period. Nothing ever called them on a
-- schedule: `WARDENX_OPS_RUNBOOK_v0.1.md` §5.2.2 said so in its own heading ("STATUS: NOT IMPLEMENTED"),
-- and the only cron-shaped thing in the tree — M10's `hope-partition-rotation` — is a queue name with a
-- cadence and no body. Rotation was a manual monthly task an operator had to remember.
--
-- WHAT ACTUALLY HAPPENS WHEN IT IS FORGOTTEN — this is NOT what the runbook says. The runbook predicted a
-- hard write outage ("a RANGE-partitioned table with no partition covering now() rejects the INSERT").
-- That is true of a partitioned table with no DEFAULT partition. **Every one of these 43 has a DEFAULT
-- partition**, so the real behaviour is worse in a quieter way:
--
--   1. the write SUCCEEDS and lands in the DEFAULT partition — no error, no alert, nothing to notice;
--   2. the table keeps working, unpruned and progressively slower, for as long as nobody looks;
--   3. and the fix becomes IMPOSSIBLE without downtime, because PostgreSQL refuses to create a partition
--      whose range overlaps rows already sitting in DEFAULT:
--        `updated partition constraint for default partition "…_default" would be violated by some row`
--      Recovering then means moving rows out of DEFAULT under an ACCESS EXCLUSIVE lock on a table that has
--      been absorbing writes for however long it took to notice.
--
-- So the danger is not an outage that pages someone. It is a trap that seals behind you. `rotate_time_
-- partitions` keeps the window ahead; `time_partition_coverage` is the probe that reports headroom AND
-- whether a DEFAULT has already started collecting, because after that point rotation alone cannot fix it.
--
-- WHY THESE ARE CATALOG-DRIVEN AND NOT A LIST. A hand-maintained table→function list is the same class of
-- defect one level up: it goes stale the first time a migration adds a partitioned table and nobody edits
-- it. `pg_catalog` cannot go stale — it IS the schema. This was not a theoretical preference: the first
-- attempt at this change derived the list by parsing the migration text and silently missed 3 of the 43
-- (the M29 `hl7_*` tables), which is exactly the failure a list would institutionalise.
--
-- WHY SECURITY DEFINER. Creating a partition requires ownership of the parent table. The runtime platform
-- credential (`wardenx_platform_login`) deliberately holds narrow, enumerated grants and owns nothing —
-- see `scripts/db/provision-runtime-roles.ts`. Rather than make 43 creator functions SECURITY DEFINER, or
-- widen the platform role to a DDL role, this adds ONE definer-rights entry point that takes an integer
-- and no identifier from its caller: every name it executes comes from `pg_catalog`, never from an
-- argument. That is the same shape as the existing `audit_writer_insert_platform_event` /
-- `report_writer_*` platform-writer functions.
--
-- `search_path` is pinned on both, and pinned as `public, pg_catalog` rather than the usual
-- `pg_catalog, public`. That order is deliberate and was found by running it: the 43 creator functions
-- issue an UNQUALIFIED `CREATE TABLE IF NOT EXISTS %I PARTITION OF …`, so the new partition lands in
-- whichever schema comes first — with `pg_catalog` leading, all 43 fail with
-- `permission denied to create "pg_catalog.<table>_2026_08"`. Putting `public` first is safe here rather
-- than merely convenient: `CREATE` on `public` is granted only to `pg_database_owner` and
-- `wardenx_admin` (PostgreSQL 15+ dropped the historical world-writable default and nothing here
-- re-grants it), so no role that can reach these functions can plant an object in `public` to shadow one
-- in `pg_catalog`.

-- ── The rotation itself ─────────────────────────────────────────────────────────────────────────────
--
-- Idempotent by construction, and deliberately WITHOUT reading partition bounds: every creator function
-- issues `CREATE TABLE IF NOT EXISTS … PARTITION OF …`, so calling it for a month that already exists is
-- a no-op. That removes bound-parsing from the write path entirely — the job simply calls each creator
-- for every month in the window, and the ones already there cost nothing.
--
-- Per-table exception handling is the point, not defensive habit: one table whose DEFAULT has already
-- started collecting (case 3 above) must not abort rotation for the other 42. It is reported and the loop
-- continues.
CREATE OR REPLACE FUNCTION rotate_time_partitions(p_months_ahead int DEFAULT 3)
RETURNS TABLE (table_name text, status text, detail text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
-- Every creator is `CREATE TABLE IF NOT EXISTS`, so a steady-state monthly run emits one
-- `relation "…" already exists, skipping` NOTICE per table per month — ~170 lines of log saying nothing
-- happened. The job's own return rows are the report; the NOTICEs are noise that would train an operator
-- to skim past the run.
SET client_min_messages = warning
AS $$
DECLARE
  r            record;
  creator      text;
  month_start  date;
  m            int;
  before_count int;
  after_count  int;
  err          text;
BEGIN
  IF p_months_ahead < 1 OR p_months_ahead > 24 THEN
    RAISE EXCEPTION 'rotate_time_partitions: p_months_ahead must be between 1 and 24, got %', p_months_ahead;
  END IF;

  FOR r IN
    -- Every RANGE-partitioned relation keyed on a date/timestamp column. Includes relations that are
    -- THEMSELVES partitions: the LIST→RANGE billing tables (claim, medicaid_claim, *_state_history, the
    -- validation_* pair, rb_day) gain a per-tenant LIST partition from the write path, and each of those
    -- is monthly-RANGE underneath. Those sub-levels need rotating exactly like a top-level parent, and
    -- they do not exist until a tenant does — which is precisely why this is a catalog scan at run time
    -- and not a fixed list computed once.
    SELECT c.oid, c.relname::text AS relname
    FROM pg_partitioned_table p
    JOIN pg_class c     ON c.oid = p.partrelid
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_attribute a  ON a.attrelid = c.oid AND a.attnum = p.partattrs[0]
    JOIN pg_type t       ON t.oid = a.atttypid
    WHERE p.partstrat = 'r'
      AND t.typname IN ('date', 'timestamp', 'timestamptz')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY c.relname
  LOOP
    -- Resolve the creator by what it DOES, not by what it is called. `create_audit_partition` serves
    -- `audit_event`, so a `create_<table>_partition` name convention would miss it — and a convention
    -- that is right 42 times out of 43 is worse than none, because the miss is silent.
    SELECT p.proname::text INTO creator
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.pronargs = 1
      AND p.proargtypes[0] = 'date'::regtype
      AND p.prosrc LIKE '%PARTITION OF ' || r.relname || ' %'
    LIMIT 1;

    IF creator IS NULL THEN
      -- Not a warning. A partitioned table nothing can extend is a future DEFAULT-trap with no remedy,
      -- and the only moment it is cheap to fix is now, while the table is empty.
      table_name := r.relname; status := 'no_creator';
      detail := 'RANGE-partitioned on a time column but no create_*_partition(date) function names it';
      RETURN NEXT;
      CONTINUE;
    END IF;

    SELECT count(*) INTO before_count FROM pg_inherits WHERE inhparent = r.oid;

    err := NULL;
    FOR m IN 0..p_months_ahead LOOP
      month_start := (date_trunc('month', now()) + make_interval(months => m))::date;
      BEGIN
        EXECUTE format('SELECT %I($1)', creator) USING month_start;
      EXCEPTION WHEN others THEN
        -- Almost always the DEFAULT-overlap refusal. Keep the FIRST failure: later months usually fail
        -- for the same reason and the first one names the month rotation actually stalled at.
        IF err IS NULL THEN err := format('%s (at %s): %s', creator, month_start, SQLERRM); END IF;
      END;
    END LOOP;

    SELECT count(*) INTO after_count FROM pg_inherits WHERE inhparent = r.oid;

    table_name := r.relname;
    IF err IS NOT NULL THEN
      status := 'blocked'; detail := err;
    ELSIF after_count > before_count THEN
      status := 'created'; detail := format('%s partition(s) added', after_count - before_count);
    ELSE
      status := 'ok'; detail := 'window already covered';
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$$;--> statement-breakpoint

COMMENT ON FUNCTION rotate_time_partitions(int) IS
  'F-033: creates the current + N following months for every time-RANGE-partitioned table, discovered from pg_catalog. Idempotent (the creators are CREATE TABLE IF NOT EXISTS). Definer-rights because partition creation needs table ownership; takes no identifier from the caller.';--> statement-breakpoint

-- ── The probe ───────────────────────────────────────────────────────────────────────────────────────
--
-- Read-only. Answers the two questions an alert needs to distinguish, which are NOT the same question:
--
--   `months_headroom` — how long until writes start falling into DEFAULT. Rotation fixes this.
--   `default_occupied` — whether they ALREADY are. Rotation can no longer fix this; it is the one that
--                        should page someone, because every further hour makes the repair lock longer.
--
-- `default_occupied` is an EXISTS, never a count: on an empty DEFAULT (the expected state) the scan finds
-- nothing on an empty heap, and on an occupied one it stops at the first row. Both are cheap; a count on
-- a DEFAULT that has been absorbing an audit trail for a month would not be.
CREATE OR REPLACE FUNCTION time_partition_coverage()
RETURNS TABLE (
  table_name       text,
  covered_through  date,
  months_headroom  int,
  default_occupied boolean,
  has_creator      boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  r         record;
  upper_txt text;
  def_oid   oid;
  occupied  boolean;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname::text AS relname
    FROM pg_partitioned_table p
    JOIN pg_class c     ON c.oid = p.partrelid
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_attribute a  ON a.attrelid = c.oid AND a.attnum = p.partattrs[0]
    JOIN pg_type t       ON t.oid = a.atttypid
    WHERE p.partstrat = 'r'
      AND t.typname IN ('date', 'timestamp', 'timestamptz')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY c.relname
  LOOP
    -- The upper bound of the furthest-out partition. Read out of the bound EXPRESSION because PostgreSQL
    -- exposes no typed accessor for partition bounds; the leading YYYY-MM-DD is identical whether the key
    -- is `date` ('2026-09-01') or `timestamptz` ('2026-09-01 00:00:00+00').
    SELECT max(substring(pg_get_expr(ch.relpartbound, ch.oid) from 'TO \(''([0-9]{4}-[0-9]{2}-[0-9]{2})'))
      INTO upper_txt
    FROM pg_inherits i
    JOIN pg_class ch ON ch.oid = i.inhrelid
    WHERE i.inhparent = r.oid;

    SELECT ch.oid INTO def_oid
    FROM pg_inherits i
    JOIN pg_class ch ON ch.oid = i.inhrelid
    WHERE i.inhparent = r.oid AND pg_get_expr(ch.relpartbound, ch.oid) = 'DEFAULT'
    LIMIT 1;

    occupied := false;
    IF def_oid IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s)', def_oid::regclass) INTO occupied;
    END IF;

    table_name       := r.relname;
    covered_through  := upper_txt::date;
    -- Whole months from the start of THIS month to the coverage edge. 0 means the current month is the
    -- last one covered, i.e. rotation is already overdue this month.
    months_headroom  := CASE WHEN upper_txt IS NULL THEN 0 ELSE
                          (date_part('year',  age(upper_txt::date, date_trunc('month', now())::date)) * 12
                         + date_part('month', age(upper_txt::date, date_trunc('month', now())::date)))::int
                        END;
    default_occupied := occupied;
    has_creator      := EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.pronargs = 1 AND p.proargtypes[0] = 'date'::regtype
        AND p.prosrc LIKE '%PARTITION OF ' || r.relname || ' %');
    RETURN NEXT;
  END LOOP;
END;
$$;--> statement-breakpoint

COMMENT ON FUNCTION time_partition_coverage() IS
  'F-033: per-table partition headroom + whether the DEFAULT partition has already started collecting rows (after which rotation alone cannot repair the table). Read-only; the alerting probe behind partition.rotate.';
