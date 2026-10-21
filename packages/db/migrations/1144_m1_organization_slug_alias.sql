-- M1 — tenant slug rules and rename aliases (ADR-0049 D3; base domain ADR-0088).
--   * A slug is served as a DNS label (`<slug>.<TENANT_BASE_DOMAIN>`), so `organization.slug` must be an RFC 1123 label, lower-case,
--     3+ characters, never punycode (`xn--`, no homograph look-alikes) and never one of the hosts ADR-0049 D2 reserves. This is
--     enforced by organization_slug_guard on INSERT and on a CHANGE of `slug`, raising check_violation (23514). It is a trigger and
--     not a CHECK constraint because a NOT VALID CHECK is still evaluated on every UPDATE of the row, so suspending or closing a
--     legacy tenant whose slug predates the rules would fail. Slugs already on file are listed by scripts/tenant-slugs-check.ts and
--     renamed by hand (the rename records an alias). The reserved list repeats RESERVED_TENANT_SLUGS (packages/types/src/tenant-slug.ts); tenant-slug.test.ts keeps the two in step.
--   * `organization_slug_alias` holds every slug an organization has ever had. A slug is NEVER reused: an alias can never equal any
--     organization's slug, and an organization cannot take a slug that is another organization's alias. Requests to an alias host
--     are redirected (308) to the current slug, indefinitely.
--   * The alias is written by the rename itself (a trigger on `organization`), not by application code, so a rename through any
--     path (a script, a console) cannot skip it. The app role can only READ its own aliases; the trigger functions are
--     SECURITY DEFINER owned by chartwarden_admin with a pinned search_path so they see every tenant's aliases whatever RLS context the
--     caller carries (a missing GUC must not read as "slug is free").
--   * Not covered, stated plainly: DROP / TRUNCATE or session_replication_role = replica by a superuser (procedural control).

CREATE TABLE "organization_slug_alias" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "alias" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "organization_slug_alias_alias_unique" UNIQUE ("alias")
);--> statement-breakpoint
CREATE INDEX "organization_slug_alias_org_idx" ON "organization_slug_alias" ("organization_id");--> statement-breakpoint

ALTER TABLE "organization_slug_alias" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_slug_alias" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organization_slug_alias_org_isolation" ON "organization_slug_alias"
  FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- The guard functions below read and write every tenant's aliases.
CREATE POLICY "organization_slug_alias_admin_all" ON "organization_slug_alias"
  FOR ALL TO chartwarden_admin USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT ON "organization_slug_alias" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "organization_slug_alias" TO chartwarden_admin;--> statement-breakpoint
-- Aliases are written only by the rename trigger, so INSERT is not audited here (the rename is audited on `organization`).
CREATE TRIGGER "organization_slug_alias_audit" AFTER UPDATE OR DELETE ON organization_slug_alias
  FOR EACH ROW EXECUTE FUNCTION chartwarden_audit_trigger();--> statement-breakpoint

-- organization: an organization may not take a slug that is another organization's alias, and a rename records the old slug.
CREATE OR REPLACE FUNCTION organization_slug_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.slug IS DISTINCT FROM OLD.slug THEN
    IF char_length(NEW.slug) < 3
       OR NEW.slug !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
       OR NEW.slug LIKE 'xn--%'
       OR NEW.slug IN ('www', 'admin', 'api', 'portal', 'storage', 'app', 'status', 'docs', 'mail')
    THEN
      RAISE EXCEPTION 'slug % is not a valid tenant host label (ADR-0049 D3)', NEW.slug
        USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Serialise claims on one name: a concurrent rename away from it (which records it as an alias) and a rename onto it must not
  -- both pass their checks against each other's uncommitted rows. The lock is released at commit.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(NEW.slug));
  IF EXISTS (
       SELECT 1 FROM public.organization_slug_alias a
        WHERE a.alias = NEW.slug AND a.organization_id <> NEW.id
     ) THEN
    RAISE EXCEPTION 'slug % belonged to another organization and is never reused (ADR-0049 D3)', NEW.slug
      USING ERRCODE = '23505';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.slug IS DISTINCT FROM OLD.slug THEN
    -- Returning to one of its own earlier slugs: the alias would otherwise equal the current slug.
    DELETE FROM public.organization_slug_alias a WHERE a.alias = NEW.slug AND a.organization_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
ALTER FUNCTION organization_slug_guard() OWNER TO chartwarden_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION organization_slug_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "organization_slug_guard" BEFORE INSERT OR UPDATE OF "slug" ON "organization"
  FOR EACH ROW EXECUTE FUNCTION organization_slug_guard();--> statement-breakpoint

-- The old slug is recorded AFTER the row carries the new one, because the alias guard refuses an alias equal to a live slug.
CREATE OR REPLACE FUNCTION organization_slug_record_alias() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO public.organization_slug_alias (organization_id, alias)
  VALUES (OLD.id, OLD.slug)
  ON CONFLICT (alias) DO NOTHING;
  RETURN NULL;
END;
$$;--> statement-breakpoint
ALTER FUNCTION organization_slug_record_alias() OWNER TO chartwarden_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION organization_slug_record_alias() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "organization_slug_record_alias" AFTER UPDATE OF "slug" ON "organization"
  FOR EACH ROW WHEN (OLD.slug IS DISTINCT FROM NEW.slug)
  EXECUTE FUNCTION organization_slug_record_alias();--> statement-breakpoint

-- organization_slug_alias: an alias can never equal a live organization slug (that would be a redirect loop or a shadowed tenant).
CREATE OR REPLACE FUNCTION organization_slug_alias_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(NEW.alias));
  IF EXISTS (SELECT 1 FROM public.organization o WHERE o.slug = NEW.alias) THEN
    RAISE EXCEPTION 'alias % is the current slug of an organization (ADR-0049 D3)', NEW.alias
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
ALTER FUNCTION organization_slug_alias_guard() OWNER TO chartwarden_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION organization_slug_alias_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "organization_slug_alias_guard" BEFORE INSERT OR UPDATE OF "alias" ON "organization_slug_alias"
  FOR EACH ROW EXECUTE FUNCTION organization_slug_alias_guard();
