-- M10L write lifecycle — the Drizzle HOPE write path (record/sign/correct timepoint, SFV completion,
-- submission assemble/retry, schedule skip). The M10 tables were shaped for a COMPLETED record; the §4.1
-- write routes carry only the intent (a record has the RFA kind + data + author discipline; an assemble
-- call has the provider entity). Relax the NOT-NULLs those thin routes do not capture, mirroring
-- M6 0123 / M7 0127 / M8 0128 / M9 0129:
--
--   * hope_assessment + symptom_follow_up_visit provider_entity_id + location_id were NOT NULL
--     (denormalized siting for location-scoped ABAC), but the record route carries only admission + RFA;
--     siting backfills from the M6 admission / M17 visit context when threaded. (hope_assessment is
--     PARTITION BY RANGE — the ALTER propagates to every leaf.)
--   * hope_submission.envelope_storage_uri + envelope_sha256 were NOT NULL, but `assembleSubmission`
--     QUEUES a submission row before the iQIES envelope exists — the envelope URI + digest are populated
--     by the transmit worker (§4.10), not at queue time. Relax both to nullable so a `queued` row is legal
--     before assembly; they fill in on transmit.
ALTER TABLE "hope_assessment" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hope_assessment" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "symptom_follow_up_visit" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "symptom_follow_up_visit" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hope_submission" ALTER COLUMN "envelope_storage_uri" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hope_submission" ALTER COLUMN "envelope_sha256" DROP NOT NULL;
