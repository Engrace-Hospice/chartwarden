-- M36 WP 1.6 — read/delivery receipts hygiene. A `message_receipt` is `delivered` (fanned out to the
-- recipient's inbox server-side, NOT device delivery) or `read` (the recipient explicitly read it in the
-- foreground); it is never an acknowledgement. Clinical acknowledgement exists only in the Phase 4
-- message_acknowledgment_* tables (ADR-0056 item 1). No code path ever wrote `ack` or `acked_at`, so this
-- CHECK validates against every existing row. The enum value and the column stay (a Postgres enum value
-- cannot be dropped in place; the column drop and enum rebuild are a later cleanup); this makes them inert.
-- `read` must carry `read_at` (markMessagesRead sets both together).

ALTER TABLE "message_receipt"
  ADD CONSTRAINT "message_receipt_no_ack_check"
  CHECK ("status" <> 'ack' AND "acked_at" IS NULL AND ("status" <> 'read' OR "read_at" IS NOT NULL));
