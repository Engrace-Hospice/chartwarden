-- M36 `alert.outcome` — default `pending`, and correct the rows written under the old default
-- (F-109 / #103, second half of 0240).
--
-- THE DEFAULT. An alert is `pending` the moment it is written; what it settles on is computed from its
-- `notification_delivery` children (`rollUpAlertOutcome`, @chartwarden/messaging). The emitter now writes the
-- initial value explicitly — a plan with no rows settles `failed` immediately, which is exactly the case
-- `DEFAULT 'delivered'` was most wrong about (`emit()` writes a no-op alert when no `alert_rule` fires) —
-- so this DEFAULT is the floor for a writer that forgets, not the normal path.
--
-- THE BACKFILL. Every existing row says `delivered`, and the column is a COMPUTED roll-up that has never
-- been computed: no human asserted it and no channel reported it. The guard is what makes the rewrite
-- safe rather than a blanket relabel — a row is moved to `pending` only when NOT ONE of its deliveries
-- has reached a §2.4.4 terminal state, which is the definition of "nothing has settled". Today that
-- matches every row (nothing has ever written a delivery status), and re-running this after a settlement
-- path exists would correctly skip the rows that genuinely settled. An alert with NO deliveries is left
-- alone here on purpose: `failed` is its true outcome and this migration is not the thing that decides
-- it — the roll-up is, on the next emit — and silently marking historical no-op alerts `failed` would
-- manufacture a fleet of alerts that look actioned-and-failed rather than never-routed.
ALTER TABLE "alert" ALTER COLUMN "outcome" SET DEFAULT 'pending';--> statement-breakpoint

UPDATE "alert" a
   SET "outcome" = 'pending'
 WHERE a."outcome" = 'delivered'
   AND EXISTS (SELECT 1 FROM "notification_delivery" d WHERE d."alert_id" = a."id")
   AND NOT EXISTS (
         SELECT 1 FROM "notification_delivery" d
          WHERE d."alert_id" = a."id"
            AND d."status" IN ('delivered', 'failed', 'skipped_quiet_hours', 'forwarded')
       );
