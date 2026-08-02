-- M12L write lifecycle — the Drizzle DoseSpot write path (createDraft/edit/requestSignature/sign/verbal/
-- cosign/discontinue/complete/correct/retransmit, refill approve/deny, prescriber enroll/revoke). The M12
-- tables were shaped for a COMPLETED record whose three-column tenancy (provider_entity_id + location_id) is
-- denormalized from the admission at create-time; the §4.1 write routes carry only the clinical intent (a
-- draft has the med class + data + drug identity). Relax the NOT-NULLs those thin routes do not capture,
-- mirroring M6 0123 / M7 0127 / M8 0128 / M9 0129 / M10 0130 / M11 0131:
--
--   * medication_order provider_entity_id + location_id were NOT NULL (denormalized siting for location-
--     scoped ABAC + Q-code attribution), but createDraft carries only admission + med class; siting backfills
--     from the M6 admission / M17 visit context when threaded. (medication_order is PARTITION BY
--     RANGE(created_at) — the ALTER propagates to every leaf.)
--   * dosespot_prescriber.npi was NOT NULL, but `enrollPrescriber(organizationId, membershipId,
--     deaAuthorizedSchedules)` threads no NPI (§4.1 route shape) — the NPI is captured out-of-band at IAL2
--     identity-proofing. Relax to nullable so an enrollment row is legal before the NPI lands.
ALTER TABLE "medication_order" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_order" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dosespot_prescriber" ALTER COLUMN "npi" DROP NOT NULL;
