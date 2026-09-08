-- M10 HOPE modernization Phase 2B: optimistic lock backing for canonical answer patches.
-- `hope_assessment` is partitioned by target_date; adding a scalar column to the parent propagates to
-- partitions without changing the composite PK or creating invalid child FKs.
ALTER TABLE hope_assessment
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
