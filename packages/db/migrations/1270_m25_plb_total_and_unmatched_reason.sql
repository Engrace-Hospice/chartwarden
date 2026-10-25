-- M25 835 ledger: persist what the file already says so a posted advice balances without re-parsing.
--   remittance_advice.plb_total_amount  sum of the PLB provider-level adjustments (positive reduces the payment), so
--                                       sum(line CLP04) - plb_total_amount = total_payment_amount (BPR02).
--   remittance_line.unmatched_reason    why an unmatched line is on the manual-match worklist
--                                       (no_candidate | ambiguous | needs_review). NULL for a bound line.
-- Additive, defaulted/nullable, idempotent; no new table, so no RLS or ownership change.
ALTER TABLE "remittance_advice" ADD COLUMN IF NOT EXISTS "plb_total_amount" numeric(12,2) NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "remittance_line" ADD COLUMN IF NOT EXISTS "unmatched_reason" text;
