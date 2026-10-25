-- M23 (ADR-0103 amendment 2, issue #760 follow-up) -- a durable "possibly sent" marker for a provider send.
--
--   1. dde_work_item.provider_in_doubt_at is set in its own short transaction BEFORE the vendor call and cleared once the
--      outcome is applied (accepted receipt, or a refusal that provably never reached FISS). A timeout, a crash, a
--      DDE_IN_DOUBT answer or an unusable receipt leaves it set: no operator may then send the item through the provider
--      again, and a manual record-submission (which clears it) is the way out.
--   2. dde_work_item.provider_operator_membership_id is the membership whose DDE ID keyed the operation. Provider calls
--      about the operation (status inquiry) are made as that person, because DDE IDs are per individual (ADR-0103 D4).
--      Rows submitted before this migration carry NULL; sync falls back to the syncing operator for them.
--   3. dde_work_event learns the three events that record the send lifecycle.
-- Additive and idempotent. RLS (ENABLED + FORCEd), the audit trigger and the no-DELETE grant of dde_work_item are
-- unchanged (migration 1060); the new columns are covered by the same row-level policies and trigger.

ALTER TABLE "dde_work_item" ADD COLUMN IF NOT EXISTS "provider_in_doubt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dde_work_item" ADD COLUMN IF NOT EXISTS "provider_operator_membership_id" uuid;--> statement-breakpoint

ALTER TABLE "dde_work_item" DROP CONSTRAINT IF EXISTS "dde_work_item_in_doubt_chk";--> statement-breakpoint
ALTER TABLE "dde_work_item" ADD CONSTRAINT "dde_work_item_in_doubt_chk" CHECK (
	-- A marker names who keyed the possibly-sent operation.
	"provider_in_doubt_at" IS NULL OR "provider_operator_membership_id" IS NOT NULL
);--> statement-breakpoint

ALTER TABLE "dde_work_event" DROP CONSTRAINT IF EXISTS "dde_work_event_event_chk";--> statement-breakpoint
ALTER TABLE "dde_work_event" ADD CONSTRAINT "dde_work_event_event_chk" CHECK ("event" IN
	('create', 'assign', 'unassign', 'reassign', 'start', 'submit', 'accept', 'return', 'retry', 'close', 'cancel',
	 'provider_send_started', 'provider_send_refused', 'provider_in_doubt'));
