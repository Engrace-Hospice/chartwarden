-- M1 — `email_belongs_to_tenant(p_email, p_label)`: is this address a person of THIS tenant? (ADR-0049 Phase 4 fix.)
--   The reset / magic-link host rewrite (`rewriteLinkToRequestOrigin`) must keep a link on the tenant host only for a
--   recipient who belongs to that tenant. 1146 `tenant_links_for_email` answers only for ACTIVE MEMBERSHIPS, so a
--   portal-only person (patient / caregiver / bereaved: a `portal_account`, no membership) was refused and their magic
--   link stayed on the global origin. Same chicken-and-egg as 1145 / 1146 (no org is bound before sign-in), same answer:
--   a narrow SECURITY DEFINER function owned by chartwarden_admin, pinned search_path, EXECUTE for chartwarden_app only.
--
--   Returns a BOOLEAN for the ONE (email, label) passed in - never a list, so it is not an enumeration surface beyond the
--   yes/no the caller already needs, and it has no row cap (tenant_links_for_email's LIMIT 20 could drop the match).
--   True when the user holds an ACTIVE membership, or a live portal account (invited / active / bereaved: not suspended
--   or revoked), in the organization whose CURRENT slug is p_label and whose status is `active` or `created`.
CREATE OR REPLACE FUNCTION email_belongs_to_tenant(p_email text, p_label text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public."user" u
      JOIN public.organization o ON o.slug = p_label AND o.status IN ('active', 'created')
     WHERE lower(u.email) = lower(p_email)
       AND (
         EXISTS (SELECT 1 FROM public.membership m
                  WHERE m.user_id = u.id AND m.organization_id = o.id AND m.status = 'active')
         OR EXISTS (SELECT 1 FROM public.portal_account pa
                     WHERE pa.user_id = u.id AND pa.organization_id = o.id
                       AND pa.revoked_at IS NULL AND pa.status IN ('invited', 'active', 'bereaved'))
       )
  );
$$;--> statement-breakpoint
ALTER FUNCTION email_belongs_to_tenant(text, text) OWNER TO chartwarden_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION email_belongs_to_tenant(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION email_belongs_to_tenant(text, text) TO chartwarden_app;
