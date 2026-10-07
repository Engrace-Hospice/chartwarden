-- GAP-052 — M17 §4.8 `reassignment-scan`: the per-visit idempotency marker.
--
-- When a time_off is approved (and again on every sweep of the `scheduling.reassignment-scan` cron), M17
-- finds the clinician's `published` visits that overlap the PTO window and emits one
-- `m17.reassignment_needed` per visit. `reassignment_flagged_time_off_id` records WHICH approved time_off
-- the visit has already been flagged for (and `reassignment_flagged_at` when), stamped in the SAME
-- transaction as the outbox publish, so a replayed approval or an overlapping sweep flags nothing twice
-- while a second, different PTO window over the same visit is still flagged.
--
-- `visit` is PARTITIONED BY RANGE (service_date) (migration 0045); ALTER TABLE on the PARENT propagates the
-- columns to every leaf (the 0269 precedent). Additive, nullable, no default, no PHI, no free text (so the
-- 0045/0269 audit-trigger denylist is unchanged); the time_off reference is LOGICAL (no FK), matching every
-- other cross-row id on `visit`. Existing RLS policies and the write-audit trigger cover the columns.
ALTER TABLE "visit" ADD COLUMN IF NOT EXISTS "reassignment_flagged_time_off_id" uuid;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN IF NOT EXISTS "reassignment_flagged_at" timestamp with time zone;
