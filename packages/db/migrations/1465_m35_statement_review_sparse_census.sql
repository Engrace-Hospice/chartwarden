-- compat: contract
-- M35 (slice 2) - a closed month billed on a sparse census is recorded for review (`sparse_census`), beside `no_census`.
-- The ADC is the mean of the days a census was OBSERVED, so a sweep that was down for most of a month still bills, on a mean of the few
-- days it saw, and a final statement is frozen (1412): there is no correction path after it closes. The statement run now records such
-- a month once, in the platform-only review table the `no_census` months already use, when it finalizes the month (statement-plan.ts:
-- MIN_CENSUS_COVERAGE_PERCENT). That needs the table's reason CHECK to accept the new code.
-- Declared `contract` only because a CHECK cannot be widened in place (it is dropped and re-added, which the compat gate reads as
-- contracting DDL); the previous release writes only `no_census`, which still passes. No row is touched.
ALTER TABLE "subscription_statement_review" DROP CONSTRAINT IF EXISTS "subscription_statement_review_reason_ck";--> statement-breakpoint
ALTER TABLE "subscription_statement_review" ADD CONSTRAINT "subscription_statement_review_reason_ck" CHECK ("reason" IN ('no_census', 'sparse_census'));
