-- M30 mortality review — catalogue `mortality.read_with_patient` in the `permission` mirror.
--
-- The key was added to @chartwarden/auth (M30 D19: patient display name + MRN suffix on R-70/R-71, only for callers who
-- hold it) but the `permission` mirror is a foreign-key target for `role_permission.permission_key`, and nothing in
-- the deploy path syncs it: `db:sync:permissions` is a local-dev script. Without this row an administrator cannot
-- grant the key (the INSERT into `role_permission` fails the FK), so the patient name could never be switched on.
--
-- This inserts the mirror row only. It grants the key to NO role: role grants are per-tenant data, and the screen
-- stays id-only until a tenant grants it. Idempotent (`ON CONFLICT DO NOTHING`), the 0316 precedent. The row mirrors
-- the `mortality.read` row (resource `mortality_review`, category `quality`, ABAC `inOrg`).
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('mortality.read_with_patient', 'mortality_review', 'read_with_patient', 'quality', 'inOrg', '')
ON CONFLICT ("key") DO NOTHING;
