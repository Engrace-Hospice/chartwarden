-- compat: expand
-- M12 - two indexes for the "queued orders are stale" age alert (review of slice 4, M4).
--
-- `runQueuedAgeAlertForOrg` runs once per organization per tick. It asks: is there an order that is still
-- `queued_for_transmission` / `queued` whose transmission row was queued before the cutoff? Until now the only
-- indexes were `mot_idempotency_unique (organization_id, idempotency_key)` and the in-flight partial index on
-- the transmission table, so the join from an order to its transmission row had no index to probe, and the
-- order side had no index on its queued state (the partial `medication_order_prescriber_pending_idx` covers
-- the pre-signature states only). On a tenant with a long order history that is a scan per tick.
--
--   medication_order_transmission (organization_id, medication_order_id, queued_at)
--       the EXISTS probe: for one queued order, is there a transmission row older than the cutoff. It also
--       serves every other lookup of "the transmission rows of this order" (the settle and retry paths).
--   medication_order (organization_id, id) WHERE status = 'queued_for_transmission' AND dosespot_send_state = 'queued'
--       the queued set itself. Partial, so it holds only the handful of orders waiting to go out and stays
--       tiny however large the table grows; an order leaves it the moment it is sent or fails.
--
-- `medication_order` is PARTITION BY RANGE (created_at): CREATE INDEX on the partitioned parent creates the
-- matching index on every partition (the 0385 precedent), and a partial predicate is allowed there. Both
-- statements are idempotent (IF NOT EXISTS). Expand-only: an index changes no data and no contract.
-- At scale: a plain CREATE INDEX takes a lock that BLOCKS WRITES to the table while it builds (and the runner wraps a migration in a transaction,
-- where CREATE INDEX CONCURRENTLY is not allowed). Both tables are small at launch; on a large tenant base build these two indexes with
-- CREATE INDEX CONCURRENTLY outside the migration transaction first (one per partition, then attach, for the partitioned `medication_order`),
-- and let this migration's IF NOT EXISTS find them already there.
CREATE INDEX IF NOT EXISTS "mot_order_idx"
  ON "medication_order_transmission" ("organization_id", "medication_order_id", "queued_at");

CREATE INDEX IF NOT EXISTS "medication_order_queued_idx"
  ON "medication_order" ("organization_id", "id")
  WHERE status = 'queued_for_transmission' AND dosespot_send_state = 'queued';
