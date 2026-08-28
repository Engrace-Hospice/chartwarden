-- F-064 (#159) — make `encounter_care_plan_link` writable, and make its removal real.
--
-- `POST /api/v1/encounters/{encounterId}/care-plan-links` parsed a body carrying the M7 problem / goal /
-- intervention refs, discarded it, persisted nothing, and answered 201 Created with the ENCOUNTER's own
-- id under the name `linkId`. The service said the refs "are not carried by this route" — true, and only
-- half the reason. The other half is here:
--
--   * `encounter_care_plan_link.provider_entity_id` / `location_id` are NOT NULL, and 0128 (the M8 write
--     lifecycle) relaxed exactly that pair on `encounter`, `vitals`, `mileage`, `encounter_addendum` and
--     `cosignature_request` — every encounter satellite EXCEPT this one — because "the draft route
--     captures neither and the M6 admission may itself be unsited". So the link's siting had to be
--     copied from an encounter whose own siting is null. The insert could not have succeeded.
--
-- Relaxing the pair finishes 0128's list. The siting is now stamped on the encounter at createDraft
-- from M6's `AdmissionStatusReader` (which is what 0128's "the siting backfills when the admission has
-- it" was waiting for), and the link copies it — so these columns are real whenever the admission is
-- sited, and null rather than blocking when it is not. Documenting care must not depend on it.
ALTER TABLE "encounter_care_plan_link" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter_care_plan_link" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint

-- `DELETE /api/v1/encounters/{encounterId}/care-plan-links/{linkId}` loaded the encounter, checked it was
-- mutable, and returned 204 having removed nothing. It could not do otherwise: `wardenx_app` holds DELETE
-- on NO M8 table (§3.6 append-only, uniform across all ten), and there was no column to mark instead.
--
-- A soft invalidate, not a grant of DELETE. A mis-clicked link on a DRAFT encounter is ordinary editing
-- and must be undoable without an addendum; the row itself stays, because the M4 write-audit trigger's
-- trail is only as good as the rows it describes. Reads filter `removed_at IS NULL`.
ALTER TABLE "encounter_care_plan_link" ADD COLUMN "removed_at" timestamptz;--> statement-breakpoint
ALTER TABLE "encounter_care_plan_link" ADD COLUMN "removed_by_membership_id" uuid REFERENCES "membership"("id") ON DELETE restrict;--> statement-breakpoint

-- Both or neither: a removal with no actor is unattributable, and an actor with no instant is not a
-- removal. The pair is what makes the trail answer "who un-linked this, and when".
ALTER TABLE "encounter_care_plan_link"
  ADD CONSTRAINT "encounter_care_plan_link_removal_consistent"
  CHECK ((removed_at IS NULL) = (removed_by_membership_id IS NULL));--> statement-breakpoint

-- The hot read is "the live links on this encounter", which is what the GET route and every downstream
-- consumer of the plan-of-care join wants.
CREATE INDEX IF NOT EXISTS "encounter_care_plan_link_live_idx"
  ON "encounter_care_plan_link" ("encounter_id")
  WHERE removed_at IS NULL;
