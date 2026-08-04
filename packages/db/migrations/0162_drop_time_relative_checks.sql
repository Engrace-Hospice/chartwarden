-- DB-005: drop the two time-relative CHECK constraints. Both used a volatile function (NOW() /
-- CURRENT_DATE) inside a CHECK, which Postgres re-evaluates on EVERY future write to the row using
-- the write-time value of that function, not the value at the time the column was originally set.
-- So a row that was perfectly valid at INSERT time (a future vacation expiry; a forward-dated
-- policy) becomes permanently unwritable once real time simply passes it by — any later UPDATE,
-- even to an unrelated column, re-validates the CHECK against "now" and fails. The same
-- re-validation happens during `pg_restore`'s COPY-time constraint check, so a perfectly valid
-- backup can fail to restore months later purely because time moved on. Both invariants are now
-- enforced at write time in the application layer instead (see
-- apps/backend/src/modules/36-messaging/messaging-route-service-db.ts's `putPreferences` and
-- apps/backend/src/modules/23-billing-medicare/routes/write-service-drizzle.ts's
-- `forwardDateSequestrationPolicy`), which only ever evaluates "is this forward-dated" at the
-- moment of the write, exactly once, never again.
ALTER TABLE "user_notification_preferences" DROP CONSTRAINT IF EXISTS "user_notif_pref_vacation_shape";--> statement-breakpoint
ALTER TABLE "sequestration_policy" DROP CONSTRAINT IF EXISTS "sequestration_policy_forward_only";
