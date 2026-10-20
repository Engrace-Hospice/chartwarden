-- M18: supporting index for evv_offline_capture_receipt_device_fk (1121). The table's unique index leads with organization_id, so a delete
-- or update of an evv_device row could not use it to find child rows (test:fk-indexes:live, GAP-178). Plain index, no data change.
CREATE INDEX IF NOT EXISTS "evv_offline_capture_receipt_device_idx"
  ON "evv_offline_capture_receipt" ("evv_device_id");
