-- device_attestation's RLS policy cast `current_setting('app.org_id', true)::uuid` without a
-- NULLIF guard. `createDbSessionContextStore` LEFT JOINs this table from the session lookup that
-- runs on every authenticated request, BEFORE org context is known — so it deliberately runs on
-- the bare pool, not inside withOrgContext. On a freshly-checked-out pooled connection that has
-- never touched the GUC, current_setting returns NULL and the predicate is `= NULL` (no match,
-- correct: the LEFT JOIN side resolves null). On a connection REUSED after an earlier, unrelated
-- withOrgContext transaction committed on it, Postgres reverts a touched custom GUC to the empty
-- string rather than back to NULL — so the same cast throws 22P02 "invalid input syntax for type
-- uuid: ''" and /api/v1/auth/context 500s for a real, valid session, nondeterministically, on
-- whichever physical connection the pool happens to hand back. NULLIF folds both cases to the same
-- safe outcome: no match, not a crash — matching the LEFT JOIN's own designed "no attestation"
-- degrade path (a session with no device resolves fine).
DROP POLICY IF EXISTS "device_attestation_org" ON "device_attestation";--> statement-breakpoint
CREATE POLICY "device_attestation_org" ON "device_attestation"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
