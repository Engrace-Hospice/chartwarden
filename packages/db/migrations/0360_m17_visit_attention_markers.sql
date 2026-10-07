-- b11 follow-ups — M17 `visit` idempotency markers for two emit-per-run paths that re-emitted on replay.
--
-- (1) `scanVisitAttentionForOrg` (the 15-minute `stale-visit-sweep`) re-emitted `m17.stale_visit_detected`
-- for the same stuck `in_visit` visit on every run. `stale_flagged_started_at` records WHICH episode (the
-- visit's `actual_started_at`) was flagged and `stale_flagged_at` when. Re-arm rule (conservative): a visit
-- is flagged again only when its `actual_started_at` differs from the marker (a new stuck episode) or the
-- last flag is older than the 7-day re-nag window; otherwise the sweep is a no-op for it.
--
-- (2) The M17 `m15.volunteer.assignment_inactivated` consumer re-emitted `m17.reassignment_needed` on every
-- delivery of the same event. `volunteer_gate_flagged_event_id` records the outbox event id the visit was
-- already flagged for (stamped in the SAME tx as the publish), so a replay emits nothing while a genuinely
-- new inactivation event (a new id) still flags the visit.
--
-- `visit` is PARTITIONED BY RANGE (service_date) (migration 0045); ALTER TABLE on the PARENT propagates the
-- columns to every leaf (the 0269/0350 precedent). Additive, nullable, no default, no PHI, no free text (so
-- the audit-trigger denylist is unchanged); the event reference is LOGICAL (no FK). Existing RLS policies and
-- the write-audit trigger cover the columns.
ALTER TABLE "visit" ADD COLUMN IF NOT EXISTS "stale_flagged_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN IF NOT EXISTS "stale_flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN IF NOT EXISTS "volunteer_gate_flagged_event_id" uuid;
