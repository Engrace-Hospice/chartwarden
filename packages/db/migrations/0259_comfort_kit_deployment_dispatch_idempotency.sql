-- F-166 (#248) m13 `handlers-unbound` group — M13's own `comfort_kit_deployment` row had NO idempotency
-- key at all: `m21.comfort_kit.deployed_at_patient` was a declared-but-unbound consumer pair with no live
-- binding, so nothing had ever inserted into this table, and no redelivery guard was ever needed to exist.
-- Binding a real consumer needs one — a genuine redelivery of the same catalogued event (the dispatcher
-- retries a thrown handler up to maxAttempts=8) must not open a second `comfort_kit_deployment` for the
-- same M21 dispatch.
--
-- Plain UNIQUE on `(organization_id, m21_supply_dispatch_id)`, no partial WHERE clause needed — Postgres
-- treats every NULL as distinct from every other NULL by default (NULLS DISTINCT, migration 0250's
-- `level_of_care_period_source_order_id_uq` precedent), so any number of NULL-keyed rows (there should be
-- none once the consumer is the table's only writer, but the column itself stays nullable) coexist freely
-- and only the dispatch-linked rows are ever constrained against each other.
ALTER TABLE "comfort_kit_deployment"
ADD CONSTRAINT "comfort_kit_deployment_m21_dispatch_uq" UNIQUE ("organization_id", "m21_supply_dispatch_id");
