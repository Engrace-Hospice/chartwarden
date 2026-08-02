-- M11L write lifecycle — the Drizzle order write path (createDraft/edit/requestSignature/sign/signOnBehalf/
-- recordVerbal/cosign/discontinue/correct/complete, standing-order create/edit/pause/resume/discontinue/
-- spawn, verbal-policy upsert). The M11 tables were shaped for a COMPLETED record whose three-column
-- tenancy (provider_entity_id + location_id) is denormalized from the admission at create-time; the §4.1
-- write routes carry only the clinical intent (a draft has the kind + data + author discipline; a standing
-- template has its cadence). Relax the NOT-NULLs those thin routes do not capture, mirroring
-- M6 0123 / M7 0127 / M8 0128 / M9 0129 / M10 0130:
--
--   * order_record / order_signature / verbal_order / standing_order / standing_order_instance /
--     order_discontinuation provider_entity_id + location_id were NOT NULL (denormalized siting for
--     location-scoped ABAC + Q-code attribution), but the write routes carry only admission + kind; siting
--     backfills from the M6 admission / M17 visit context when threaded. (order_record is PARTITION BY
--     RANGE(created_at) — the ALTER propagates to every leaf. The §3.4 correction-supersede trigger sources
--     order_discontinuation's PE/location from the correcting order_record NEW, so both must relax together.)
--   * order_verbal_policy.updated_by_membership_id was NOT NULL, but `putVerbalPolicy(organizationId, args)`
--     threads no actor (§4.1 route shape). Relax to nullable so a policy upsert is legal without a membership.
ALTER TABLE "order_record" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_record" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_signature" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_signature" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "verbal_order" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "verbal_order" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "standing_order" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "standing_order" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "standing_order_instance" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "standing_order_instance" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_discontinuation" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_discontinuation" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_verbal_policy" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_verbal_policy" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_verbal_policy" ALTER COLUMN "updated_by_membership_id" DROP NOT NULL;
