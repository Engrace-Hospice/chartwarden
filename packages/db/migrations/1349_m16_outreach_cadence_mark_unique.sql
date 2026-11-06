-- compat: contract
-- ADR-0109 D4 review follow-up - M16: a contact holds each cadence-floor mark at most once. `heldCadenceMarks` already treats a row as
-- holding its mark in every status except `cancelled`; this is the database half of that rule, so two concurrent forward fills (a tier-change
-- top-up racing a regenerate or a resume) cannot both insert the same floor item and give the family a duplicate call or letter. NULL marks
-- (ad-hoc touchpoints and rows from before 1341) are outside the index. CONTRACT (a unique index: a release that wrote a duplicate would now
-- fail), so the previous release is not auto-restored over it.
CREATE UNIQUE INDEX "berv_outreach_contact_mark_uniq" ON "bereavement_outreach" ("bereaved_contact_id", "cadence_mark")
  WHERE "cadence_mark" IS NOT NULL AND "status" <> 'cancelled';
