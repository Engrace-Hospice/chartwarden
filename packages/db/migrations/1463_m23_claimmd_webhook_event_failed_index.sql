-- compat: expand
-- M23 (ADR-0053 amendment D7) - serve the Claim.MD sweep's "recently failed receipts" count. Alerts for a receipt that went terminal
-- `failed` are raised once, after the sweep's transaction commits, so if the process dies between the commit and the alert the row is
-- terminal and never re-selected. The sweep therefore also counts, every minute, the rows that went `failed` in the last 24 hours and
-- warns with the count and the oldest time (counts and timestamps only), so ops sees them even when an alert was lost. Nothing indexed
-- `processing_outcome = 'failed'` by time: this partial index holds only the (rare) failed rows, ordered by processed_at, so that count
-- is a range scan of the last day's failures and not a walk of a table that only grows.
CREATE INDEX IF NOT EXISTS "claimmd_webhook_event_failed_ix"
  ON "claimmd_webhook_event" ("processed_at") WHERE "processing_outcome" = 'failed';
