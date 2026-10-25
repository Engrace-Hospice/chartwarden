-- M23 clearinghouse transport (ADR-0053 amendment 2026-10-25, issue #750): the port gained the `transfer_notice` submission
-- kind (8xC / 8xD), so the attempt record must accept it. Widens the kind CHECK from 1067; no row changes. Idempotent.
ALTER TABLE "clearinghouse_submission_attempt" DROP CONSTRAINT IF EXISTS "clearinghouse_submission_attempt_kind_chk";--> statement-breakpoint
ALTER TABLE "clearinghouse_submission_attempt" ADD CONSTRAINT "clearinghouse_submission_attempt_kind_chk"
	CHECK ("kind" IN ('claim', 'noe', 'notr', 'transfer_notice'));
