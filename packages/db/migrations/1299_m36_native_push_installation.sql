-- compat: contract
-- ADR-0105: native push installation identity on delivery_endpoint.
--
--   An FCM/APNs token rotates (reinstall, restore, OS-initiated refresh). Keyed only by the token, a rotation left the old row behind as a
--   second "verified" endpoint for the same phone, so one alert pushed twice and a dead token kept failing. An installation is the stable thing:
--   the app mints one opaque install id per app install and re-registers it with each new token; the server replaces the row's token in place.
--
--   Columns (all nullable, so the previous release keeps working): install_id (opaque, app-minted), environment (which APNs host / FCM project
--   the token belongs to; a development build's token is rejected by the production host), app_version / app_build (diagnostics),
--   last_failure_code (the provider's reason on the last failed send; a code, never a message body), rotated_at.
--
--   delivery_endpoint stays user-owned (RLS delivery_endpoint_self on app.user_id; NON_ORG_SCOPED in check-tenancy). Uniqueness is therefore
--   (user_id, provider, install_id), not per org. Web and non-push rows never carry an install id.
ALTER TABLE "delivery_endpoint" ADD COLUMN "install_id" text;--> statement-breakpoint
ALTER TABLE "delivery_endpoint" ADD COLUMN "environment" text;--> statement-breakpoint
ALTER TABLE "delivery_endpoint" ADD COLUMN "app_version" text;--> statement-breakpoint
ALTER TABLE "delivery_endpoint" ADD COLUMN "app_build" text;--> statement-breakpoint
ALTER TABLE "delivery_endpoint" ADD COLUMN "last_failure_code" text;--> statement-breakpoint
ALTER TABLE "delivery_endpoint" ADD COLUMN "rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_endpoint" ADD CONSTRAINT "delivery_endpoint_install_native_only_chk" CHECK ("install_id" IS NULL OR ("provider" <> 'web' AND "install_id" ~ '^[A-Za-z0-9_-]{8,128}$'));--> statement-breakpoint
ALTER TABLE "delivery_endpoint" ADD CONSTRAINT "delivery_endpoint_environment_chk" CHECK ("environment" IS NULL OR ("provider" <> 'web' AND "environment" IN ('sandbox', 'production')));--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_endpoint_install_unique" ON "delivery_endpoint" ("user_id", "provider", "install_id") WHERE "install_id" IS NOT NULL;
