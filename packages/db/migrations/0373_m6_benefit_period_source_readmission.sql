-- M6 — the first benefit period of a NEW admission is no longer always 1 (readmission workflow).
--
-- Benefit periods are 90, 90, then unlimited 60 days "available in the order listed" (42 CFR 418.21); a live discharge
-- or revocation ends the current period and a later re-election is into the next available one (418.24, 418.28(c)(3)),
-- counted per beneficiary across every hospice (Claims Processing Manual ch. 11 §20.1.6). The number a new admission
-- elects into is therefore entered by staff, confirmed against HETS / ELGA / ELGH where possible, with our own history
-- only as the suggestion. These columns record how that number was established:
--
--   election_period.benefit_period_source        hets_confirmed | staff_entered_unverified | internal_history
--                                                (NULL on every period that is not an admission's first, and on
--                                                historic rows)
--   election_period.benefit_period_suggested     the number our own history suggested at intake
--   election_period.benefit_period_confirmed_by  the staff member who entered / confirmed it (logical user id)
--   election_period.benefit_period_confirmed_on  the day it was checked in HETS / ELGA / ELGH (hets_confirmed only)
--
-- and the face-to-face exceptional-circumstance path for a NEW admission in period 3 or later (Medicare Benefit Policy
-- Manual ch. 9 §20.1(5)(d): an encounter within 2 days after admission is timely when exceptional circumstances are
-- documented, and a death within those 2 days deems it complete):
--
--   election_period.f2f_exception_reason / _documented_by / _documented_at
--
-- admission.readmitted_from_admission_id links a readmission to the earlier, live-discharged admission it follows
-- (SET NULL on delete so the admission eraser can remove a patient's admissions in any order).
--
-- Nullable, no backfill. The org RLS policies, FORCE RLS and the M4 write-audit triggers already cover new columns.
-- Idempotent.
ALTER TABLE "election_period" ADD COLUMN IF NOT EXISTS "benefit_period_source" text;--> statement-breakpoint
ALTER TABLE "election_period" ADD COLUMN IF NOT EXISTS "benefit_period_suggested" smallint;--> statement-breakpoint
ALTER TABLE "election_period" ADD COLUMN IF NOT EXISTS "benefit_period_confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "election_period" ADD COLUMN IF NOT EXISTS "benefit_period_confirmed_on" date;--> statement-breakpoint
ALTER TABLE "election_period" ADD COLUMN IF NOT EXISTS "f2f_exception_reason" text;--> statement-breakpoint
ALTER TABLE "election_period" ADD COLUMN IF NOT EXISTS "f2f_exception_documented_by" uuid;--> statement-breakpoint
ALTER TABLE "election_period" ADD COLUMN IF NOT EXISTS "f2f_exception_documented_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admission" ADD COLUMN IF NOT EXISTS "readmitted_from_admission_id" uuid;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'election_period_benefit_period_source_chk') THEN
    ALTER TABLE "election_period" ADD CONSTRAINT "election_period_benefit_period_source_chk"
      CHECK ("benefit_period_source" IS NULL
             OR "benefit_period_source" IN ('hets_confirmed', 'staff_entered_unverified', 'internal_history'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'election_period_benefit_period_confirmed_on_chk') THEN
    ALTER TABLE "election_period" ADD CONSTRAINT "election_period_benefit_period_confirmed_on_chk"
      CHECK (("benefit_period_source" = 'hets_confirmed' AND "benefit_period_confirmed_on" IS NOT NULL)
             OR ("benefit_period_source" IS DISTINCT FROM 'hets_confirmed' AND "benefit_period_confirmed_on" IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'election_period_benefit_period_suggested_chk') THEN
    ALTER TABLE "election_period" ADD CONSTRAINT "election_period_benefit_period_suggested_chk"
      CHECK ("benefit_period_suggested" IS NULL OR "benefit_period_suggested" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'election_period_f2f_exception_reason_chk') THEN
    ALTER TABLE "election_period" ADD CONSTRAINT "election_period_f2f_exception_reason_chk"
      CHECK ("f2f_exception_reason" IS NULL
             OR (char_length("f2f_exception_reason") BETWEEN 20 AND 2000 AND "sequence_number" >= 3));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_readmitted_from_admission_id_fk') THEN
    ALTER TABLE "admission" ADD CONSTRAINT "admission_readmitted_from_admission_id_fk"
      FOREIGN KEY ("readmitted_from_admission_id") REFERENCES "admission" ("id") ON DELETE SET NULL;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admission_readmitted_from_idx" ON "admission" ("readmitted_from_admission_id")
  WHERE "readmitted_from_admission_id" IS NOT NULL;
