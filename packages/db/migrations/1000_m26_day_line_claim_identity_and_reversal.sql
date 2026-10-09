-- M26 GAP-038 - the inpatient day ledger gets a claim identity and a reversal annotation.
--
-- WHY. `cap_inpatient_accrual.total_patient_days` (the 20% cap's denominator) was only ever grown inside the
-- ledger insert, so a claim line recorded BEFORE the denominator fix keeps `gip_days > 0, total_patient_days = 0`
-- forever (a replay of the same event hits the unique key and increments nothing). The roll-up is therefore
-- rebuilt from the ledger (`reconcileInpatientAccrual`), and the ledger needs two facts it never carried:
--   claim_id     the M23 claim the line belongs to. A PAID/PARTIAL_PAID claim can be replaced (TOB 817), voided
--                (TOB 818) or recouped (CLP02=22) - without the claim id its days could never be taken back and a
--                paid replacement (fresh claim_line ids) would double count the numerator and the denominator.
--                Nullable: rows written before this migration carry none until a replay stamps them.
--   reversed_at  set when the claim's payment was taken back. The row is ANNOTATED, never deleted; the roll-up
--                counts only rows where it is NULL. A claim that is re-paid after a recoup reuses the same
--                claim_line ids, so the re-delivered `m23.claim.line_finalized` clears it again.
-- DDL on the partitioned parent propagates to every LIST partition leaf (the 0680 precedent). The ledger stays
-- append-only for every other column: wardenx_app receives a COLUMN-level UPDATE grant on exactly these two.
ALTER TABLE "cap_inpatient_day_line" ADD COLUMN IF NOT EXISTS "claim_id" uuid;--> statement-breakpoint
ALTER TABLE "cap_inpatient_day_line" ADD COLUMN IF NOT EXISTS "reversed_at" timestamptz;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cap_inp_day_line_claim_ix"
	ON "cap_inpatient_day_line" ("organization_id", "cap_period_id", "claim_id")
	WHERE "reversed_at" IS NULL AND "claim_id" IS NOT NULL;--> statement-breakpoint
GRANT UPDATE ("claim_id", "reversed_at") ON "cap_inpatient_day_line" TO wardenx_app;
