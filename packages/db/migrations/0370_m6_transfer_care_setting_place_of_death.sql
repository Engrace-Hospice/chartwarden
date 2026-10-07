-- M6 — the two facts the Medicare hospice claim's patient discharge status needs (CMS Pub. 100-04 Ch. 11 §30.3):
--
--   transfer_event.receiving_care_setting  'home' | 'facility' — where the RECEIVING hospice cares for the patient
--                                          on a transfer-out: status 50 (hospice, home) vs 51 (hospice, medical
--                                          facility). Required by route 37 for new transfer-outs.
--   discharge_event.place_of_death         'home' | 'facility' | 'unknown' — status 40 / 41 / 42 on a death.
--                                          Required for new internal death discharges; an HL7-reported death
--                                          records 'unknown'.
--
-- Additive and nullable with no backfill: historic rows stay NULL and M23's discharge rule blocks the claim until
-- a biller resolves them (never guessed). No PHI beyond what the rows already hold; the existing org RLS policies,
-- FORCE RLS and write-audit triggers cover the new columns. Idempotent (IF NOT EXISTS / catalog guards).
ALTER TABLE "transfer_event" ADD COLUMN IF NOT EXISTS "receiving_care_setting" text;--> statement-breakpoint
ALTER TABLE "discharge_event" ADD COLUMN IF NOT EXISTS "place_of_death" text;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transfer_event_receiving_care_setting_chk') THEN
    ALTER TABLE "transfer_event" ADD CONSTRAINT "transfer_event_receiving_care_setting_chk"
      CHECK ("receiving_care_setting" IS NULL OR "receiving_care_setting" IN ('home', 'facility'));
  END IF;
  -- Only a transfer OUT names a receiving hospice's care setting.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transfer_event_care_setting_out_only_chk') THEN
    ALTER TABLE "transfer_event" ADD CONSTRAINT "transfer_event_care_setting_out_only_chk"
      CHECK ("receiving_care_setting" IS NULL OR "direction" = 'out');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discharge_event_place_of_death_chk') THEN
    ALTER TABLE "discharge_event" ADD CONSTRAINT "discharge_event_place_of_death_chk"
      CHECK ("place_of_death" IS NULL OR "place_of_death" IN ('home', 'facility', 'unknown'));
  END IF;
  -- Only a death names a place of death.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discharge_event_place_of_death_death_only_chk') THEN
    ALTER TABLE "discharge_event" ADD CONSTRAINT "discharge_event_place_of_death_death_only_chk"
      CHECK ("place_of_death" IS NULL OR "discharge_type" = 'death');
  END IF;
END $$;
