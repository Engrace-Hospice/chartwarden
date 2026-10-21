-- M1 — the two public, pre-sign-in lookups the tenant sign-in page and the `app.` landing need (ADR-0049 Phase 4).
--   Same chicken-and-egg as 1145 `resolve_tenant_host`: no org is bound yet, so chartwarden_app cannot read `organization`
--   or `membership` (the tenancy spine's policies key on the `app.org_id` GUC). Same answer: narrow SECURITY DEFINER
--   functions owned by chartwarden_admin, pinned search_path, EXECUTE for chartwarden_app only.
--
--   resolve_tenant_public(p_label)  - the ONE label passed in: its status and, only while the organization is `active` or
--     `created`, its display name (a suspended / closed tenant's name is not shown to the public). A live slug wins over
--     an alias of the same name (1145's tie-break). Returns the CURRENT status of the organization the alias points at.
--   tenant_links_for_email(p_email) - for the ONE address passed in: the (slug, display_name) of each organization where
--     that user holds an ACTIVE membership in an ACTIVE organization. It is never sent back to the caller: the route
--     mails it to the address and answers 202 regardless, so it is not an account-existence oracle.
CREATE OR REPLACE FUNCTION resolve_tenant_public(p_label text)
RETURNS TABLE (status text, display_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT r.status,
         CASE WHEN r.status IN ('active', 'created') THEN r.display_name END
    FROM (
      SELECT o.status::text AS status, o.display_name, false AS via_alias
        FROM public.organization o
       WHERE o.slug = p_label
      UNION ALL
      SELECT o.status::text, o.display_name, true
        FROM public.organization_slug_alias a
        JOIN public.organization o ON o.id = a.organization_id
       WHERE a.alias = p_label
    ) r
   ORDER BY r.via_alias
   LIMIT 1;
$$;--> statement-breakpoint
ALTER FUNCTION resolve_tenant_public(text) OWNER TO chartwarden_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_tenant_public(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_tenant_public(text) TO chartwarden_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION tenant_links_for_email(p_email text)
RETURNS TABLE (slug text, display_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT o.slug, o.display_name
    FROM public."user" u
    JOIN public.membership m ON m.user_id = u.id AND m.status = 'active'
    JOIN public.organization o ON o.id = m.organization_id AND o.status = 'active'
   WHERE lower(u.email) = lower(p_email)
   ORDER BY o.display_name, o.slug
   LIMIT 20;
$$;--> statement-breakpoint
ALTER FUNCTION tenant_links_for_email(text) OWNER TO chartwarden_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION tenant_links_for_email(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenant_links_for_email(text) TO chartwarden_app;
