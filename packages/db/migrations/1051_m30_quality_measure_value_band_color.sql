-- 1051 - M30 GAP-049: persist the public band on `quality_measure_value`.
--
-- The row stored numerator / denominator / ratio / threshold_met but not the band, and the recompute worker's
-- `bandOf` rebuilt it as "threshold_met = false => red". A `yellow` value (threshold missed but inside the warn
-- cut) is also threshold_met = false, so a yellow -> red recompute read its PRIOR band as red and never raised the
-- breach, and nothing downstream could tell a still-red series from one that had improved to yellow. The M30
-- repeat sweep ("every 7d until a project is chartered") needs exactly that fact, so the band is now stored.
--
-- Nullable: rows computed before this migration carry no band and keep the old reading (`bandOf` falls back to it).
-- No backfill - a band cannot be recovered from the persisted columns without re-running the calculator.
ALTER TABLE "quality_measure_value" ADD COLUMN IF NOT EXISTS "band_color" text;--> statement-breakpoint
ALTER TABLE "quality_measure_value" DROP CONSTRAINT IF EXISTS "quality_measure_value_band_color_check";--> statement-breakpoint
ALTER TABLE "quality_measure_value"
  ADD CONSTRAINT "quality_measure_value_band_color_check"
  CHECK ("band_color" IS NULL OR "band_color" IN ('green', 'yellow', 'red', 'insufficient_n'));
