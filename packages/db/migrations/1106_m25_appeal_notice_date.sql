-- M25 appeal deadlines (hospice ADR/TPE/QIC PRD, milestone 1). One nullable column, no new table or enum:
-- the date printed on the notice an appeal tier's clock runs from. appeal_case.tier_deadline_at is now derived
-- from it (receipt presumed 5 calendar days after the notice date, last filing day usable to its end), so the
-- UI can show how a deadline was reached. NULL on existing rows; their stored deadline is not recomputed.
-- Table-level grants (0083) already cover the new column; the audit trigger serializes the whole row.

-- IF NOT EXISTS: this file shipped first as 1105_m25_appeal_notice_date.sql (applied to production), then was renumbered
-- to 1106 (#458) when it collided with the m36 1105. The migrator reads the renamed file as new, so on a database that
-- already has the column it must be a no-op, not a "column already exists" failure that rolls the deploy back.
ALTER TABLE "appeal_case" ADD COLUMN IF NOT EXISTS "notice_dated_on" date;
