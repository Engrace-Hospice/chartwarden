-- F-183 (#248) — M29 outbound: the two per-feed knobs F-182's `in_flight` reclaim sweep left global.
--
-- (1) RECEIVER DEDUPE. F-182 reclaims a row whose lease expired by requeueing it with the SAME MSH-10, which is
--     only safe if the receiver dedupes on MSH-10 — a contract with each lab that nothing recorded or verified.
--     `receiver_dedupes_control_id` is that contract, an explicit operator decision per feed. DEFAULT false is the
--     deliberate SAFE default: a stale `in_flight` row (delivery unknown) on a feed not marked as deduping is
--     HELD for human verification with the lab instead of being automatically re-sent (a possible second order).
--     BEHAVIOUR CHANGE vs F-182 for every existing feed until an operator sets it true.
-- (2) LEASE. `in_flight_lease_seconds` is the per-feed `in_flight` lease; NULL = the platform default
--     (`OUTBOUND_IN_FLIGHT_LEASE_MS`, 5 min). The range floors at 60 s — above the transport's 10 s connect + 30 s
--     ack worst case, so a lease can never be configured shorter than a live send — and caps at 1 h so a stuck
--     row is never invisible for longer than an operator shift.
--
-- Additive-only: a NOT NULL column with a constant default and a nullable column, so existing rows and inserts
-- are unaffected. RLS, the FORCE sweep and the M4 write-audit trigger already cover `external_feed` (0148 / 0118).
ALTER TABLE "external_feed"
  ADD COLUMN IF NOT EXISTS "receiver_dedupes_control_id" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "in_flight_lease_seconds" integer;--> statement-breakpoint

ALTER TABLE "external_feed"
  ADD CONSTRAINT "external_feed_in_flight_lease_chk" CHECK (
    "in_flight_lease_seconds" IS NULL OR "in_flight_lease_seconds" BETWEEN 60 AND 3600
  );
