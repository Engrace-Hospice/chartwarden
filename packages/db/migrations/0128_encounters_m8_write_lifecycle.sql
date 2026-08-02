-- M8L-T02 — the Drizzle encounter WRITE lifecycle. The M8 tables were shaped for a COMPLETED clinical
-- record (an encounter is "a patient-level, location-anchored clinical event, always sited from the M17
-- visit / M6 admission context"), but the §4.1 write routes carry only the intent: `createDraft` has a
-- patient + admission, `captureVitals` has readings, `sign` has step-up freshness. Two shape changes let
-- the writes persist that intent as the NOBYPASSRLS wardenx_app role:
--
--   * provider_entity_id + location_id were NOT NULL on the encounter subtree (denormalized siting for
--     location-scoped ABAC + multi-CCN M33 reporting), but the draft route captures neither and the M6
--     admission may itself be unsited (M6 relaxed the same pair in 0123, M7 in 0127). Relax the pair to
--     nullable across the tables the write lifecycle touches (encounter + the vitals/mileage/addendum/
--     cosignature satellites); the siting backfills when the admission has it. cosignature_request keeps
--     routed_to_membership_id NOT NULL — the service routes to the authoring membership (the assigned RN
--     case manager backfills when M5's CaseloadProvider is threaded).
--   * encounter_addendum.status only allowed ('draft','signed','voided'), but the §2.3 addendum machine
--     is draft → finalized → signed: `finalize` needs a persistable `finalized` state so the subsequent
--     `sign` transitions from it (the DB is the machine's store, not just its terminal snapshot). Widen
--     the CHECK to include 'finalized' ('finalized' is already a legal encounter_status enum value).
ALTER TABLE "encounter" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "vitals" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "vitals" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mileage" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mileage" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter_addendum" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter_addendum" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cosignature_request" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cosignature_request" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter_addendum" DROP CONSTRAINT IF EXISTS "encounter_addendum_status_allowed";--> statement-breakpoint
ALTER TABLE "encounter_addendum" ADD CONSTRAINT "encounter_addendum_status_allowed" CHECK (status IN ('draft','finalized','signed','voided'));
