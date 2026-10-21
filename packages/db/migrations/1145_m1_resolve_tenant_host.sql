-- M1 — resolve a tenant host label to its organization BEFORE any org is bound (ADR-0049 D2/D6).
--   A request arrives on `<label>.<TENANT_BASE_DOMAIN>` with no `app.org_id` yet, and `organization` is not visible to
--   chartwarden_app without it (the tenancy spine's policy keys on the GUC). The same chicken-and-egg 0215/0520 solved for
--   the membership picker and portal sign-in is solved the same way: one narrow SECURITY DEFINER function, owned by
--   chartwarden_admin, pinned search_path, EXECUTE for chartwarden_app only.
--   It answers exactly one question for the ONE label passed in: which organization serves it, under what current slug,
--   in what status, and whether the label is a retired alias. It enumerates nothing and returns no profile data. The
--   label is the request's own DNS name (already public); the organization id it returns is used only to compare with the
--   session's org, and is never sent back to the client.
CREATE OR REPLACE FUNCTION resolve_tenant_host(p_label text)
RETURNS TABLE (organization_id uuid, slug text, status text, via_alias boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  -- A live slug always wins over an alias of the same name (the guards make that case unreachable; this is the tie-break).
  SELECT r.id, r.slug, r.status, r.via_alias FROM (
    SELECT o.id, o.slug, o.status::text AS status, false AS via_alias
      FROM public.organization o
     WHERE o.slug = p_label
    UNION ALL
    SELECT o.id, o.slug, o.status::text, true
      FROM public.organization_slug_alias a
      JOIN public.organization o ON o.id = a.organization_id
     WHERE a.alias = p_label
  ) r
  ORDER BY r.via_alias
  LIMIT 1;
$$;--> statement-breakpoint
ALTER FUNCTION resolve_tenant_host(text) OWNER TO chartwarden_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_tenant_host(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_tenant_host(text) TO chartwarden_app;
