-- compat: expand
-- ADR-0109 D5 - the two pre-death-draft permission keys, mirrored into the DB catalog (the 1253 / 1306 shape). They are granted to roles
-- by tenants (role_permission), not here: only the catalog rows are needed. `default_abac` names the predicate that gates the key.
-- Idempotent.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('bereavement.assessment_draft.read', 'bereavement_risk_assessment_draft', 'read', 'clinical', 'bereavement_pre_death_assessor', ''),
  ('bereavement.assessment_draft.write', 'bereavement_risk_assessment_draft', 'write', 'clinical', 'bereavement_pre_death_assessor', '')
ON CONFLICT ("key") DO NOTHING;
