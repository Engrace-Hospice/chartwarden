-- compat: expand
-- ADR-0109 D10 / blueprint section 3 (PR 3) - M16 MEMORIAL SERVICES: `bereavement_memorial_service` (one remembrance event) and
-- `bereavement_memorial_invitation` (one program contact invited to it).
--   * SERVICE is ORG-LEVEL (the 1374 / 1390 precedent: agency programming, no patient, plan or contact). INVITATION names a plan and a contact and
--     carries organization_id + provider_entity_id NOT NULL + location_id (nullable), denormalized from the plan (ARCH-011).
--   * Owner decisions (2026-11-05): a memorial invites the families of deaths within `invite_window_months` (default 12) of the service; RSVP by staff
--     (phone) and by the family in the bereaved portal. Publishing selects the invitations SET-BASED (program families only) and, for the families who
--     can receive post, drafts ONE `memorial_invitation` mailing run (`mailing_run_id`, the 1374 run; no default wording ships). `delivery` is
--     `mailing` (in that run) or `portal_only` (no letter: a no-mailings opt-out, no address; the portal and a staff call still reach them).
--     Attendance writes a contact-log ACTIVITY row (`memorial_service_attendance`, outcome `attended`, the 1373 shape): no cadence item.
--   * `join_url_cipher` is sealed with the tenant DEK (a virtual service link). `guests` is a COUNT (0..10): guest names are deferred.
--   * Every table: ENABLE + FORCE RLS on app.org_id, SELECT/INSERT/UPDATE to the app role (nothing deletes), the 1200 PHI audit trigger (the
--     agency-authored description is prose and is scrubbed), FK and org indexes. The eraser deletes a decedent's invitations (RESTRICT FKs on the
--     contact), so the destruction role gets SELECT + DELETE on them with an org-pinned policy.
--   * Catalog rows: `bereavement.memorial.manage` (oversight), `bereavement.memorial.rsvp` (staff RSVP on the family's window) and
--     `portal.bereavement.rsvp_own` (the bereaved family's own RSVP, window-gated in M31).
CREATE TABLE "bereavement_memorial_service" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "title" text NOT NULL,
  "description" text,
  "starts_at" timestamptz NOT NULL,
  "ends_at" timestamptz NOT NULL,
  "modality" text NOT NULL,
  "venue_text" text,
  "join_url_cipher" text,
  "capacity" integer,
  "rsvp_by" date,
  "invite_window_months" integer DEFAULT 12 NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "invited_count" integer DEFAULT 0 NOT NULL,
  "mailing_run_id" uuid REFERENCES "bereavement_mailing_run"("id") ON DELETE RESTRICT,
  "created_by_membership_id" uuid NOT NULL,
  "published_at" timestamptz,
  "published_by_membership_id" uuid,
  "closed_at" timestamptz,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "berv_memorial_title_chk" CHECK (char_length("title") BETWEEN 1 AND 160),
  CONSTRAINT "berv_memorial_description_chk" CHECK ("description" IS NULL OR char_length("description") <= 2000),
  CONSTRAINT "berv_memorial_window_chk" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "berv_memorial_modality_chk" CHECK ("modality" IN ('in_person', 'virtual')),
  CONSTRAINT "berv_memorial_venue_chk" CHECK ("venue_text" IS NULL OR char_length("venue_text") <= 500),
  CONSTRAINT "berv_memorial_capacity_chk" CHECK ("capacity" IS NULL OR "capacity" BETWEEN 1 AND 5000),
  CONSTRAINT "berv_memorial_invite_window_chk" CHECK ("invite_window_months" BETWEEN 1 AND 13),
  CONSTRAINT "berv_memorial_status_chk" CHECK ("status" IN ('draft', 'published', 'held', 'cancelled')),
  CONSTRAINT "berv_memorial_invited_chk" CHECK ("invited_count" >= 0),
  -- A published (or held) service names who published it and when; a draft names neither.
  CONSTRAINT "berv_memorial_published_chk" CHECK (("status" IN ('published', 'held')) <= ("published_at" IS NOT NULL AND "published_by_membership_id" IS NOT NULL)),
  CONSTRAINT "berv_memorial_closed_chk" CHECK (("status" IN ('held', 'cancelled')) = ("closed_at" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX "berv_memorial_org_starts_idx" ON "bereavement_memorial_service" ("organization_id", "starts_at" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "berv_memorial_mailing_run_idx" ON "bereavement_memorial_service" ("mailing_run_id") WHERE "mailing_run_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE "bereavement_memorial_invitation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "service_id" uuid NOT NULL REFERENCES "bereavement_memorial_service"("id") ON DELETE RESTRICT,
  "plan_id" uuid NOT NULL REFERENCES "bereavement_plan"("id") ON DELETE RESTRICT,
  "bereaved_contact_id" uuid NOT NULL REFERENCES "bereaved_contact"("id") ON DELETE RESTRICT,
  "delivery" text NOT NULL,
  "status" text DEFAULT 'invited' NOT NULL,
  "guests" integer DEFAULT 0 NOT NULL,
  "rsvp_source" text,
  "rsvp_at" timestamptz,
  "rsvp_recorded_by_membership_id" uuid,
  "attended_at" timestamptz,
  -- the activity row on the (partitioned) contact log: logical, no FK
  "log_id" uuid,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "berv_memorial_inv_delivery_chk" CHECK ("delivery" IN ('mailing', 'portal_only')),
  CONSTRAINT "berv_memorial_inv_status_chk" CHECK ("status" IN ('invited', 'rsvp_yes', 'rsvp_no', 'rsvp_maybe', 'attended', 'no_show', 'withdrawn')),
  CONSTRAINT "berv_memorial_inv_guests_chk" CHECK ("guests" BETWEEN 0 AND 10),
  CONSTRAINT "berv_memorial_inv_source_chk" CHECK ("rsvp_source" IS NULL OR "rsvp_source" IN ('staff_phone', 'portal')),
  -- An answered invitation names how and when it was answered; a staff answer names who took it.
  CONSTRAINT "berv_memorial_inv_rsvp_chk" CHECK (("status" IN ('rsvp_yes', 'rsvp_no', 'rsvp_maybe')) <= ("rsvp_source" IS NOT NULL AND "rsvp_at" IS NOT NULL)),
  CONSTRAINT "berv_memorial_inv_staff_chk" CHECK ("rsvp_source" IS DISTINCT FROM 'staff_phone' OR "rsvp_recorded_by_membership_id" IS NOT NULL),
  CONSTRAINT "berv_memorial_inv_attended_chk" CHECK (("status" = 'attended') = ("attended_at" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "berv_memorial_inv_service_contact_uniq" ON "bereavement_memorial_invitation" ("service_id", "bereaved_contact_id");--> statement-breakpoint
CREATE INDEX "berv_memorial_inv_org_ix" ON "bereavement_memorial_invitation" ("organization_id", "created_at");--> statement-breakpoint
CREATE INDEX "berv_memorial_inv_service_status_idx" ON "bereavement_memorial_invitation" ("service_id", "status");--> statement-breakpoint
CREATE INDEX "berv_memorial_inv_plan_idx" ON "bereavement_memorial_invitation" ("plan_id");--> statement-breakpoint
CREATE INDEX "berv_memorial_inv_contact_idx" ON "bereavement_memorial_invitation" ("bereaved_contact_id");--> statement-breakpoint
CREATE INDEX "berv_memorial_inv_provider_entity_idx" ON "bereavement_memorial_invitation" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX "berv_memorial_inv_location_idx" ON "bereavement_memorial_invitation" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "bereavement_memorial_service" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bereavement_memorial_service" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bereavement_memorial_service_org_isolation" ON "bereavement_memorial_service"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "bereavement_memorial_service" TO chartwarden_app;--> statement-breakpoint
ALTER TABLE "bereavement_memorial_invitation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bereavement_memorial_invitation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bereavement_memorial_invitation_org_isolation" ON "bereavement_memorial_invitation"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "bereavement_memorial_invitation" TO chartwarden_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_memorial_service() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_before jsonb; v_after jsonb;
  v_cols text[] := ARRAY['description']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    TG_ARGV[0] || '.' || lower(TG_OP), TG_ARGV[0],
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_bereavement_memorial_service() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_memorial_service"
  AFTER INSERT OR UPDATE OR DELETE ON bereavement_memorial_service
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_memorial_service('bereavement_memorial_service');--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_memorial_invitation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_before jsonb; v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    TG_ARGV[0] || '.' || lower(TG_OP), TG_ARGV[0],
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_bereavement_memorial_invitation() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_memorial_invitation"
  AFTER INSERT OR UPDATE OR DELETE ON bereavement_memorial_invitation
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_memorial_invitation('bereavement_memorial_invitation');--> statement-breakpoint

GRANT SELECT, DELETE ON "bereavement_memorial_invitation" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "bereavement_memorial_invitation_destruction" ON "bereavement_memorial_invitation"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('bereavement.memorial.manage', 'bereavement_memorial_service', 'manage', 'clinical', 'org_scope_bereavement_oversight', ''),
  ('bereavement.memorial.rsvp', 'bereavement_memorial_service', 'rsvp', 'clinical', 'bereavement_window', ''),
  ('portal.bereavement.rsvp_own', 'portal_bereavement', 'rsvp_own', 'portal', 'bereaved_portal_window_open', '')
ON CONFLICT ("key") DO NOTHING;
