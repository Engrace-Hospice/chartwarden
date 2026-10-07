-- M12 (GAP-037 close-out) — the "already alerted" markers the §4.8 SLA / IAL2 crons need so each stage fires
-- ONCE per row instead of every tick (the 0345 / 0360 marker precedent; `planRefillSlaAlert` and
-- `planIal2ExpiryAlert` both state that "the cron suppresses re-emission of an already-emitted stage").
--
--   refill_request.sla_warn_emitted_at / sla_critical_emitted_at — set in the same transaction as the
--       `m12.refill_request_sla_warn` / `_critical` outbox event, by a guarded UPDATE (`... IS NULL`), so only the
--       replica that wins the update emits.
--   dosespot_prescriber.ial2_alert_stage — the last IAL2-expiry stage alerted ('warn' | 'critical'); reset to NULL
--       when the prescriber's IAL2 is re-verified so the next expiry cycle alerts again.
--
-- Additive, nullable, no backfill: a pre-existing pending refill simply alerts at its next tick (it IS overdue).
ALTER TABLE "refill_request" ADD COLUMN IF NOT EXISTS "sla_warn_emitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refill_request" ADD COLUMN IF NOT EXISTS "sla_critical_emitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dosespot_prescriber" ADD COLUMN IF NOT EXISTS "ial2_alert_stage" text;--> statement-breakpoint
ALTER TABLE "dosespot_prescriber" DROP CONSTRAINT IF EXISTS "dosespot_prescriber_ial2_alert_stage_chk";--> statement-breakpoint
ALTER TABLE "dosespot_prescriber" ADD CONSTRAINT "dosespot_prescriber_ial2_alert_stage_chk"
	CHECK ("ial2_alert_stage" IS NULL OR "ial2_alert_stage" IN ('warn', 'critical'));
