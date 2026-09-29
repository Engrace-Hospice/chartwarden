-- F-155 (#248) M6 `handlers-unbound` group — `m11.order.level_of_care_change_signed` needed a
-- redelivery guard before it could bind safely. `changeLoc` (admission-route-service-db.ts) closes the
-- admission's currently-open `level_of_care_period` and inserts a new one with no idempotency key at
-- all: a genuine redelivery of the same catalogued M11 event (the dispatcher retries a thrown handler up
-- to maxAttempts=8) would silently open a second/third LOC period for the same signed order.
--
-- `source_order_id` materializes the triggering M11 `order_record.id` as a LOGICAL reference, not a SQL
-- FK — M6's manifest `dependsOn` is `[1, 5, 38, 39, 40]`, excluding 11, so no cross-module FK crosses the
-- boundary (the same posture as this table's existing `facility_id` (M40) / `ipu_bed_assignment_id`
-- (M37) columns, both "app-validated"/"logical"). Left NULL for every LOC period opened through the
-- ordinary `POST /admissions/:id/level-of-care/change` HTTP route (a clinician action with no M11 order
-- behind it) and for every pre-existing row — only the new order-triggered consumer sets it.
--
-- Plain UNIQUE constraint on `(organization_id, source_order_id)`, no partial WHERE clause needed:
-- Postgres treats every NULL as distinct from every other NULL by default (NULLS DISTINCT — migration
-- 0249's `denial_case_source_idempotency_key_uq` precedent), so any number of NULL-keyed rows coexist
-- freely and only the order-triggered rows are ever constrained against each other.
ALTER TABLE "level_of_care_period"
ADD COLUMN "source_order_id" uuid;

ALTER TABLE "level_of_care_period"
ADD CONSTRAINT "level_of_care_period_source_order_id_uq" UNIQUE ("organization_id", "source_order_id");
