-- M18 EVV — the D2 active-pair backstop index made correction-of-record impossible (F-088).
--
-- WHAT WAS WRONG. 0047 created a per-partition partial unique index enforcing "at most one ACTIVE
-- check_in and one ACTIVE check_out per visit", and defined ACTIVE as `superseded_by_event_id IS
-- NULL`. That column holds the id of the event that REPLACES this one — so it cannot be set until
-- the replacement row exists, and the replacement row cannot be inserted while the original still
-- counts as active. `POST /api/v1/evv/events/:eventId/correct` therefore died on
--
--     duplicate key value violates unique constraint "evv_event_<yyyy_mm>_active_visit_kind_uidx"
--
-- on every correction, in every tenant, since the route was written. Not a race, not a rare shape:
-- a correction ALWAYS supersedes an event on the same (organization, visit, kind), which is the
-- exact tuple the index is unique on. The chicken-and-egg is structural.
--
-- THE WRITE PATH WAS ALREADY WRITTEN FOR THE FIX. `correctEvent` in `evv-route-service-db.ts`
-- stamps `superseded_at` on the original FIRST, then inserts the replacement, then links the two by
-- setting `superseded_by_event_id`. That ordering is only meaningful against an index keyed on
-- `superseded_at` — a timestamp the tx can set on its own, with nothing to point at yet. The service
-- and the index disagreed about which column marks an event superseded, and the index won.
--
-- THE FIX is one word of the predicate: ACTIVE means `superseded_at IS NULL`. Everything the index
-- was written to catch, it still catches — 0047's own header calls it "the race backstop; the app
-- pairing lookup fires first", and a second concurrent check-in still collides, since neither row
-- carries a supersede marker at all.
--
-- The app's own "active event" reads keep filtering on `superseded_by_event_id IS NULL`, and that is
-- deliberate rather than an oversight. The two columns are written in the same transaction and are
-- only ever out of step INSIDE a correction — for the few statements between the supersede stamp and
-- the link. In that window the index treats the original as gone (so the replacement inserts) while
-- the service still treats it as present (so the pairing logic that decides what a correction MEANS
-- is unchanged). Steady state is identical: both markers set, or neither.
--
-- Rebuilding is safe in either direction. No row can have `superseded_by_event_id` set without
-- `superseded_at` — only `correctEvent` writes either, in one transaction — so the new predicate
-- admits no pair the old one excluded, and creation cannot fail on existing data.
--
-- Proven by the two `correction-of-record` cases in `m18-evv-write.live.test.ts`, which have been
-- red on `main` and run in `lifecycle-live`, which has no runner assigned.

-- 1. The helper future partitions are created through (0047's `create_evv_event_partition` calls it).
CREATE OR REPLACE FUNCTION add_evv_event_unique_indexes(partition_name text) RETURNS void AS $$
BEGIN
  EXECUTE format(
    'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (organization_id, visit_id, kind) WHERE superseded_at IS NULL',
    partition_name || '_active_visit_kind_uidx', partition_name
  );
  EXECUTE format(
    'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (organization_id, evv_device_id, local_id) WHERE local_id IS NOT NULL',
    partition_name || '_offline_idem_uidx', partition_name
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- 2. Every partition that already exists — including `evv_event_default` — carries the old predicate
--    and has to be rebuilt. Catalog-driven rather than a hand-listed set of month names: 0047 seeds
--    13 months ahead and the M18 partition cron adds more, so the set is not knowable from here.
DO $$
DECLARE leaf text;
BEGIN
  FOR leaf IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'evv_event'::regclass
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', leaf || '_active_visit_kind_uidx');
    EXECUTE format(
      'CREATE UNIQUE INDEX %I ON %I (organization_id, visit_id, kind) WHERE superseded_at IS NULL',
      leaf || '_active_visit_kind_uidx', leaf
    );
  END LOOP;
END $$;
