-- GAP (M13 deadline sweeps) — "already warned" markers so the reconciliation-deadline and PRN-reassessment-overdue
-- sweeps are catch-up safe. Before this, each deadline belonged to exactly ONE grid-aligned tick window, so a missed
-- tick (worker down) meant a missed alert and widening the window would have re-alerted. Now a sweep selects every
-- row whose deadline has passed (bounded lookback) AND whose marker IS NULL, and stamps the marker in the SAME
-- transaction as the outbox publish (UPDATE ... WHERE marker IS NULL RETURNING), so overlapping ticks cannot
-- double-alert.
--   medication_reconciliation_worksheet.deadline_warned_at          — `m13.reconciliation.due_at_warning` published
--   medication_reconciliation_worksheet.deadline_overdue_warned_at  — `m13.reconciliation.overdue` published
--   prn_administration.reassessment_overdue_warned_at               — the overdue check was resolved (event published,
--                                                                     or the reassessment was captured in time)
-- Additive, nullable, no default; no PHI. Existing RLS policies, UPDATE grants and write-audit triggers cover them.
-- Existing rows stay NULL: the bounded lookback keeps a first deploy from back-alerting old deadlines.
ALTER TABLE "medication_reconciliation_worksheet" ADD COLUMN IF NOT EXISTS "deadline_warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "medication_reconciliation_worksheet" ADD COLUMN IF NOT EXISTS "deadline_overdue_warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prn_administration" ADD COLUMN IF NOT EXISTS "reassessment_overdue_warned_at" timestamp with time zone;
