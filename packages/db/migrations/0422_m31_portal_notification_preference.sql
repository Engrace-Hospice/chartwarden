-- GAP-092 — M31 portal notification preferences (spec §3.3 `portal_notification_preference`).
--
-- `PATCH /portal/notification-preferences/:id` answered `{ok: true}` and stored nothing (M31 owned no preference
-- table), while `GET` returned a static default. One row per (portal account, channel); a channel with no row reads
-- as its default (email on, sms/push off). Quiet hours live on the row, as the spec models them, and are reported by
-- GET from the account's rows. ORG-SCOPED (organization_id NOT NULL, FORCEd RLS on app.org_id). Holds no PHI: a
-- channel flag and two clock hours keyed to an account id. Idempotent.
CREATE TABLE IF NOT EXISTS "portal_notification_preference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"portal_account_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean NOT NULL,
	"quiet_hours_start_hour" smallint,
	"quiet_hours_end_hour" smallint,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_notification_preference_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "portal_notification_preference_account_fk"
		FOREIGN KEY ("portal_account_id") REFERENCES "public"."portal_account"("id") ON DELETE restrict,
	CONSTRAINT "portal_notification_preference_channel_chk" CHECK ("channel" IN ('email', 'sms', 'push')),
	-- Quiet hours are a pair: both set (each a clock hour) or both absent.
	CONSTRAINT "portal_notification_preference_quiet_hours_chk" CHECK (
		("quiet_hours_start_hour" IS NULL AND "quiet_hours_end_hour" IS NULL)
		OR ("quiet_hours_start_hour" BETWEEN 0 AND 23 AND "quiet_hours_end_hour" BETWEEN 0 AND 23)
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portal_notification_preference_account_channel_uq"
	ON "portal_notification_preference" ("portal_account_id", "channel");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_notification_preference_org_idx" ON "portal_notification_preference" ("organization_id");--> statement-breakpoint

ALTER TABLE "portal_notification_preference" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal_notification_preference" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "portal_notification_preference_org" ON "portal_notification_preference"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "portal_notification_preference" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "portal_notification_preference" TO wardenx_admin;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "portal_notification_preference" TO wardenx_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_portal_notification_preference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'portal_notification_preference.' || lower(TG_OP), 'portal_notification_preference', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_portal_notification_preference() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_portal_notification_preference" ON portal_notification_preference;--> statement-breakpoint
CREATE TRIGGER "trg_audit_portal_notification_preference" AFTER INSERT OR UPDATE OR DELETE ON portal_notification_preference
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_portal_notification_preference();
