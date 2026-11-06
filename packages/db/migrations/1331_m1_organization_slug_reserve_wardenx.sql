-- compat: expand
-- M1 — `wardenx` is not a tenant slug (ADR-0049 D2/D3).
--   * `wardenx.chartwarden.cloud` is the legacy host the infra rename leaves behind: deploy/production/nginx/chartwarden-legacy-redirects.conf
--     answers that exact vhost with a 308 to app.chartwarden.cloud, and an exact vhost beats the tenant wildcard. A tenant slugged
--     `wardenx` would therefore be redirected away from its own address, so the name is reserved like `app` and `api`.
--   * It is a SECOND, narrow guard beside organization_slug_guard (1144) rather than a restatement of that SECURITY DEFINER function:
--     the alias and advisory-lock logic stays exactly as 1144 wrote it, and the migration stays a pure addition. Together the
--     two `NEW.slug IN (...)` lists are RESERVED_TENANT_SLUGS (packages/types/src/tenant-slug.ts); tenant-slug.test.ts keeps them in step.
--   * Like 1144 it binds only a NEW or CHANGED slug (INSERT, or an UPDATE that changes `slug`), so an organization that already holds
--     `wardenx` is neither refused here nor blocked from being suspended or closed: nothing is rewritten and nothing is rechecked.
--     It needs no table access, so it is a plain (not SECURITY DEFINER) trigger function with a pinned search_path.
CREATE OR REPLACE FUNCTION organization_slug_legacy_host_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.slug IS DISTINCT FROM OLD.slug)
     AND NEW.slug IN ('wardenx')
  THEN
    RAISE EXCEPTION 'slug % is a legacy host of this deployment, not a tenant host label (ADR-0049 D3)', NEW.slug
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "organization_slug_legacy_host_guard" BEFORE INSERT OR UPDATE OF "slug" ON "organization"
  FOR EACH ROW EXECUTE FUNCTION organization_slug_legacy_host_guard();
