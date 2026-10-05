-- GAP-003 follow-up — one platform-owned role per key.
--
-- `role_org_key_idx` is (organization_id, key) with NULLs distinct, so it never constrained the
-- platform rows (organization_id IS NULL: the default-role templates and the platform_* roles). Two
-- writers finding no `platform_admin` at the same moment could each insert one, and a key's authority
-- would then depend on which row a membership happened to bind. This partial index closes that, and
-- lets a platform-role writer upsert with ON CONFLICT instead of a racy find-or-create.
CREATE UNIQUE INDEX IF NOT EXISTS "role_platform_key_idx" ON "role" ("key")
  WHERE "organization_id" IS NULL;
