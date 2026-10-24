-- GAP-178 follow-up: 1200 created message_ack_broadcast_recipient with a composite FK
-- (organization_id, broadcast_id) -> message_ack_broadcast ON DELETE CASCADE, but its only covering key is
-- UNIQUE (broadcast_id, user_id), which does not LEAD with organization_id, so the cascade/parent-delete scan
-- had no index to seek on (caught by test:fk-indexes:live). Additive and idempotent; no data change.
CREATE INDEX IF NOT EXISTS "message_ack_broadcast_recipient_broadcast_fk_idx"
  ON "message_ack_broadcast_recipient" ("organization_id", "broadcast_id");
