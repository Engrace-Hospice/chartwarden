-- M23 — ack-stage split (ADR-0053 D2, plan A6). Additive only: no enum value is added or renamed.
--
-- A clearinghouse (e.g. Stedi) acknowledges a file BEFORE the payer does. State meaning stays:
--   ACK_PENDING  = the clearinghouse / 999 accepted the file
--   ACK_ACCEPTED = the PAYER (MAC) accepted it (277CA at payer stage)
-- so a clearinghouse-stage acceptance never advances a record to ACK_ACCEPTED and never stamps payer_status_date
-- (ADR-0052 D4: NOE timeliness is judged on MAC acceptance).
--
--   claim_acknowledgment.stage      'clearinghouse' | 'payer'. Backfill: ack_999 rows -> clearinghouse, ack_277ca and
--                                   ack_835 rows -> payer (the only path before a clearinghouse existed is direct MAC).
--   noe_record / notr_record / claim .clearinghouse_accepted_at  when the clearinghouse accepted the file (NULL = not yet).
--   noe_record / notr_record        .rejection_stage additionally allows 'clearinghouse'.
-- Forward-only and idempotent.

ALTER TABLE "claim_acknowledgment" ADD COLUMN IF NOT EXISTS "stage" text;--> statement-breakpoint
UPDATE "claim_acknowledgment" SET "stage" = CASE WHEN "kind" = 'ack_999' THEN 'clearinghouse' ELSE 'payer' END WHERE "stage" IS NULL;--> statement-breakpoint
ALTER TABLE "claim_acknowledgment" ALTER COLUMN "stage" SET DEFAULT 'payer';--> statement-breakpoint
ALTER TABLE "claim_acknowledgment" ALTER COLUMN "stage" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_acknowledgment_stage_chk') THEN
    ALTER TABLE "claim_acknowledgment" ADD CONSTRAINT "claim_acknowledgment_stage_chk"
      CHECK ("stage" IN ('clearinghouse', 'payer'));
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "clearinghouse_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "noe_record" ADD COLUMN IF NOT EXISTS "clearinghouse_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notr_record" ADD COLUMN IF NOT EXISTS "clearinghouse_accepted_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "noe_record" DROP CONSTRAINT IF EXISTS "noe_record_rejection_stage_chk";--> statement-breakpoint
ALTER TABLE "noe_record" ADD CONSTRAINT "noe_record_rejection_stage_chk"
  CHECK ("rejection_stage" IS NULL OR "rejection_stage" IN ('999', '277ca', 'clearinghouse'));--> statement-breakpoint
ALTER TABLE "notr_record" DROP CONSTRAINT IF EXISTS "notr_record_rejection_stage_chk";--> statement-breakpoint
ALTER TABLE "notr_record" ADD CONSTRAINT "notr_record_rejection_stage_chk"
  CHECK ("rejection_stage" IS NULL OR "rejection_stage" IN ('999', '277ca', 'clearinghouse'));
