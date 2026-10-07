-- GAP-158 — M40 `external_grief_resource`: the grief-counseling referral catalog (community grief groups,
-- denominational pastoral-care lists, child-bereavement camps, complicated-grief specialist registries).
--
-- M16's spec (§1, "does not own the referral catalog itself") and M31's bereaved-portal resources list both name M40
-- as the owner; no table existed, so `GET /portal/bereavement/resources` answered 501. TENANT-CURATED (organization_id
-- NOT NULL, FORCEd RLS on app.org_id): each agency's Compliance / Quality staff maintain the list their bereaved
-- families see. Reference data - no PHI (a public organisation's name, url, phone, description). A row is retired with
-- `is_active = false`, never deleted, so M16 referral history that points at it stays resolvable. Idempotent.
CREATE TABLE IF NOT EXISTS "external_grief_resource" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"resource_kind" text NOT NULL,
	"url" text,
	"phone" text,
	"description" text,
	"audience" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_membership_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_grief_resource_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "external_grief_resource_kind_chk" CHECK ("resource_kind" IN
		('community_group', 'pastoral_care', 'child_camp', 'specialist_registry', 'hotline', 'other')),
	CONSTRAINT "external_grief_resource_name_chk" CHECK (length(btrim("name")) > 0),
	CONSTRAINT "external_grief_resource_url_chk" CHECK ("url" IS NULL OR "url" ~* '^https?://')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_grief_resource_org_idx"
	ON "external_grief_resource" ("organization_id", "is_active", "name");--> statement-breakpoint

ALTER TABLE "external_grief_resource" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "external_grief_resource" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "external_grief_resource_org" ON "external_grief_resource"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "external_grief_resource" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "external_grief_resource" TO wardenx_admin;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "external_grief_resource" TO wardenx_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_external_grief_resource() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'external_grief_resource.' || lower(TG_OP), 'external_grief_resource', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'operational');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_external_grief_resource() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_external_grief_resource" ON external_grief_resource;--> statement-breakpoint
CREATE TRIGGER "trg_audit_external_grief_resource" AFTER INSERT OR UPDATE OR DELETE ON external_grief_resource
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_external_grief_resource();
