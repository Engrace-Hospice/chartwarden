-- 0158 — phase1/residual-gaps (M12 drug-cost basis): `medication_order` gains its acquisition-cost
-- column so the §2.10 D17 cost rollup (`costBasisForAdmissionMonth` → M27 Worksheet S-7) has a real
-- fact to aggregate instead of refusing on a structural schema gap. NULLABLE by design: NULL means
-- "not priced" — the honest state of every pre-existing row (there is no drug-cost feed yet; the
-- future DoseSpot fill/NDC pricing feed populates it at dispense time). Aggregates MUST NOT treat
-- NULL as $0: the seam keeps refusing (typed DoseSpotSeamGapError, now carrying priced/unpriced
-- counts) whenever ANY in-scope line is unpriced, so Worksheet S-7 never ingests a fabricated $0
-- drug spend. No backfill is possible or attempted — a backfilled 0 would be exactly the fabrication
-- this column exists to prevent.
--
-- `medication_order` is PARTITION BY RANGE (created_at) (0039): ALTER TABLE on the partitioned
-- parent propagates both the column and the CHECK to every existing partition (the DEFAULT partition
-- + the monthly ranges) and to every future partition automatically.
--
-- Forward-only (never edit an applied migration). Idempotent guards so a replay is safe.

ALTER TABLE medication_order
  ADD COLUMN IF NOT EXISTS acquisition_cost_cents integer;

COMMENT ON COLUMN medication_order.acquisition_cost_cents IS
  'Drug acquisition cost in integer CENTS (the repo money rule — never fractional dollars). NULL = not priced (the honest default until the DoseSpot fill/NDC pricing feed lands); a real free/$0 line is an explicit 0, never NULL. Aggregates must refuse unpriced lines, not zero-fill them — M27 Worksheet S-7 reads this through the M12 cost-basis seam.';

-- Guarded CHECK: ADD CONSTRAINT has no IF NOT EXISTS, so probe pg_constraint first (the repo's
-- DO $$ existence-guard pattern — 0015/0019/0023/0156).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'medication_order_acquisition_cost_nonneg_chk'
      AND conrelid = 'medication_order'::regclass
  ) THEN
    ALTER TABLE medication_order
      ADD CONSTRAINT medication_order_acquisition_cost_nonneg_chk
      CHECK (acquisition_cost_cents IS NULL OR acquisition_cost_cents >= 0);
  END IF;
END $$;
