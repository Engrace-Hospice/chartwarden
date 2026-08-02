-- M7L-T02 — the Drizzle care-plan WRITE lifecycle. The six M7 tables were shaped for a COMPLETED
-- record; the §4.1 routes carry only the intent (a bootstrap has a patient + admission, an element
-- write has its text). Two shape changes let the writes persist that intent:
--
--   * care_plan / care_plan_version carried NO optimistic-concurrency column, so the read DTO surfaced a
--     constant `version: 1` (flagged in care-plan-route-service-db.ts). The finalize / sign / return-to-
--     draft routes all pass an `ifVersion` (§7.7) that had nothing to compare against. Add a real
--     `version` (integer NOT NULL DEFAULT 1) to both so the version aggregate optimistic-locks like the
--     element rows (problem/goal/intervention already carry `version`).
--   * provider_entity_id + location_id were NOT NULL on all six tables (denormalized siting for the
--     IDG/overdue dashboards), but the bootstrap route carries only patientId + admissionId — and the
--     admission itself may not be sited yet (M6 relaxed admission PE/location the same way in 0123).
--     Relax the pair to nullable across the subtree; the siting backfills when the admission has it.
--   * care_plan_signature required membership_id (a signer FK) + attestation_text, but the sign route
--     (POST …/signatures) carries only the signer_role — the CarePlanRouteService does not thread the
--     acting membership. Relax both to nullable and default signature_method, so a signature persists
--     the quorum-bearing role now; the acting membership + attestation backfill when the interface
--     threads them.
ALTER TABLE "care_plan" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "care_plan_version" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "care_plan" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "care_plan" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "care_plan_version" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "care_plan_version" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "care_plan_signature" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "care_plan_signature" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "care_plan_signature" ALTER COLUMN "membership_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "care_plan_signature" ALTER COLUMN "attestation_text" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "care_plan_signature" ALTER COLUMN "signature_method" SET DEFAULT 'password_step_up';--> statement-breakpoint
-- D8 return-to-draft clears the version's collected signatures, but the §3.6 grant policy gives
-- wardenx_app DELETE on NO care-plan table (signatures are append-only for survey reconstruction). So a
-- cleared signature is INVALIDATED, never destroyed: `invalidated_at` tombstones it (the row + its audit
-- trail survive), the version-role uniqueness goes PARTIAL on `invalidated_at IS NULL` so the same role
-- can re-sign after a return-to-draft, and the quorum read counts only the live (non-invalidated) rows.
ALTER TABLE "care_plan_signature" ADD COLUMN "invalidated_at" timestamptz;--> statement-breakpoint
DROP INDEX IF EXISTS "care_plan_signature_version_role_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "care_plan_signature_version_role_uq" ON "care_plan_signature" ("care_plan_version_id","signer_role") WHERE "invalidated_at" IS NULL;--> statement-breakpoint
ALTER TABLE "problem" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "problem" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "goal" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "goal" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "intervention" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "intervention" ALTER COLUMN "location_id" DROP NOT NULL;
