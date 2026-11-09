-- compat: expand
-- M34 - the onboarding-step catalog is written on the platform carrier, which held only SELECT on onboarding_task_template.
-- POST /api/v1/platform/onboarding-templates (platform ops adding or re-editing a non-canonical step) therefore failed with
-- 42501 on the real platform pool. The inject tests run as a superuser and could not see it.
--
-- The narrowest grant that makes the route work:
--   INSERT         table-wide: Drizzle's insert names every column (DEFAULT for the ones the route leaves out), which needs
--                  privilege on each, so a column list would have to name them all anyway.
--   UPDATE (cols)  the upsert's ON CONFLICT set: title, description, order and the canonical flag. A step's key, owner role,
--                  due days, precondition, completion mode, optional flag and retirement can never be rewritten from the
--                  platform side. The route itself refuses a canonical key (409 ONBOARDING_TEMPLATE_CANONICAL) and its
--                  ON CONFLICT ... WHERE is_canonical = false keeps a canonical row untouched under a race.
-- No DELETE: onboarding_task rows reference the key (ON DELETE restrict). Nothing is revoked, so this stays `expand`.
-- The carrier exists only where scripts/db/provision-runtime-roles.ts has run; that script re-grants the same on every run.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    GRANT INSERT ON "onboarding_task_template" TO chartwarden_platform;
    GRANT UPDATE ("display_label", "description", "canonical_order", "is_canonical") ON "onboarding_task_template" TO chartwarden_platform;
  END IF;
END $$;
