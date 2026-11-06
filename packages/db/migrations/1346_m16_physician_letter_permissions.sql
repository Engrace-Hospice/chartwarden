-- compat: expand
-- ADR-0109 D6 - the two physician-letter permission keys, mirrored into the DB catalog (the 1344 / 1306 shape). They are granted to roles by
-- tenants (role_permission), not here: only the catalog rows are needed. `default_abac` names the predicate that gates both keys: the
-- review queue is bereavement oversight only. Idempotent.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('bereavement.letter.read', 'bereavement_physician_letter', 'read', 'clinical', 'org_scope_bereavement_oversight', ''),
  ('bereavement.letter.review', 'bereavement_physician_letter', 'review', 'clinical', 'org_scope_bereavement_oversight', '')
ON CONFLICT ("key") DO NOTHING;
