-- GAP-118 (M5 amendment SLA) — once-only notification markers for the daily `m5.amendment_sla_scan`.
--
-- HIPAA 45 CFR 164.526(b)(2): a covered entity must act on an amendment request within 60 days (one 30-day
-- extension). `slaDueAt` (= received + 60d) was stamped at submit and nothing ever read it. The scan emits
-- `m5.patient.amendment_sla_due_soon` (within 10 days of due) and `m5.patient.amendment_sla_overdue` (past due)
-- exactly once per request: it stamps the matching marker in the SAME transaction as the outbox publish, so a
-- replayed tick or a racing replica matches no row the second time.
--
-- NULLable, no default: existing rows are "not yet notified" and are picked up by the next scan. Not PHI; the
-- table's write-audit trigger and RLS already cover the new columns. Idempotent.

ALTER TABLE "patient_amendment_request" ADD COLUMN IF NOT EXISTS "sla_due_soon_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient_amendment_request" ADD COLUMN IF NOT EXISTS "sla_overdue_notified_at" timestamp with time zone;--> statement-breakpoint
COMMENT ON COLUMN "patient_amendment_request"."sla_due_soon_notified_at" IS
  'GAP-118: when m5.patient.amendment_sla_due_soon was emitted for this pending request (NULL = not yet).';--> statement-breakpoint
COMMENT ON COLUMN "patient_amendment_request"."sla_overdue_notified_at" IS
  'GAP-118: when m5.patient.amendment_sla_overdue was emitted for this pending request (NULL = not yet).';
