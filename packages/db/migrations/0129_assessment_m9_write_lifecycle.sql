-- M9L write lifecycle — the Drizzle §10 assessment write pipeline (record → correct → cosign →
-- acknowledge → license/policy admin). The M9 tables were shaped for a COMPLETED record; the §4.1 write
-- routes carry only the intent (a record has the scale + data + recorder discipline; a license-admin call
-- has the vendor + dates). Relax the NOT-NULLs those thin routes do not capture, mirroring M6 0123 /
-- M7 0127 / M8 0128:
--
--   * clinical_assessment + assessment_cosignature provider_entity_id + location_id were NOT NULL
--     (denormalized siting for location-scoped ABAC + multi-CCN reporting), but the record route carries
--     only patient + admission + scale; siting backfills from the M6 admission / M17 visit context when
--     threaded. (clinical_assessment is PARTITION BY RANGE — the ALTER propagates to every leaf.)
--   * scale_license.recorded_by_membership_id + scale_policy.updated_by_membership_id were NOT NULL, but
--     the AssessmentRouteService license/policy-admin methods thread no acting membership. Relax both to
--     nullable; the acting membership backfills when the interface carries it (the M7/M8 null-actor
--     convention — writes also envelope withOrgContext with userId:"" so the audit actor is NULL).
ALTER TABLE "clinical_assessment" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "clinical_assessment" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_cosignature" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_cosignature" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "scale_license" ALTER COLUMN "recorded_by_membership_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "scale_policy" ALTER COLUMN "updated_by_membership_id" DROP NOT NULL;
