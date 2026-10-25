-- M23 (ADR-0103 D5, issue #760) -- send a DDE work item through the bound DdeAccessProvider and ingest its outcome.
--
--   1. dde_work_item.submission_mode ('manual' | 'provider') says WHO vouches for "submitted": an operator who keyed
--      it in DDE (an attestation, ADR-0052 D2) or a provider that answered for it (provider-verified, ADR-0103 D5).
--      dde_work_item.provider_reference is the provider's opaque id for the operation (no MBI, no free text).
--      Both describe the CURRENT attempt; a retry clears them. Existing submitted rows were all manual.
--   2. payer_status_date_source learns 'dde_provider': the MAC's own date for an answer a provider reported.
--   3. Permission catalog row + admin-role grant for billing.dde.submit_via_provider.
-- Idempotent.

ALTER TABLE "dde_work_item" ADD COLUMN IF NOT EXISTS "submission_mode" text;--> statement-breakpoint
ALTER TABLE "dde_work_item" ADD COLUMN IF NOT EXISTS "provider_reference" text;--> statement-breakpoint

UPDATE "dde_work_item" SET "submission_mode" = 'manual'
 WHERE "submission_mode" IS NULL AND "submitted_at" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "dde_work_item" DROP CONSTRAINT IF EXISTS "dde_work_item_submission_mode_chk";--> statement-breakpoint
ALTER TABLE "dde_work_item" ADD CONSTRAINT "dde_work_item_submission_mode_chk" CHECK (
	("submission_mode" IS NULL OR "submission_mode" IN ('manual', 'provider'))
	-- A provider submission names the provider's operation; nothing else carries a reference.
	AND (("submission_mode" IS NOT DISTINCT FROM 'provider') = ("provider_reference" IS NOT NULL))
	-- A short opaque token: a closed alphabet and length is no place to hide an identifier or free text.
	AND ("provider_reference" IS NULL OR "provider_reference" ~ '^[A-Za-z0-9:._-]{1,64}$')
);--> statement-breakpoint

ALTER TABLE "noe_record" DROP CONSTRAINT IF EXISTS "noe_record_payer_status_date_chk";--> statement-breakpoint
ALTER TABLE "noe_record" ADD CONSTRAINT "noe_record_payer_status_date_chk"
  CHECK (("payer_status_date" IS NULL) = ("payer_status_date_source" IS NULL)
    AND ("payer_status_date_source" IS NULL
         OR "payer_status_date_source" IN ('277ca_stc02', '999_gs04', '999_isa09', 'receipt', 'dde_manual', 'dde_provider')));--> statement-breakpoint
ALTER TABLE "notr_record" DROP CONSTRAINT IF EXISTS "notr_record_payer_status_date_chk";--> statement-breakpoint
ALTER TABLE "notr_record" ADD CONSTRAINT "notr_record_payer_status_date_chk"
  CHECK (("payer_status_date" IS NULL) = ("payer_status_date_source" IS NULL)
    AND ("payer_status_date_source" IS NULL
         OR "payer_status_date_source" IN ('277ca_stc02', '999_gs04', '999_isa09', 'receipt', 'dde_manual', 'dde_provider')));--> statement-breakpoint

INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('billing.dde.submit_via_provider', 'billing_dde', 'submit_via_provider', 'billing', 'provider_entity_billing_scope', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'billing.dde.submit_via_provider'
  FROM "role" r
 WHERE r."key" IN ('administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
