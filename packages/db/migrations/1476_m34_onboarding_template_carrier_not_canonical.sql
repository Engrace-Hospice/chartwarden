-- compat: contract
-- M34 - correct migration 1425's claim of "the narrowest grant". 1425 gave the platform carrier (chartwarden_platform) UPDATE on
-- onboarding_task_template."is_canonical", but the code never writes it: the upsert INSERTs is_canonical = false and its ON CONFLICT set
-- names title, description and order only, with `WHERE is_canonical = false` keeping a canonical row untouched. The column grant was
-- unused authority, and the only thing between the platform credential and "promote this step to canonical" (a step that gates go-live for
-- EVERY tenant) was the application code. This migration makes the database the second guard:
--   1. the carrier loses UPDATE ("is_canonical") (REVOKE, hence `contract`: a release that still wrote the column would get 42501);
--   2. a trigger refuses the carrier any INSERT or UPDATE that makes a row canonical, and any UPDATE of a row that already is. A canonical
--      step is changed by migration only. The precedent is the role-checking triggers of 0272 / 0279 / 0280 (a NON-superuser member of
--      the named role: a superuser is implicitly a member of every role, and the migration owner is not the carrier).
-- INSERT stays table-wide and UPDATE stays on display_label, description and canonical_order (the route's upsert set): the corrected
-- claim is "no more than the route writes, and never a canonical row". The carrier exists only where scripts/db/provision-runtime-roles.ts
-- has run (it re-grants the same, without is_canonical, on every run), so the REVOKE is conditional and the trigger tolerates its absence.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    REVOKE UPDATE ("is_canonical") ON "onboarding_task_template" FROM chartwarden_platform;
  END IF;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION onboarding_task_template_platform_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW."is_canonical")
     OR (TG_OP = 'UPDATE' AND (OLD."is_canonical" OR NEW."is_canonical")) THEN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'chartwarden_platform') THEN
      -- Only a NON-superuser member of the carrier: a superuser is implicitly a member of every role.
      IF pg_has_role(current_user, 'chartwarden_platform', 'MEMBER')
         AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
        RAISE EXCEPTION 'a canonical onboarding step is changed by migration only, never by the platform credential'
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "onboarding_task_template_platform_guard" ON "onboarding_task_template";--> statement-breakpoint
CREATE TRIGGER "onboarding_task_template_platform_guard"
  BEFORE INSERT OR UPDATE ON "onboarding_task_template"
  FOR EACH ROW EXECUTE FUNCTION onboarding_task_template_platform_guard();
