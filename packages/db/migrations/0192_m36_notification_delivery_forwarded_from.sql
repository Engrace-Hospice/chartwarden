-- GAP-096 — M36 §2.6/§7.6 vacation forwarding. `notification_delivery` had no column to record which
-- original recipient a forwarded (backup) delivery row came from, even though the fan-out planner's own
-- output shape (PlannedDelivery.forwardedFromUserId, packages/messaging/src/resolution/fan-out.ts) has
-- carried this field since M36-T04 — the real AlertEmitterPorts.persist adapter this migration unblocks
-- could not have represented a forwarded delivery without silently dropping it.
ALTER TABLE "notification_delivery" ADD COLUMN IF NOT EXISTS "forwarded_from_user_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_forwarded_from_user_id_user_id_fk"
  FOREIGN KEY ("forwarded_from_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
