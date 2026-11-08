-- compat: expand
-- ADR-0109 D10 - the three mailing permission keys, mirrored into the DB catalog (the 1346 / 1344 shape). They are granted to roles by tenants
-- (role_permission), not here: only the catalog rows are needed. `default_abac` names the predicate that gates all three: the batch PDF holds every
-- recipient's address, so the mailing surface is bereavement oversight only. Idempotent.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('bereavement.mailing.read', 'bereavement_mailing_run', 'read', 'clinical', 'org_scope_bereavement_oversight', ''),
  ('bereavement.mailing.manage', 'bereavement_mailing_run', 'manage', 'clinical', 'org_scope_bereavement_oversight', ''),
  ('bereavement.mailing.dispatch', 'bereavement_mailing_run', 'dispatch', 'clinical', 'org_scope_bereavement_oversight', '')
ON CONFLICT ("key") DO NOTHING;
