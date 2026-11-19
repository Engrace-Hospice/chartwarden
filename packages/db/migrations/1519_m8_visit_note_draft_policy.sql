-- compat: expand
-- M8 visit-note drafting (ADR-0114, VN-D17): `visit_note_draft_policy`, the per-tenant switch for the deterministic draft and its sign
-- gate. One row per organization (the primary key); an ABSENT row means OFF, applied in code, because main auto-deploys and a tenant is
-- switched on only after the phrase corpus has had its clinical review. The mirror of `documentation_obligation_policy` (1514):
--   * enabled / enabled_at: enabled_at is stamped by the service when the switch moves off -> on, kept while it stays on, and NULL when
--     it is off (the CHECK pins that pairing, so a row can never claim an instant while off).
--   * changed_by_membership_id: the member who wrote the row last.
--   * Org-level configuration with no patient and no PHI: organization_id only (the 1514 / tenant_sbar_policy precedent).
-- The PUT upserts, so the application role holds INSERT + UPDATE and no DELETE (a tenant resets by writing enabled = false).
-- Every write is also recorded by the row trigger below AND by the service's explicit m8.encounter.draft_policy_changed event.
-- Roles are the post-1139 names (chartwarden_*).

CREATE TABLE "visit_note_draft_policy" (
  "organization_id" uuid PRIMARY KEY REFERENCES "organization"("id") ON DELETE RESTRICT,
  "enabled" boolean DEFAULT false NOT NULL,
  "enabled_at" timestamptz,
  "changed_by_membership_id" uuid NOT NULL REFERENCES "membership"("id") ON DELETE RESTRICT,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "visit_note_draft_policy_enabled_at_check" CHECK ("enabled" = ("enabled_at" IS NOT NULL))
);--> statement-breakpoint

ALTER TABLE "visit_note_draft_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "visit_note_draft_policy" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "visit_note_draft_policy_org_isolation" ON "visit_note_draft_policy"
  FOR ALL TO chartwarden_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "visit_note_draft_policy" TO chartwarden_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_visit_note_draft_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME,
    COALESCE(NEW.organization_id, OLD.organization_id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_visit_note_draft_policy() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_visit_note_draft_policy"
  AFTER INSERT OR UPDATE OR DELETE ON visit_note_draft_policy
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_visit_note_draft_policy();--> statement-breakpoint

-- The acting member must belong to the row's own organization (the single-column FK ignores RLS; the 1514 / 1517 guard shape, SECURITY
-- INVOKER so the read runs under the caller's RLS).
CREATE OR REPLACE FUNCTION visit_note_draft_policy_org_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM membership m WHERE m.id = NEW.changed_by_membership_id AND m.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'visit_note_draft_policy: the acting member must belong to the row''s organization'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_visit_note_draft_policy_org_guard"
  BEFORE INSERT OR UPDATE ON "visit_note_draft_policy"
  FOR EACH ROW EXECUTE FUNCTION visit_note_draft_policy_org_guard();--> statement-breakpoint

-- Tenant destruction (the 1099 / 1478 / 1514 pattern).
GRANT SELECT, DELETE ON "visit_note_draft_policy" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "visit_note_draft_policy_destruction" ON "visit_note_draft_policy"
  FOR ALL TO chartwarden_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
