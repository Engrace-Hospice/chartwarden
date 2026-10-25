-- expedited_deadline.admission_id -> admission (ON DELETE RESTRICT): 1230 only indexed (organization_id, admission_id), which does
-- not lead with admission_id, so a parent-row delete/update of `admission` scans the whole table. `admission` is hard-deletable
-- (not a soft-deleted siting/actor parent), so the fk-index-coverage rule (GAP-178) requires a leading index.
CREATE INDEX IF NOT EXISTS "expedited_deadline_admission_id_idx" ON "expedited_deadline" ("admission_id");
