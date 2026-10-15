-- M25 appeal deadlines (hospice ADR/TPE/QIC PRD, milestone 1). One nullable column, no new table or enum:
-- the date printed on the notice an appeal tier's clock runs from. appeal_case.tier_deadline_at is now derived
-- from it (receipt presumed 5 calendar days after the notice date, last filing day usable to its end), so the
-- UI can show how a deadline was reached. NULL on existing rows; their stored deadline is not recomputed.
-- Table-level grants (0083) already cover the new column; the audit trigger serializes the whole row.

ALTER TABLE "appeal_case" ADD COLUMN "notice_dated_on" date;
