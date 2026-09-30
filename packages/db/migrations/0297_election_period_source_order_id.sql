-- F-223 (#248) — `m11.order.recertification_signed` → M6 opens the next PENDING election period.
-- `source_order_id` materializes the triggering M11 `order_record.id` as a LOGICAL reference (M6's
-- dependsOn excludes 11, so no SQL FK; same posture as migration 0250's level_of_care_period column).
-- NULL for every period opened through `POST /election-periods` and every pre-existing row.
-- Plain UNIQUE(organization_id, source_order_id): NULLS DISTINCT (migration 0249 / 0250 precedent), so
-- only order-triggered rows are constrained against each other — a redelivery cannot open a second
-- period for the same signed order. Idempotent (IF NOT EXISTS / catalog guard).
ALTER TABLE "election_period"
ADD COLUMN IF NOT EXISTS "source_order_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'election_period_source_order_id_uq'
  ) THEN
    ALTER TABLE "election_period"
    ADD CONSTRAINT "election_period_source_order_id_uq" UNIQUE ("organization_id", "source_order_id");
  END IF;
END $$;
