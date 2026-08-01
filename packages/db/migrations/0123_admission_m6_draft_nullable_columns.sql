-- M6L-T02 — a draft admission minted from an accepted referral (the §7.1 admission.draft_from_referral
-- cascade) does not yet have a provider entity or an admitting physician assigned; those are set during
-- the §7.2 admission wizard, before activation. The columns were NOT NULL, which made the referral→admission
-- cascade impossible to persist. Relax them to nullable; activation (R-AC-01) still gates on the signed
-- election/CTI/NOR bundle, and the in-memory slice already modelled these as null at draft.
ALTER TABLE "admission" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "admission" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "admission" ALTER COLUMN "admitted_by_physician_id" DROP NOT NULL;
