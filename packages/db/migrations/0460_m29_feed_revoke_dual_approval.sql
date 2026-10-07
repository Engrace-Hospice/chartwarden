-- GAP-153 — M29 feed-revoke dual approval (D20) held server-side.
--
-- The revoke route used to trust an optional `primaryApproverId` from the request body, and the store ignored
-- it: a single actor could revoke alone. The first approver's request is now STORED on the feed; a revoke only
-- completes when a DIFFERENT membership approves, and then cascades the feed's credentials to `retired`.
-- Additive, nullable; the existing table-level grants, FORCEd RLS policy and audit trigger cover the columns.
ALTER TABLE "external_feed" ADD COLUMN IF NOT EXISTS "revoke_requested_by_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "external_feed" ADD COLUMN IF NOT EXISTS "revoke_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "external_feed" ADD COLUMN IF NOT EXISTS "revoke_reason" text;
