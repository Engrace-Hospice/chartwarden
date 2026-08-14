-- 0212 — ADR-0001: the RHC two-tier boundary is day 60, not day 7. The `hipps_calculation`
-- day-count columns encoded the wrong regulation ("first 7 days" conflated RHC tiering with the
-- unrelated SIA last-7-days window). Rename them to the day-60 model the calculator now computes.
-- Data note: the BillingReferenceDataReader seam has been unbound in every production boot
-- (boot-assembly.ts deny-stub), so no persisted row ever carried real tier counts; a plain rename
-- is sufficient — no backfill.
ALTER TABLE "hipps_calculation" RENAME COLUMN "rhc_days_1_to_7" TO "rhc_days_1_to_60";--> statement-breakpoint
ALTER TABLE "hipps_calculation" RENAME COLUMN "rhc_days_8_plus" TO "rhc_days_61_plus";
