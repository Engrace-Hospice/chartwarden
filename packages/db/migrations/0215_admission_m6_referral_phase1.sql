-- Phase 1 Admission & Intake redesign foundation.
--
-- Status mapping:
--   received  -> received
--   evaluated -> under_review
--   rejected  -> declined
--   withdrawn -> withdrawn
--   admitted  -> converted
--   accepted  -> converted when an admission already references the referral, otherwise qualified
--> statement-breakpoint
CREATE TYPE "public"."referral_status_v2" AS ENUM(
  'received',
  'under_review',
  'pending_information',
  'qualified',
  'declined',
  'duplicate',
  'withdrawn',
  'converted'
);--> statement-breakpoint
CREATE TYPE "public"."referral_patient_resolution_status" AS ENUM(
  'unresolved',
  'possible_match',
  'matched',
  'created'
);--> statement-breakpoint
CREATE TYPE "public"."referral_priority" AS ENUM('routine', 'high', 'urgent');--> statement-breakpoint
ALTER TABLE "referral" ADD COLUMN IF NOT EXISTS "referrer_organization" text;--> statement-breakpoint
ALTER TABLE "referral" ADD COLUMN IF NOT EXISTS "external_referral_id" text;--> statement-breakpoint
ALTER TABLE "referral" ADD COLUMN IF NOT EXISTS "patient_resolution_status" "referral_patient_resolution_status" DEFAULT 'unresolved' NOT NULL;--> statement-breakpoint
ALTER TABLE "referral" ADD COLUMN IF NOT EXISTS "priority" "referral_priority" DEFAULT 'routine' NOT NULL;--> statement-breakpoint
ALTER TABLE "referral" ADD COLUMN IF NOT EXISTS "assigned_to_user_id" uuid REFERENCES "user"(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "referral" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referral" ADD COLUMN IF NOT EXISTS "reviewed_by" uuid REFERENCES "user"(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "referral" ADD COLUMN IF NOT EXISTS "qualified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referral" ADD COLUMN IF NOT EXISTS "qualified_by" uuid REFERENCES "user"(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "referral" ADD COLUMN IF NOT EXISTS "declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referral" ADD COLUMN IF NOT EXISTS "converted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referral" ADD COLUMN IF NOT EXISTS "converted_admission_id" uuid;--> statement-breakpoint
ALTER TABLE "referral" ADD COLUMN IF NOT EXISTS "_phase1_status_target" text;--> statement-breakpoint
UPDATE "referral" r
SET
  reviewed_at = COALESCE(reviewed_at, evaluated_at),
  reviewed_by = COALESCE(reviewed_by, evaluated_by),
  qualified_at = CASE WHEN r.status = 'accepted' AND NOT EXISTS (
    SELECT 1 FROM admission a WHERE a.organization_id = r.organization_id AND a.referral_id = r.id
  ) THEN COALESCE(qualified_at, decided_at, evaluated_at, updated_at) ELSE qualified_at END,
  declined_at = CASE WHEN r.status = 'rejected' THEN COALESCE(declined_at, decided_at, updated_at) ELSE declined_at END,
  converted_at = CASE WHEN r.status IN ('admitted', 'accepted') AND EXISTS (
    SELECT 1 FROM admission a WHERE a.organization_id = r.organization_id AND a.referral_id = r.id
  ) THEN COALESCE(converted_at, decided_at, updated_at) ELSE converted_at END,
  converted_admission_id = COALESCE(converted_admission_id, (
    SELECT a.id FROM admission a
    WHERE a.organization_id = r.organization_id AND a.referral_id = r.id
    ORDER BY a.created_at
    LIMIT 1
  )),
  patient_resolution_status = CASE
    WHEN r.patient_id IS NOT NULL THEN 'matched'::referral_patient_resolution_status
    ELSE patient_resolution_status
  END,
  _phase1_status_target = CASE
    WHEN r.status::text = 'received' THEN 'received'
    WHEN r.status::text = 'evaluated' THEN 'under_review'
    WHEN r.status::text = 'rejected' THEN 'declined'
    WHEN r.status::text = 'withdrawn' THEN 'withdrawn'
    WHEN r.status::text = 'admitted' THEN 'converted'
    WHEN r.status::text = 'accepted' AND EXISTS (
      SELECT 1 FROM admission a WHERE a.organization_id = r.organization_id AND a.referral_id = r.id
    ) THEN 'converted'
    WHEN r.status::text = 'accepted' THEN 'qualified'
    ELSE 'received'
  END;--> statement-breakpoint
ALTER TABLE "referral" ALTER COLUMN status DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "referral" ALTER COLUMN status TYPE "referral_status_v2"
USING _phase1_status_target::referral_status_v2;--> statement-breakpoint
DROP TYPE "public"."referral_status";--> statement-breakpoint
ALTER TYPE "public"."referral_status_v2" RENAME TO "referral_status";--> statement-breakpoint
ALTER TABLE "referral" ALTER COLUMN status SET DEFAULT 'received';--> statement-breakpoint
ALTER TABLE "referral" DROP COLUMN "_phase1_status_target";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "referral_org_external_referral_uidx"
  ON "referral" ("organization_id", "external_referral_id")
  WHERE external_referral_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "admission_org_referral_once_uidx"
  ON "admission" ("organization_id", "referral_id")
  WHERE referral_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_activity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"(id) ON DELETE RESTRICT,
  "referral_id" uuid NOT NULL REFERENCES "referral"(id) ON DELETE RESTRICT,
  "actor_id" uuid REFERENCES "user"(id) ON DELETE SET NULL,
  "action" text NOT NULL,
  "from_status" text,
  "to_status" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_note" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"(id) ON DELETE RESTRICT,
  "referral_id" uuid NOT NULL REFERENCES "referral"(id) ON DELETE RESTRICT,
  "author_id" uuid REFERENCES "user"(id) ON DELETE SET NULL,
  "content" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_activity_referral_created_idx" ON "referral_activity" ("referral_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_activity_org_created_idx" ON "referral_activity" ("organization_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_note_referral_created_idx" ON "referral_note" ("referral_id", "created_at");--> statement-breakpoint
ALTER TABLE "referral_activity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "referral_activity_org" ON "referral_activity";--> statement-breakpoint
CREATE POLICY "referral_activity_org" ON "referral_activity"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "referral_activity" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "referral_activity" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "referral_note" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "referral_note_org" ON "referral_note";--> statement-breakpoint
CREATE POLICY "referral_note_org" ON "referral_note"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "referral_note" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "referral_note" TO wardenx_admin;--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_referral_activity() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'referral_activity.' || lower(TG_OP),
    'referral_activity',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info',
    CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), ARRAY['metadata']::text[]) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), ARRAY['metadata']::text[]) ELSE NULL END,
    '{}'::jsonb,
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_referral_activity() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_referral_activity" AFTER INSERT OR UPDATE OR DELETE ON referral_activity
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_referral_activity();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_referral_note() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'referral_note.' || lower(TG_OP),
    'referral_note',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info',
    CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), ARRAY['content']::text[]) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), ARRAY['content']::text[]) ELSE NULL END,
    '{}'::jsonb,
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_referral_note() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_referral_note" AFTER INSERT OR UPDATE OR DELETE ON referral_note
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_referral_note();--> statement-breakpoint
