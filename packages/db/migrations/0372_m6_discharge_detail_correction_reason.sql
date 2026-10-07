-- M6 — why a claim-relevant discharge detail was CHANGED after it had been recorded:
--
--   discharge_event.place_of_death_correction_reason          the reason a recorded place of death was corrected
--   transfer_event.receiving_care_setting_correction_reason   the reason a recorded receiving care setting was
--                                                             corrected
--
-- Written by `POST /api/v1/discharges/:id/place-of-death` and `POST /api/v1/transfers/:id/receiving-care-setting`.
-- Filling a value that was never recorded (historic rows, migration 0370) needs no reason; replacing a recorded value
-- does (the value drives the Medicare claim's patient discharge status 40/41/42 or 50/51, CMS Pub. 100-04 Ch. 11
-- §30.3, so a silent change would re-code a claim with no explanation). The column sits on the row it explains, so
-- the existing M4 write-audit trigger records the old value, the new value and the reason in ONE audit row; the org
-- RLS policies and FORCE RLS already cover new columns. Nullable, no backfill. Idempotent.
ALTER TABLE "discharge_event" ADD COLUMN IF NOT EXISTS "place_of_death_correction_reason" text;--> statement-breakpoint
ALTER TABLE "transfer_event" ADD COLUMN IF NOT EXISTS "receiving_care_setting_correction_reason" text;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discharge_event_pod_correction_reason_len_chk') THEN
    ALTER TABLE "discharge_event" ADD CONSTRAINT "discharge_event_pod_correction_reason_len_chk"
      CHECK ("place_of_death_correction_reason" IS NULL OR char_length("place_of_death_correction_reason") BETWEEN 20 AND 2000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transfer_event_rcs_correction_reason_len_chk') THEN
    ALTER TABLE "transfer_event" ADD CONSTRAINT "transfer_event_rcs_correction_reason_len_chk"
      CHECK ("receiving_care_setting_correction_reason" IS NULL OR char_length("receiving_care_setting_correction_reason") BETWEEN 20 AND 2000);
  END IF;
END $$;
