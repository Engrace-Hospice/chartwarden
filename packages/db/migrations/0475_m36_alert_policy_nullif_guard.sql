-- `alert` (migration 0016) scopes its two org policies with `current_setting('app.org_id', true)::uuid` and NO
-- NULLIF guard. A connection whose `app.org_id` is the empty string (a pooled connection after RESET, a worker
-- that never set it) therefore THROWS 22P02 ("invalid input syntax for type uuid") instead of matching nothing.
-- It fails closed — no row is returned — but it breaks every query that reaches `alert` through another table's
-- policy: `alert_receipt_via_alert` (0247) looks `alert` up in a subquery, so an unscoped read of alert_receipt
-- errors where its own NULLIF'd policy says it should simply match nothing (found by the GAP-167 live test).
--
-- Same predicate, same roles; only the empty-string case changes (error -> no match). RLS stays ENABLED + FORCEd
-- (0016 / 0157), and the platform/admin reader policies are untouched.
DROP POLICY IF EXISTS "alert_org_isolation" ON "alert";--> statement-breakpoint
CREATE POLICY "alert_org_isolation" ON "alert"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS "alert_destruction" ON "alert";--> statement-breakpoint
CREATE POLICY "alert_destruction" ON "alert"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
