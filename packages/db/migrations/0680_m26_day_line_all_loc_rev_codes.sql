-- M26 GAP-038 — the cap_inpatient_day_line ledger now carries EVERY hospice level-of-care day, not only the
-- inpatient ones. The 20% inpatient cap (42 CFR 418.309(b)) is inpatient days (IRC 0655 + GIP 0656) over TOTAL
-- Medicare hospice days; cap_inpatient_accrual.total_patient_days (the denominator) was never written, so the
-- utilisation read 0% and the alert never fired. Routine (0651) and continuous (0652) home-care days are
-- recorded in the same append-only, idempotent ledger (unique per claim line + rev code) so the denominator
-- is replay-safe; only 0655/0656 days feed gip_days/irc_days. Widens the rev_code CHECK; no data change.
-- Idempotent. DROP/ADD on the partitioned parent propagates to every LIST partition leaf.
ALTER TABLE "cap_inpatient_day_line" DROP CONSTRAINT IF EXISTS "cap_inp_day_line_rev_ck";--> statement-breakpoint
ALTER TABLE "cap_inpatient_day_line" ADD CONSTRAINT "cap_inp_day_line_rev_ck"
	CHECK ("rev_code" IN ('0651', '0652', '0655', '0656'));
