-- M11 §2.3 / §4.8 (GAP-032) — the `verbal-pre-expiry-alert` worker's idempotency record.
-- The quarter-hourly pre-expiry sweep emits `m11.order.verbal_expiring_soon` once per (verbal_order, tier)
-- (tiers: '12h', '2h'); the tiers already alerted are kept on the verbal order itself so a replayed tick, a second
-- replica or a tick that straddles the tier window never re-emits. Additive, NOT NULL with an empty default (no
-- backfill needed: an existing pending verbal simply has not been alerted yet). No PHI. The table's org RLS
-- policy, FORCE RLS, table-level UPDATE grant and M4 write-audit trigger already cover the new column.
ALTER TABLE "verbal_order" ADD COLUMN IF NOT EXISTS "pre_expiry_tiers_alerted" text[] NOT NULL DEFAULT '{}';
