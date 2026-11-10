-- compat: contract
-- M25 - fix payer_appeal_vendor_report_reason_chk (migration 1324). Migration 1324 wrote the check as
--     disposition IN ('opened','linked') AND reason IS NULL  OR  disposition IN ('timeline','recorded_only')
-- which SQL parses as (A AND B) OR C, so it never constrained a `timeline` or `recorded_only` row's reason: a `timeline`
-- report could carry a reason and a `recorded_only` report ("no case could be chosen: `reason` says why") could omit it.
-- The intent, and what m23-appeal-reported.ts has always written, is: a report that bound or touched a case carries no
-- reason; a `recorded_only` report always carries one. 1324 is applied and stays byte-identical; this replaces the
-- constraint. It is `contract` because it tightens what a write may carry (an old writer that set a reason on a `timeline`
-- report, or none on a `recorded_only` one, would now be refused); the only writer, the M25 consumer, already complies, and
-- the table is append-only for the app role, so no existing row can violate it. Added NOT VALID then validated, so the
-- validation scan holds only a SHARE UPDATE EXCLUSIVE lock rather than blocking the consumer's inserts.
ALTER TABLE "payer_appeal_vendor_report" DROP CONSTRAINT IF EXISTS "payer_appeal_vendor_report_reason_chk";--> statement-breakpoint
ALTER TABLE "payer_appeal_vendor_report" ADD CONSTRAINT "payer_appeal_vendor_report_reason_chk" CHECK (
  ("disposition" IN ('opened','linked','timeline') AND "reason" IS NULL)
  OR ("disposition" = 'recorded_only' AND "reason" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "payer_appeal_vendor_report" VALIDATE CONSTRAINT "payer_appeal_vendor_report_reason_chk";
