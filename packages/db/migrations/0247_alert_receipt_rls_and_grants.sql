-- alert_receipt (migration 0243) was created with no GRANT and no RLS at all — `wardenx_app` has
-- zero privileges on it. Every real request that touches it (the alert-inbox left-join in
-- `listAlertInbox`, the INSERT in `markAlertRead`) 500s with 42501 "permission denied for table
-- alert_receipt", live in production since 0243 merged. `notification_delivery` is the exact
-- sibling — also a pure child of `alert` (ON DELETE CASCADE, no organization_id of its own) — and
-- has carried the correct shape since migration 0017: parent-join RLS + a `wardenx_app` grant.
-- Mirrored here, with the NULLIF empty-string guard 0246 added for `device_attestation`: this
-- table is only ever touched inside `withOrgContext` today (unlike device_attestation's bare-pool
-- LEFT JOIN), but the guard is free insurance against the identical failure mode — a pooled
-- connection reused after a prior withOrgContext transaction reverts the custom GUC to '', not
-- NULL, and an unguarded cast throws 22P02 instead of correctly matching nothing.
ALTER TABLE "alert_receipt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alert_receipt" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "alert_receipt_via_alert" ON "alert_receipt"
  FOR ALL TO wardenx_app
  USING (alert_id IN (
    SELECT id FROM alert
    WHERE organization_id = nullif(current_setting('app.org_id', true), '')::uuid
  ));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "alert_receipt" TO wardenx_app;--> statement-breakpoint

-- Destruction role: `deleteStructuralRows()` deletes `alert` directly and relies on ON DELETE
-- CASCADE for alert_receipt, so this grant/policy isn't load-bearing for offboarding today the way
-- it is for notification_delivery (which the eraser deletes explicitly, pre-cascade, to get an
-- accurate per-table count). Added anyway for parity with the 0157 sibling policy and because the
-- eraseFn.ts docstring already lists "receipts" among the structural rows it accounts for.
CREATE POLICY "alert_receipt_destruction" ON "alert_receipt"
  FOR ALL TO wardenx_destruction
  USING (alert_id IN (
    SELECT id FROM alert
    WHERE organization_id = current_setting('app.org_id', true)::uuid
  ));--> statement-breakpoint

GRANT SELECT, DELETE ON "alert_receipt" TO wardenx_destruction;
