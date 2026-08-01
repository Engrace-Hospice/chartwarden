-- M4 Audit §3.6 — `wardenx_app` may APPEND an audit row scoped to its own org.
--
-- WITHOUT THIS, EVERY APPLICATION-LEVEL AUDIT WRITE FAILS IN PRODUCTION. Proven against a live
-- cluster with the runtime role set NOBYPASSRLS (the production posture the boot guard enforces):
--
--     SET ROLE wardenx_app; SET app.org_id = '…';
--     INSERT INTO audit_event (…) VALUES (…);
--     ERROR:  new row violates row-level security policy for table "audit_event"
--
-- `wardenx_app` held the INSERT *grant* but no INSERT *policy*: the only one was
-- `audit_writer_insert FOR INSERT TO wardenx_audit_writer` (0012/0013). That covers the TRIGGER path,
-- which is SECURITY DEFINER and therefore runs as the function owner — so table writes were audited
-- fine and the gap stayed invisible. What was NOT covered is the path `audit()` actually takes:
-- `packages/audit/src/audit.ts` does a plain `tx.insert(auditEvents).values(row)` on the CALLER's
-- transaction, which in the app is `wardenx_app`. Everything on that path was silently failing:
--
--   * the PHI read-audit emission (bootstrap/plugins/read-audit.ts) — and it swallows the error by
--     design ("a read-audit write failure is logged, never fatal"), so §164.528 accounting would have
--     been quietly empty in production while every gate stayed green;
--   * M3's `m3.breakglass.access` per-access row — the `critical` audit that is the ONLY compensating
--     control on an emergency-access bypass;
--   * M2's identity/step-up events.
--
-- It was invisible locally because scripts/db/migrate.ts grants the dev role BYPASSRLS.
--
-- SHAPE OF THE GRANT. Append-only and org-scoped:
--   * FOR INSERT only. `wardenx_app` is granted just INSERT + SELECT on audit_event (no UPDATE, no
--     DELETE), so the ledger stays immutable from the application even with this policy.
--   * WITH CHECK pins `organization_id` to the connection's `app.org_id`, so a tenant connection can
--     append rows for ITSELF and no one else — the same predicate as the existing read policy.
--   * A NULL `organization_id` is NOT admitted (the comparison is null-safe by being a plain `=`,
--     which yields NULL → not true → refused). Platform-scoped audit rows have no single org and must
--     continue to go through the M34 bypass auditor under withPlatformContext, not a tenant session.

DROP POLICY IF EXISTS audit_event_org_append ON audit_event;--> statement-breakpoint
CREATE POLICY audit_event_org_append ON audit_event
  FOR INSERT TO wardenx_app
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

COMMENT ON POLICY audit_event_org_append ON audit_event IS
  'Append-only, org-scoped INSERT for the runtime role: the path audit() takes (a plain insert on the caller tx). The SECURITY DEFINER trigger path uses audit_writer_insert instead. Platform-scoped rows (organization_id NULL) are deliberately not admitted here.';
