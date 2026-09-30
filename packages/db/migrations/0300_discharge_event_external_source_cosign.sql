-- F-227 (#248) — M6 §4.8.4 / W-M6-31 / W-DC-02 provenance + medical-director cosign facts on `discharge_event`.
-- An external (M29-accepted HL7 ADT) death is recorded `completed` IMMEDIATELY (admission discharged, election/LOC
-- ended — the spec's recordExternalDeath) but is flagged `cosign_required` and stamped with the M29 proposal it came
-- from; the medical director later attests (route 40) and the cosign facts land here. `source_proposal_id` is a
-- LOGICAL uuid (M29 `hl7_inbound_proposal.id`; M6's dependsOn excludes 29 — no SQL FK, migration 0250/0297
-- posture). `medical_director_membership_id` is the acting user id as every other M6 actor column (logical).
-- Every existing row is an internal-clinician discharge: defaults make it so. Idempotent (IF NOT EXISTS / catalog guards).
ALTER TABLE "discharge_event"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'internal_clinician_recorded',
  ADD COLUMN IF NOT EXISTS "source_proposal_id" uuid,
  ADD COLUMN IF NOT EXISTS "cosign_required" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "medical_director_membership_id" uuid,
  ADD COLUMN IF NOT EXISTS "cosigned_at" timestamp with time zone;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discharge_event_source_chk') THEN
    ALTER TABLE "discharge_event" ADD CONSTRAINT "discharge_event_source_chk"
      CHECK ("source" IN ('internal_clinician_recorded', 'hl7_external'));
  END IF;
  -- An external-source discharge always names its proposal and always awaits (or carries) a cosign.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discharge_event_external_provenance_chk') THEN
    ALTER TABLE "discharge_event" ADD CONSTRAINT "discharge_event_external_provenance_chk"
      CHECK ("source" <> 'hl7_external' OR ("source_proposal_id" IS NOT NULL AND "cosign_required"));
  END IF;
  -- The cosign facts land together or not at all.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discharge_event_cosign_pair_chk') THEN
    ALTER TABLE "discharge_event" ADD CONSTRAINT "discharge_event_cosign_pair_chk"
      CHECK (("cosigned_at" IS NULL) = ("medical_director_membership_id" IS NULL));
  END IF;
END $$;

-- One discharge per proposal (a redelivered accept can never mint a second external death row).
CREATE UNIQUE INDEX IF NOT EXISTS "discharge_source_proposal_idx"
  ON "discharge_event" ("organization_id", "source_proposal_id")
  WHERE "source_proposal_id" IS NOT NULL;
