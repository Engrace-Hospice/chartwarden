-- M36 alert emitter idempotency for HOPE Phase 3 threshold transitions.
--
-- `correlation_id` is the documented fan-out idempotency key. Scope it per organization so
-- independently emitted tenant alerts can share semantic source ids without colliding globally.
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alert_org_correlation_unique"
  ON "alert" ("organization_id", "correlation_id");
