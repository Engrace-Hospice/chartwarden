-- M21 (GAP-063 / D16) — catalogue `supplies.request.invoice_reconcile` in the `permission` mirror and grant it to
-- every role that already holds `supplies.request.mark_ordered`.
--
-- The key gates `POST /supplies/supply-requests/:id/vendor-invoice` (the vendor-invoice reconciliation intake that
-- emits `m21.supply_request.invoice_reconciled` to M27). It lives in @wardenx/auth (M21_CONTRIBUTED_PERMISSIONS);
-- `permission` is the FK target of `role_permission.permission_key` and nothing in the deploy path syncs it
-- (`db:sync:permissions` is local-dev), so without this row no administrator could grant the key (the 0348 lesson).
-- The grant follows the 0382 precedent: whoever a tenant lets record the vendor's order acceptance (and its quoted
-- accrual) may record the vendor's invoice against it; nobody gains an authority they did not already hold over the
-- same supply request. Idempotent (`ON CONFLICT DO NOTHING`); never removes a grant.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('supplies.request.invoice_reconcile', 'supply_request', 'invoice_reconcile', 'clinical', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", 'supplies.request.invoice_reconcile'
  FROM "role_permission" rp
 WHERE rp."permission_key" = 'supplies.request.mark_ordered'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
