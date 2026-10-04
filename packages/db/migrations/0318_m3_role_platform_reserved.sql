-- GAP-003 — platform authority is never tenant-mintable.
--
-- Platform predicates (M22/M26/M29/M34/M35) decide on a role KEY. POST /api/v1/roles accepted any
-- `^[a-z0-9_]+$` key and the `platform_staff` category, and `role_org_key_idx` is (organization_id, key),
-- so a tenant row named `platform_admin` collided with nothing and satisfied every platform predicate.
-- The route now refuses it (422 RESERVED_ROLE) and the enrichment reader drops platform keys carried by
-- tenant-owned rows; this CHECK is the backstop for every other writer (seeds, admin SQL, future code).
--
-- A `platform_*` key or the `platform_staff` category is reserved to platform-owned rows
-- (organization_id IS NULL). NOT VALID: rows written before this migration are exempt from the scan —
-- the reader already ignores them — while every INSERT and UPDATE after it is checked.
ALTER TABLE "role" ADD CONSTRAINT "role_platform_authority_platform_owned"
  CHECK ("organization_id" IS NULL
    OR ("key" NOT LIKE 'platform\_%' AND "category" <> 'platform_staff')) NOT VALID;
