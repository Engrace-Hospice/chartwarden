-- M22 Documents Phase 1 — referral-bound verified uploads + durable provenance staging.
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'referral';--> statement-breakpoint
ALTER TABLE "document_upload" ADD COLUMN IF NOT EXISTS "source_metadata" jsonb;
