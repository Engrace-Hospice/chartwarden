-- compat: expand
-- Preserve the distinct dates carried by an 835. Existing production_date values are intentionally
-- not copied: their original source (BPR16 vs DTM*405 fallback) cannot be proven from stored rows.
ALTER TABLE remittance_advice
  ADD COLUMN payment_effective_date date,
  ADD COLUMN adjudication_cutoff_date date,
  ADD COLUMN functional_group_creation_date date;

ALTER TABLE remittance_advice ALTER COLUMN production_date DROP NOT NULL;
