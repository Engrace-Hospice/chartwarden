-- GAP-044 follow-up — M15 `volunteer_compliance_gate.last_expiry_notice_days_out`: the tightest 30/14/7/1-day
-- ladder mark (§7.5) the nightly gate-watcher has ALREADY notified for this gate. The watcher notifies
-- "the tightest mark crossed and not yet notified" and stamps this column in the SAME transaction as the
-- `m15.volunteer.gate_expiring` outbox publish, so a missed daily run still sends the right notice exactly
-- once per mark and a replayed run sends nothing. NULL = no notice sent yet. A renewal is a NEW gate row, so
-- the state resets by construction.
--
-- Additive, nullable, no default; no PHI. Existing RLS policies and the write-audit trigger cover the column.
ALTER TABLE "volunteer_compliance_gate" ADD COLUMN IF NOT EXISTS "last_expiry_notice_days_out" smallint;--> statement-breakpoint
ALTER TABLE "volunteer_compliance_gate" DROP CONSTRAINT IF EXISTS "volunteer_compliance_gate_notice_days_ck";--> statement-breakpoint
ALTER TABLE "volunteer_compliance_gate" ADD CONSTRAINT "volunteer_compliance_gate_notice_days_ck"
  CHECK (last_expiry_notice_days_out IS NULL OR last_expiry_notice_days_out BETWEEN 0 AND 30);
