-- 0156 — TASK-002 follow-up (M11 schema-gap closure): `order_discontinuation` gains its target
-- discriminator. The §2.8 D14 OrderSignatureProvider write surface is POLYMORPHIC (`order` |
-- `medication_order` targets — `order_signature` and `verbal_order` already carry `target_kind`), but
-- this ledger had only `order_record_id`, so the seam's insertDiscontinuation REFUSED
-- `medication_order` targets rather than mis-file an M12 medication-order uuid as an M11 order id.
-- `target_kind` disambiguates: under 'medication_order' the `order_record_id` column holds the M12
-- medication_order uuid (an app-side logical ref — M12 owns that lifecycle; no cross-module FK, and
-- order_record is partitioned so the 'order' arm never had a SQL FK either). Backfill: every
-- pre-existing row was written by the M11 route/cascade paths against a real order_record, so
-- DEFAULT 'order' is the truthful backfill, and the column can be NOT NULL from birth.
--
-- Forward-only (never edit an applied migration). Idempotent guards so a replay is safe.

ALTER TABLE order_discontinuation
  ADD COLUMN IF NOT EXISTS target_kind text NOT NULL DEFAULT 'order';

COMMENT ON COLUMN order_discontinuation.target_kind IS
  'Discriminates what order_record_id refers to: ''order'' = M11 order_record uuid; ''medication_order'' = M12 medication_order uuid (app-side logical ref — M12 owns that lifecycle). Pre-0156 rows were all M11 route/cascade writes, hence the ''order'' default backfill.';

-- Guarded CHECK: ADD CONSTRAINT has no IF NOT EXISTS, so probe pg_constraint first (the repo's
-- DO $$ existence-guard pattern — 0015/0019/0023).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'order_discontinuation_target_kind_chk'
      AND conrelid = 'order_discontinuation'::regclass
  ) THEN
    ALTER TABLE order_discontinuation
      ADD CONSTRAINT order_discontinuation_target_kind_chk
      CHECK (target_kind IN ('order', 'medication_order'));
  END IF;
END $$;
