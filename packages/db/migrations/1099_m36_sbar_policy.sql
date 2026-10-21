-- M36 WP 3.3 - SBAR structured messages: the tenant's tighten-only policy. One row per organisation, absent = platform
-- defaults. A tenant may RAISE any section's minimum length, require a patient (care_team) channel, and re-word the
-- per-section hint text; it cannot go below the platform floor (the CHECKs below pin the same bounds as
-- SBAR_PLATFORM_FLOOR / the 500 ceiling in @chartwarden/types, with a pin test) and cannot switch SBAR off (the
-- `messaging.sbar` ops flag is the off switch). The floor is re-applied on every read, so a row written under an older
-- floor never loosens a raised one.
--
-- Not PHI and no patient column: org-level configuration, so only organization_id of the three-column rule (like
-- tenant_message_template_overlay). Hints are non-clinical guidance text held to the WP 2.8 PHI lint on save and on
-- read; the audit trigger scrubs them anyway so a hint that slipped past the lint never lands in the immutable log.

CREATE TABLE "tenant_sbar_policy" (
  "organization_id" uuid PRIMARY KEY REFERENCES "organization"("id") ON DELETE RESTRICT,
  "situation_min_chars" integer DEFAULT 1 NOT NULL,
  "background_min_chars" integer DEFAULT 1 NOT NULL,
  "assessment_min_chars" integer DEFAULT 1 NOT NULL,
  "recommendation_min_chars" integer DEFAULT 1 NOT NULL,
  "require_patient_channel" boolean DEFAULT false NOT NULL,
  "situation_hint" text,
  "background_hint" text,
  "assessment_hint" text,
  "recommendation_hint" text,
  "configured_by_user_id" uuid NOT NULL REFERENCES "user"("id"),
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "tenant_sbar_policy_situation_min" CHECK ("situation_min_chars" BETWEEN 1 AND 500),
  CONSTRAINT "tenant_sbar_policy_background_min" CHECK ("background_min_chars" BETWEEN 1 AND 500),
  CONSTRAINT "tenant_sbar_policy_assessment_min" CHECK ("assessment_min_chars" BETWEEN 1 AND 500),
  CONSTRAINT "tenant_sbar_policy_recommendation_min" CHECK ("recommendation_min_chars" BETWEEN 1 AND 500),
  CONSTRAINT "tenant_sbar_policy_situation_hint" CHECK ("situation_hint" IS NULL OR char_length(btrim("situation_hint")) BETWEEN 1 AND 200),
  CONSTRAINT "tenant_sbar_policy_background_hint" CHECK ("background_hint" IS NULL OR char_length(btrim("background_hint")) BETWEEN 1 AND 200),
  CONSTRAINT "tenant_sbar_policy_assessment_hint" CHECK ("assessment_hint" IS NULL OR char_length(btrim("assessment_hint")) BETWEEN 1 AND 200),
  CONSTRAINT "tenant_sbar_policy_recommendation_hint" CHECK ("recommendation_hint" IS NULL OR char_length(btrim("recommendation_hint")) BETWEEN 1 AND 200)
);--> statement-breakpoint
CREATE INDEX "tenant_sbar_policy_configured_by_idx" ON "tenant_sbar_policy" ("configured_by_user_id");--> statement-breakpoint

ALTER TABLE "tenant_sbar_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_sbar_policy" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_sbar_policy_org_isolation" ON "tenant_sbar_policy"
  FOR ALL TO wardenx_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_sbar_policy" TO wardenx_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_tenant_sbar_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD),
      ARRAY['situation_hint','background_hint','assessment_hint','recommendation_hint']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW),
      ARRAY['situation_hint','background_hint','assessment_hint','recommendation_hint']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'tenant_sbar_policy.' || lower(TG_OP), 'tenant_sbar_policy',
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
ALTER FUNCTION audit_phi_write_tenant_sbar_policy() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tenant_sbar_policy"
  AFTER INSERT OR UPDATE OR DELETE ON tenant_sbar_policy
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tenant_sbar_policy();--> statement-breakpoint

GRANT SELECT, DELETE ON "tenant_sbar_policy" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "tenant_sbar_policy_destruction" ON "tenant_sbar_policy"
  FOR ALL TO wardenx_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
