-- compat: expand
-- M23 (ADR-0053 amendment D7) - support the Claim.MD receipt sweep's retention clear. Since the retention rule changed to "clear the
-- cipher of ANY receipt older than 90 days from received_at, processed or not" the sweep runs, every minute,
--   UPDATE claimmd_webhook_event SET payload_cipher = NULL, ... WHERE payload_cipher IS NOT NULL AND received_at < <cutoff>
-- and nothing served it: claimmd_webhook_event_pending_ix covers only processed_at IS NULL and claimmd_webhook_event_retention_ix is
-- keyed on processed_at, so each run walked the whole table, which only grows (rows are never deleted; the digest and ids stay as
-- evidence). This partial index holds only the rows that still carry a cipher (at most the retention window's worth of receipts)
-- ordered by received_at, so the clear is a range scan over exactly the rows it is about to change; a cleared row leaves the index.
-- Platform-only table, so there is no organization_id to lead with (arch:org-indexes covers org-scoped tables).
CREATE INDEX IF NOT EXISTS "claimmd_webhook_event_cipher_age_ix"
  ON "claimmd_webhook_event" ("received_at") WHERE "payload_cipher" IS NOT NULL;
