-- compat: expand
-- ADR-0109 D10 / blueprint section 3 (PR 3) - M16 SUPPORT GROUPS: `bereavement_support_group` (the group), `_session` (one meeting),
-- `_enrollment` (a program contact signed up) and `_attendance` (a contact was there).
--   * GROUP and SESSION are ORG-LEVEL (the 1374 config/run precedent): a group is agency programming that serves families across every provider
--     entity, and names no patient, plan or contact. ENROLLMENT and ATTENDANCE name a plan and a contact, so they carry organization_id +
--     provider_entity_id NOT NULL + location_id (nullable), denormalized from the plan (ARCH-011).
--   * Owner decisions (2026-11-05): a group is recurring or drop-in, in person or virtual, for PROGRAM families only, facilitated by staff or by a
--     volunteer who passes the 418.78 gates. ATTENDANCE writes a contact-log ACTIVITY row (`support_group_session`, outcome `attended`, the 1373
--     shape) and satisfies NO cadence item. `facilitator_user_id` / `co_facilitator_user_id` hold MEMBERSHIP ids (the `assigned_counselor_user_id`
--     convention). `join_url_cipher` is sealed with the tenant DEK (a virtual meeting link). `recurrence_jsonb` = { firstDate, startTime,
--     durationMinutes, intervalWeeks, count } in the group's `timezone`; the sessions are materialized when the group opens.
--   * Every table: ENABLE + FORCE RLS on app.org_id, SELECT/INSERT/UPDATE to the app role (nothing deletes), the 1200 PHI audit trigger (the
--     agency-authored description is prose and is scrubbed), FK indexes. The `bereavement_record` eraser deletes a decedent's enrollment and
--     attendance rows (RESTRICT FKs on the contact), so the destruction role gets SELECT + DELETE on those two with an org-pinned policy.
--   * The four `bereavement.group.*` keys are mirrored into the permission catalog (the 1377 shape).
CREATE TABLE "bereavement_support_group" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "name" text NOT NULL,
  "description" text,
  "format" text NOT NULL,
  "modality" text NOT NULL,
  "enrollment_required" boolean DEFAULT true NOT NULL,
  "facilitator_kind" text NOT NULL,
  "facilitator_user_id" uuid NOT NULL,
  "co_facilitator_user_id" uuid,
  "capacity" integer,
  "status" text DEFAULT 'draft' NOT NULL,
  "recurrence_jsonb" jsonb,
  "timezone" text DEFAULT 'UTC' NOT NULL,
  "venue_text" text,
  "join_url_cipher" text,
  "created_by_membership_id" uuid NOT NULL,
  "opened_at" timestamptz,
  "closed_at" timestamptz,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "berv_group_name_chk" CHECK (char_length("name") BETWEEN 1 AND 120),
  CONSTRAINT "berv_group_description_chk" CHECK ("description" IS NULL OR char_length("description") <= 2000),
  CONSTRAINT "berv_group_format_chk" CHECK ("format" IN ('recurring', 'drop_in')),
  CONSTRAINT "berv_group_modality_chk" CHECK ("modality" IN ('in_person', 'virtual')),
  CONSTRAINT "berv_group_facilitator_kind_chk" CHECK ("facilitator_kind" IN ('staff', 'volunteer')),
  CONSTRAINT "berv_group_capacity_chk" CHECK ("capacity" IS NULL OR "capacity" BETWEEN 1 AND 500),
  CONSTRAINT "berv_group_status_chk" CHECK ("status" IN ('draft', 'open', 'completed', 'cancelled')),
  -- A recurring group carries its recurrence; a drop-in group has none (its sessions are added one at a time).
  CONSTRAINT "berv_group_recurrence_chk" CHECK (("format" = 'recurring') = ("recurrence_jsonb" IS NOT NULL)),
  CONSTRAINT "berv_group_venue_chk" CHECK ("venue_text" IS NULL OR char_length("venue_text") <= 500),
  CONSTRAINT "berv_group_cofacilitator_chk" CHECK ("co_facilitator_user_id" IS NULL OR "co_facilitator_user_id" <> "facilitator_user_id"),
  CONSTRAINT "berv_group_opened_chk" CHECK ("status" = 'draft' OR "status" = 'cancelled' OR "opened_at" IS NOT NULL),
  CONSTRAINT "berv_group_closed_chk" CHECK (("status" IN ('completed', 'cancelled')) = ("closed_at" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX "berv_group_org_status_idx" ON "bereavement_support_group" ("organization_id", "status", "created_at" DESC);--> statement-breakpoint
CREATE INDEX "berv_group_facilitator_idx" ON "bereavement_support_group" ("facilitator_user_id");--> statement-breakpoint
CREATE INDEX "berv_group_cofacilitator_idx" ON "bereavement_support_group" ("co_facilitator_user_id") WHERE "co_facilitator_user_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE "bereavement_support_group_session" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "group_id" uuid NOT NULL REFERENCES "bereavement_support_group"("id") ON DELETE RESTRICT,
  "session_no" integer NOT NULL,
  "starts_at" timestamptz NOT NULL,
  "ends_at" timestamptz NOT NULL,
  "status" text DEFAULT 'scheduled' NOT NULL,
  "held_at" timestamptz,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "berv_group_session_no_chk" CHECK ("session_no" >= 1),
  CONSTRAINT "berv_group_session_window_chk" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "berv_group_session_status_chk" CHECK ("status" IN ('scheduled', 'held', 'cancelled')),
  CONSTRAINT "berv_group_session_held_chk" CHECK (("status" = 'held') = ("held_at" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "berv_group_session_no_uniq" ON "bereavement_support_group_session" ("group_id", "session_no");--> statement-breakpoint
CREATE INDEX "berv_group_session_group_starts_idx" ON "bereavement_support_group_session" ("group_id", "starts_at");--> statement-breakpoint
CREATE INDEX "berv_group_session_org_starts_idx" ON "bereavement_support_group_session" ("organization_id", "starts_at");--> statement-breakpoint

CREATE TABLE "bereavement_support_group_enrollment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "group_id" uuid NOT NULL REFERENCES "bereavement_support_group"("id") ON DELETE RESTRICT,
  "plan_id" uuid NOT NULL REFERENCES "bereavement_plan"("id") ON DELETE RESTRICT,
  "bereaved_contact_id" uuid NOT NULL REFERENCES "bereaved_contact"("id") ON DELETE RESTRICT,
  "status" text DEFAULT 'enrolled' NOT NULL,
  "withdrawn_reason" text,
  "enrolled_by_membership_id" uuid NOT NULL,
  "enrolled_at" timestamptz DEFAULT now() NOT NULL,
  "withdrawn_at" timestamptz,
  "withdrawn_by_membership_id" uuid,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "berv_group_enrollment_status_chk" CHECK ("status" IN ('enrolled', 'withdrawn')),
  CONSTRAINT "berv_group_enrollment_reason_chk" CHECK ("withdrawn_reason" IS NULL OR "withdrawn_reason" IN ('requested', 'staff_removed', 'opted_out', 'plan_closed', 'group_ended')),
  -- A withdrawn enrollment names why and when; an enrolled one names neither.
  CONSTRAINT "berv_group_enrollment_withdrawn_chk" CHECK (("status" = 'withdrawn') = ("withdrawn_reason" IS NOT NULL AND "withdrawn_at" IS NOT NULL))
);--> statement-breakpoint
-- One live enrollment per contact per group (a withdrawn one may be followed by a fresh enrollment).
CREATE UNIQUE INDEX "berv_group_enrollment_live_uniq" ON "bereavement_support_group_enrollment" ("group_id", "bereaved_contact_id") WHERE "status" = 'enrolled';--> statement-breakpoint
CREATE INDEX "berv_group_enrollment_org_ix" ON "bereavement_support_group_enrollment" ("organization_id", "created_at");--> statement-breakpoint
CREATE INDEX "berv_group_enrollment_group_idx" ON "bereavement_support_group_enrollment" ("group_id", "status");--> statement-breakpoint
CREATE INDEX "berv_group_enrollment_plan_idx" ON "bereavement_support_group_enrollment" ("plan_id");--> statement-breakpoint
CREATE INDEX "berv_group_enrollment_contact_idx" ON "bereavement_support_group_enrollment" ("bereaved_contact_id");--> statement-breakpoint
CREATE INDEX "berv_group_enrollment_provider_entity_idx" ON "bereavement_support_group_enrollment" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX "berv_group_enrollment_location_idx" ON "bereavement_support_group_enrollment" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE "bereavement_support_group_attendance" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "session_id" uuid NOT NULL REFERENCES "bereavement_support_group_session"("id") ON DELETE RESTRICT,
  "group_id" uuid NOT NULL REFERENCES "bereavement_support_group"("id") ON DELETE RESTRICT,
  "plan_id" uuid NOT NULL REFERENCES "bereavement_plan"("id") ON DELETE RESTRICT,
  "bereaved_contact_id" uuid NOT NULL REFERENCES "bereaved_contact"("id") ON DELETE RESTRICT,
  "recorded_by_membership_id" uuid NOT NULL,
  "recorded_at" timestamptz DEFAULT now() NOT NULL,
  -- the activity row on the (partitioned) contact log: logical, no FK
  "log_id" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "berv_group_attendance_session_contact_uniq" ON "bereavement_support_group_attendance" ("session_id", "bereaved_contact_id");--> statement-breakpoint
CREATE INDEX "berv_group_attendance_org_ix" ON "bereavement_support_group_attendance" ("organization_id", "created_at");--> statement-breakpoint
CREATE INDEX "berv_group_attendance_group_idx" ON "bereavement_support_group_attendance" ("group_id");--> statement-breakpoint
CREATE INDEX "berv_group_attendance_plan_idx" ON "bereavement_support_group_attendance" ("plan_id");--> statement-breakpoint
CREATE INDEX "berv_group_attendance_contact_idx" ON "bereavement_support_group_attendance" ("bereaved_contact_id");--> statement-breakpoint
CREATE INDEX "berv_group_attendance_provider_entity_idx" ON "bereavement_support_group_attendance" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX "berv_group_attendance_location_idx" ON "bereavement_support_group_attendance" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "bereavement_support_group" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bereavement_support_group" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bereavement_support_group_org_isolation" ON "bereavement_support_group"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "bereavement_support_group" TO chartwarden_app;--> statement-breakpoint
ALTER TABLE "bereavement_support_group_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bereavement_support_group_session" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bereavement_support_group_session_org_isolation" ON "bereavement_support_group_session"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "bereavement_support_group_session" TO chartwarden_app;--> statement-breakpoint
ALTER TABLE "bereavement_support_group_enrollment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bereavement_support_group_enrollment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bereavement_support_group_enrollment_org_isolation" ON "bereavement_support_group_enrollment"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "bereavement_support_group_enrollment" TO chartwarden_app;--> statement-breakpoint
ALTER TABLE "bereavement_support_group_attendance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bereavement_support_group_attendance" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bereavement_support_group_attendance_org_isolation" ON "bereavement_support_group_attendance"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "bereavement_support_group_attendance" TO chartwarden_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_support_group() RETURNS trigger
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
ALTER FUNCTION audit_phi_write_bereavement_support_group() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_support_group"
  AFTER INSERT OR UPDATE OR DELETE ON bereavement_support_group
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_support_group('bereavement_support_group');--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_support_group_session() RETURNS trigger
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
ALTER FUNCTION audit_phi_write_bereavement_support_group_session() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_support_group_session"
  AFTER INSERT OR UPDATE OR DELETE ON bereavement_support_group_session
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_support_group_session('bereavement_support_group_session');--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_support_group_enrollment() RETURNS trigger
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
ALTER FUNCTION audit_phi_write_bereavement_support_group_enrollment() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_support_group_enrollment"
  AFTER INSERT OR UPDATE OR DELETE ON bereavement_support_group_enrollment
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_support_group_enrollment('bereavement_support_group_enrollment');--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_support_group_attendance() RETURNS trigger
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
ALTER FUNCTION audit_phi_write_bereavement_support_group_attendance() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_support_group_attendance"
  AFTER INSERT OR UPDATE OR DELETE ON bereavement_support_group_attendance
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_support_group_attendance('bereavement_support_group_attendance');--> statement-breakpoint

GRANT SELECT, DELETE ON "bereavement_support_group_enrollment" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "bereavement_support_group_enrollment_destruction" ON "bereavement_support_group_enrollment"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, DELETE ON "bereavement_support_group_attendance" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "bereavement_support_group_attendance_destruction" ON "bereavement_support_group_attendance"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('bereavement.group.read', 'bereavement_support_group', 'read', 'clinical', 'discipline_can_provide_bereavement', ''),
  ('bereavement.group.manage', 'bereavement_support_group', 'manage', 'clinical', 'bereavement_group_scope', ''),
  ('bereavement.group.enroll', 'bereavement_support_group', 'enroll', 'clinical', 'bereavement_window', ''),
  ('bereavement.group.run', 'bereavement_support_group', 'run', 'clinical', 'bereavement_group_scope', '')
ON CONFLICT ("key") DO NOTHING;
