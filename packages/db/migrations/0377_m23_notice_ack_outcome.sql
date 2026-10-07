-- M23 — record the MAC's answer on the Notice of Election / Notice of Termination-Revocation itself. The 999 /
-- 277CA acknowledgment crons used to route only claims and transfer notices; a NOE's or NOTR's ack was appended
-- to `claim_acknowledgment` with no claim and then dropped, so a rejected NOE looked valid, a rejected NOTR counted
-- as filed and no acceptance date was ever recorded (NOE timeliness, occurrence span 77).
--
--   accepted_at       timestamptz, NULLABLE. When the 277CA acceptance was received (ACK_ACCEPTED). This is the
--                     ingest time: the gateway's parsed 277CA carries no payer status date.
--   rejected_at       timestamptz, NULLABLE. When the 999 or 277CA rejection was received (ACK_REJECTED).
--   rejection_stage   text, NULLABLE, '999' | '277ca' — which acknowledgment rejected it.
--   rejection_codes   text[], NULLABLE, at most 20 — the PHI-free X12 reason codes (code-shaped tokens only;
--                     the worker drops anything else). The raw 999 / 277CA is NEVER stored on the notice: it
--                     stays in object storage, referenced from `claim_acknowledgment.ack_file_uri`, which is
--                     also the per-ack audit trail (`latest_acknowledgment_id` points at it).
--
-- The existing org RLS policies, FORCE RLS and the write-audit triggers cover the new columns. Idempotent.
ALTER TABLE "noe_record" ADD COLUMN IF NOT EXISTS "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "noe_record" ADD COLUMN IF NOT EXISTS "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "noe_record" ADD COLUMN IF NOT EXISTS "rejection_stage" text;--> statement-breakpoint
ALTER TABLE "noe_record" ADD COLUMN IF NOT EXISTS "rejection_codes" text[];--> statement-breakpoint
ALTER TABLE "notr_record" ADD COLUMN IF NOT EXISTS "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notr_record" ADD COLUMN IF NOT EXISTS "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notr_record" ADD COLUMN IF NOT EXISTS "rejection_stage" text;--> statement-breakpoint
ALTER TABLE "notr_record" ADD COLUMN IF NOT EXISTS "rejection_codes" text[];--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'noe_record_rejection_stage_chk') THEN
    ALTER TABLE "noe_record" ADD CONSTRAINT "noe_record_rejection_stage_chk"
      CHECK ("rejection_stage" IS NULL OR "rejection_stage" IN ('999', '277ca'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'noe_record_rejection_codes_chk') THEN
    ALTER TABLE "noe_record" ADD CONSTRAINT "noe_record_rejection_codes_chk"
      CHECK ("rejection_codes" IS NULL OR cardinality("rejection_codes") <= 20);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notr_record_rejection_stage_chk') THEN
    ALTER TABLE "notr_record" ADD CONSTRAINT "notr_record_rejection_stage_chk"
      CHECK ("rejection_stage" IS NULL OR "rejection_stage" IN ('999', '277ca'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notr_record_rejection_codes_chk') THEN
    ALTER TABLE "notr_record" ADD CONSTRAINT "notr_record_rejection_codes_chk"
      CHECK ("rejection_codes" IS NULL OR cardinality("rejection_codes") <= 20);
  END IF;
END $$;
