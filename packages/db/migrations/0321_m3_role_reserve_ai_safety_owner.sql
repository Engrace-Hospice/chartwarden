-- GAP-096 — `ai_safety_owner` is platform authority too.
--
-- M32's safety-owner predicates (kill switch at platform scope, lifecycle sign-off) read the role KEY
-- `ai_safety_owner`, so a tenant row with that key would have satisfied them exactly as a tenant
-- `platform_admin` did before 0318. The code-side rule (`RESERVED_PLATFORM_ROLE_KEYS` in
-- packages/auth/src/roles/platform-reserved.ts) already refuses and ignores it; this widens 0318's
-- backstop to match. NOT VALID for the same reason as 0318: pre-existing rows are ignored by the reader,
-- and every INSERT/UPDATE from here on is checked.
ALTER TABLE "role" DROP CONSTRAINT IF EXISTS "role_platform_authority_platform_owned";
ALTER TABLE "role" ADD CONSTRAINT "role_platform_authority_platform_owned"
  CHECK ("organization_id" IS NULL
    OR ("key" NOT LIKE 'platform\_%' AND "key" <> 'ai_safety_owner'
        AND "category" <> 'platform_staff')) NOT VALID;
