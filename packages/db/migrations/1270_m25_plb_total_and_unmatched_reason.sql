-- M25 835 ledger: persist what the file already says so a posted advice balances without re-parsing.
--   remittance_advice.plb_total_amount  sum of the PLB provider-level adjustments (positive reduces the payment), so
--                                       sum(line CLP04) - plb_total_amount = total_payment_amount (BPR02).
--                                       Rows posted before this migration read 0 (their PLB was never stored and the raw file is
--                                       purged after posting): the identity holds only from this migration on.
--   remittance_advice.content_digest    sha256 of the claim payments in the set (CLP01|CLP02|CLP03|CLP04|CLP07, sorted), so a
--                                       clearinghouse resend (new ISA/ST, same TRN) is recognised by content, not only by TRN.
--   remittance_line.unmatched_reason    why an unmatched line is on the manual-match worklist
--                                       (no_candidate | ambiguous | needs_review). NULL for a bound line.
-- Additive, defaulted/nullable, idempotent; no new table, so no RLS or ownership change.
ALTER TABLE "remittance_advice" ADD COLUMN IF NOT EXISTS "plb_total_amount" numeric(12,2) NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "remittance_advice" ADD COLUMN IF NOT EXISTS "content_digest" varchar(64);--> statement-breakpoint
ALTER TABLE "remittance_line" ADD COLUMN IF NOT EXISTS "unmatched_reason" text;--> statement-breakpoint
ALTER TABLE "remittance_line" DROP CONSTRAINT IF EXISTS "remittance_line_unmatched_reason_chk";--> statement-breakpoint
ALTER TABLE "remittance_line" ADD CONSTRAINT "remittance_line_unmatched_reason_chk"
	CHECK ("unmatched_reason" IS NULL OR "unmatched_reason" IN ('no_candidate', 'ambiguous', 'needs_review'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_remittance_advice_trace" ON "remittance_advice" ("provider_entity_id", "payer_id", "check_or_eft_trace_number")
	WHERE "check_or_eft_trace_number" IS NOT NULL;
