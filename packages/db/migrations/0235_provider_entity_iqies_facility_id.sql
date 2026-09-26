-- M1 Foundation — the provider entity's iQIES facility ID (CMS HOPE control item FAC_ID, "Assigned
-- provider submission ID", Text(16)). CMS assigns it when the hospice registers in iQIES; every HOPE
-- record the provider submits must carry it in the submission header. Set at provisioning alongside
-- CCN/NPI (M1 exposes no provider_entity write route). Nullable: a provider not yet registered in iQIES
-- simply cannot package HOPE records, and packaging says so (WX-HOPE-SUBMISSION-FACILITY-ID).
ALTER TABLE "provider_entity" ADD COLUMN IF NOT EXISTS "iqies_facility_id" text;--> statement-breakpoint
ALTER TABLE "provider_entity" ADD CONSTRAINT "provider_entity_iqies_facility_id_format"
  CHECK ("iqies_facility_id" IS NULL OR "iqies_facility_id" ~ '^[A-Za-z0-9]{1,16}$');
