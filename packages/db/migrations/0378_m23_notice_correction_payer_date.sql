-- M23 — corrected NOE / NOTR after a rejection, Medicare's own answer date, and the late-NOE occurrence span 77.
--
-- 1. Corrections (CMS Pub. 100-04 ch. 11 §20.1.1 / §20.1.2; M23 §2.2 "corrected NOE is its own row"). A notice the
--    999 / 277CA rejected never posted; the biller files a NEW original notice that points back at it:
--      corrects_notice_id   uuid NULLABLE, FK to the same table (the rejected notice this one corrects). NO ACTION,
--                           not RESTRICT: a rejected notice cannot be deleted while its correction exists, but the
--                           M4 eraser's single-statement delete of a patient's whole chain is checked at statement
--                           end and succeeds.
--      correction_reason    text NULLABLE, 20..2000 chars, required iff corrects_notice_id is set. Biller free text:
--                           it stays on the row (write-audited) and is never put in an event or alert.
--    `*_open_correction_uq` allows one correction in progress (or accepted) per rejected notice; a cancelled or
--    rejected correction leaves room for the next one. The existing one-live-NOE-per-admission index
--    (`noe_record_admission_uq`) still holds: a correction is just the admission's next NOE.
--
-- 2. The payer's answer date (Medicare's, not our cron's): `accepted_at` / `rejected_at` stay our receipt time.
--      payer_status_date         date NULLABLE — 277CA STC02; for a 999 its GS04 (else ISA09); else our receipt date.
--      payer_status_date_source  text NULLABLE — '277ca_stc02' | '999_gs04' | '999_isa09' | 'receipt'; set iff the
--                                date is set.
--    NOE timeliness (ch. 11 §20.1.1: accepted within 5 calendar days after admission) is judged on this date.
--
-- 3. claim.occurrence_spans jsonb NOT NULL DEFAULT '[]' — UB-04 FL 35-36 / 837I HI*BI as [{code, from, through}].
--    Derived on every validation (today: the late-NOE provider-liable span 77, admission through the day before
--    the NOE acceptance date) and sent to the X12 gateway with the claim.
--
-- Existing org RLS policies, FORCE RLS and the write-audit triggers on all three tables cover the new columns (no
-- new table, no new policy). Idempotent.
ALTER TABLE "noe_record" ADD COLUMN IF NOT EXISTS "corrects_notice_id" uuid;--> statement-breakpoint
ALTER TABLE "noe_record" ADD COLUMN IF NOT EXISTS "correction_reason" text;--> statement-breakpoint
ALTER TABLE "noe_record" ADD COLUMN IF NOT EXISTS "payer_status_date" date;--> statement-breakpoint
ALTER TABLE "noe_record" ADD COLUMN IF NOT EXISTS "payer_status_date_source" text;--> statement-breakpoint
ALTER TABLE "notr_record" ADD COLUMN IF NOT EXISTS "corrects_notice_id" uuid;--> statement-breakpoint
ALTER TABLE "notr_record" ADD COLUMN IF NOT EXISTS "correction_reason" text;--> statement-breakpoint
ALTER TABLE "notr_record" ADD COLUMN IF NOT EXISTS "payer_status_date" date;--> statement-breakpoint
ALTER TABLE "notr_record" ADD COLUMN IF NOT EXISTS "payer_status_date_source" text;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "occurrence_spans" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'noe_record_corrects_notice_fk') THEN
    ALTER TABLE "noe_record" ADD CONSTRAINT "noe_record_corrects_notice_fk"
      FOREIGN KEY ("corrects_notice_id") REFERENCES "noe_record"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'noe_record_correction_reason_chk') THEN
    ALTER TABLE "noe_record" ADD CONSTRAINT "noe_record_correction_reason_chk"
      CHECK (("corrects_notice_id" IS NULL) = ("correction_reason" IS NULL)
        AND ("correction_reason" IS NULL OR length("correction_reason") BETWEEN 20 AND 2000));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'noe_record_payer_status_date_chk') THEN
    ALTER TABLE "noe_record" ADD CONSTRAINT "noe_record_payer_status_date_chk"
      CHECK (("payer_status_date" IS NULL) = ("payer_status_date_source" IS NULL)
        AND ("payer_status_date_source" IS NULL
             OR "payer_status_date_source" IN ('277ca_stc02', '999_gs04', '999_isa09', 'receipt')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notr_record_corrects_notice_fk') THEN
    ALTER TABLE "notr_record" ADD CONSTRAINT "notr_record_corrects_notice_fk"
      FOREIGN KEY ("corrects_notice_id") REFERENCES "notr_record"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notr_record_correction_reason_chk') THEN
    ALTER TABLE "notr_record" ADD CONSTRAINT "notr_record_correction_reason_chk"
      CHECK (("corrects_notice_id" IS NULL) = ("correction_reason" IS NULL)
        AND ("correction_reason" IS NULL OR length("correction_reason") BETWEEN 20 AND 2000));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notr_record_payer_status_date_chk') THEN
    ALTER TABLE "notr_record" ADD CONSTRAINT "notr_record_payer_status_date_chk"
      CHECK (("payer_status_date" IS NULL) = ("payer_status_date_source" IS NULL)
        AND ("payer_status_date_source" IS NULL
             OR "payer_status_date_source" IN ('277ca_stc02', '999_gs04', '999_isa09', 'receipt')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_occurrence_spans_array_chk') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_occurrence_spans_array_chk"
      CHECK (jsonb_typeof("occurrence_spans") = 'array');
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "noe_record_open_correction_uq" ON "noe_record" ("corrects_notice_id")
  WHERE "corrects_notice_id" IS NOT NULL AND "state" NOT IN ('CANCELLED', 'ACK_REJECTED');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notr_record_open_correction_uq" ON "notr_record" ("corrects_notice_id")
  WHERE "corrects_notice_id" IS NOT NULL AND "state" NOT IN ('CANCELLED', 'ACK_REJECTED');
