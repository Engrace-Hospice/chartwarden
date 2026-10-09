-- 1050 — M3 GAP-007: `membership_role.scope` can only hold a shape the reader understands.
--
-- Until now only the assign route validated `scope` (`validateRoleGrant`); every other writer (org-spine facts, f2f
-- clinician roles, the proposed-role attacher, the auditor-link grant, SQL seeds) could store any jsonb, and the
-- reader treated a blob it could not parse as "no narrowing" - so a corrupt RESTRICTION silently widened that role to
-- the membership defaults. The reader now fails closed (packages/auth/src/roles/grant-scope.ts); this migration is the
-- write-side wall so a non-conforming blob cannot be stored in the first place.
--
-- Stored shape: an object whose keys are drawn from
--   providerEntityIds : non-empty array of uuid strings     (reach dimension)
--   locationIds       : non-empty array of uuid strings     (reach dimension)
--   engagementId      : string                              (auditor-link provenance; not a reach dimension)
-- Anything else - a non-object, an unknown key (notably `patientIds`: patient narrowing is the caseload model, not
-- role scope), an empty or non-uuid list - is non-conforming. The semantic rules (subset of the membership defaults,
-- role.scope_level, expiry) stay route-only; the read caps every reach to the membership defaults, so a direct writer
-- can never grant more than the defaults.
--
-- Existing non-conforming rows are QUARANTINED, fail closed, not normalised to unscoped: the original blob moves to
-- `scope_legacy`, `scope` becomes '{}', and the grant EXPIRES NOW (it loses authority; an admin re-grants through the
-- validating route). Idempotent: only rows with no `scope_legacy` yet and a non-conforming `scope` are touched.

ALTER TABLE "membership_role" ADD COLUMN IF NOT EXISTS "scope_legacy" jsonb;--> statement-breakpoint

-- One array of uuid strings, non-empty. A CASE (not AND) so jsonb_array_elements is never evaluated on a non-array.
CREATE OR REPLACE FUNCTION membership_role_scope_ids_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p) IS DISTINCT FROM 'array' THEN false
    WHEN jsonb_array_length(p) = 0 THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p) AS e
      WHERE jsonb_typeof(e) IS DISTINCT FROM 'string'
         OR (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
  END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION membership_role_scope_conforms(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN false
    WHEN (p - ARRAY['providerEntityIds', 'locationIds', 'engagementId']) <> '{}'::jsonb THEN false
    ELSE (p -> 'providerEntityIds' IS NULL OR membership_role_scope_ids_ok(p -> 'providerEntityIds'))
     AND (p -> 'locationIds' IS NULL OR membership_role_scope_ids_ok(p -> 'locationIds'))
     AND (p -> 'engagementId' IS NULL OR jsonb_typeof(p -> 'engagementId') = 'string')
  END
$$;--> statement-breakpoint

UPDATE "membership_role"
   SET "scope_legacy" = "scope",
       "scope" = '{}'::jsonb,
       "expires_at" = now()
 WHERE "scope_legacy" IS NULL
   AND NOT membership_role_scope_conforms("scope");--> statement-breakpoint

ALTER TABLE "membership_role" DROP CONSTRAINT IF EXISTS "membership_role_scope_shape";--> statement-breakpoint
ALTER TABLE "membership_role"
  ADD CONSTRAINT "membership_role_scope_shape" CHECK (membership_role_scope_conforms("scope"));
