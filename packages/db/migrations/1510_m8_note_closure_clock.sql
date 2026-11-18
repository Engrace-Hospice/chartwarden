-- compat: expand
-- M8 visit-note closure clock (ADR-0113): the data model for "a clinical note is closed within N hours of arrival".
--   * encounter.clock_started_at / clock_start_source: when the clinician's documentation duty began and which signal said so
--     (EVV check-in, the M17 visit start, the first authoring write on a seeded draft, or the creation of an ad-hoc note).
--     Both set or both null. No backfill: a note that existed before this migration has no clock, raises no alert and never
--     blocks. The deadline is COMPUTED from the clock and the tenant policy on every read; nothing about it is stored.
--   * documentation_obligation_policy: one row per (organization, obligation kind): mode off | warn | block, threshold hours,
--     and enforce_from (set by the service whenever mode moves to block, so notes that are already overdue get a fresh window).
--     An absent row means warn / 24 hours; the default mode is warn because main auto-deploys.
--   * documentation_obligation_override: a supervisor lifts the BLOCK (never the alerts or the deadline) for one clinician and
--     one obligation kind for at most 24 hours. Append-only: the application role can insert and can only stamp the two
--     revocation columns; it has no DELETE. The free-text reason is scrubbed from the audit row.
-- Tenancy: both new tables are organization-level configuration or supervisor action with no patient, so they carry
-- organization_id only (the tenant_sbar_policy precedent, migration 1099); no PHI. The encounter keeps its own three columns.
-- Roles are the post-1139 names (chartwarden_*); migration 1099 predates that rename and says wardenx_*.

CREATE TYPE "public"."encounter_clock_start_source" AS ENUM ('evv_check_in', 'visit_started', 'draft_opened', 'draft_created');--> statement-breakpoint
CREATE TYPE "public"."documentation_obligation_kind" AS ENUM ('visit_note', 'hope_window', 'cti', 'face_to_face');--> statement-breakpoint
CREATE TYPE "public"."documentation_obligation_mode" AS ENUM ('off', 'warn', 'block');--> statement-breakpoint

-- The pair rule rides the second ADD COLUMN as a column constraint: arch:migration-compat reads a table-level ADD CONSTRAINT as
-- contracting, and this one cannot hurt a previous release (it never writes either column, so both stay null).
ALTER TABLE "encounter"
  ADD COLUMN "clock_started_at" timestamptz,
  ADD COLUMN "clock_start_source" "encounter_clock_start_source"
    CONSTRAINT "encounter_clock_start_consistency"
    CHECK (("clock_started_at" IS NULL) = ("clock_start_source" IS NULL));--> statement-breakpoint
-- "The member's oldest clocked open note": the one question the request-time gate and the alert sweep ask SQL; the pure
-- function in 08-encounters/closure decides everything else.
CREATE INDEX "encounter_open_clock_idx"
  ON "encounter" ("organization_id", "authored_by_membership_id", "clock_started_at")
  WHERE status IN ('draft', 'finalized') AND clock_started_at IS NOT NULL;--> statement-breakpoint

CREATE TABLE "documentation_obligation_policy" (
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "obligation_kind" "documentation_obligation_kind" NOT NULL,
  "mode" "documentation_obligation_mode" DEFAULT 'warn' NOT NULL,
  "threshold_hours" integer DEFAULT 24 NOT NULL,
  "enforce_from" timestamptz,
  "configured_by_user_id" uuid NOT NULL REFERENCES "user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "documentation_obligation_policy_pk" PRIMARY KEY ("organization_id", "obligation_kind"),
  CONSTRAINT "documentation_obligation_policy_threshold" CHECK ("threshold_hours" BETWEEN 1 AND 168)
);--> statement-breakpoint

CREATE TABLE "documentation_obligation_override" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "subject_membership_id" uuid NOT NULL REFERENCES "membership"("id") ON DELETE RESTRICT,
  "granted_by_membership_id" uuid NOT NULL REFERENCES "membership"("id") ON DELETE RESTRICT,
  "obligation_kind" "documentation_obligation_kind" NOT NULL,
  "reason" text NOT NULL,
  "granted_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "revoked_by_membership_id" uuid REFERENCES "membership"("id") ON DELETE RESTRICT,
  CONSTRAINT "documentation_obligation_override_reason_len" CHECK (char_length(btrim("reason")) >= 40),
  CONSTRAINT "documentation_obligation_override_expiry_window"
    CHECK ("expires_at" > "granted_at" AND "expires_at" - "granted_at" <= interval '24 hours'),
  CONSTRAINT "documentation_obligation_override_not_self" CHECK ("subject_membership_id" <> "granted_by_membership_id"),
  CONSTRAINT "documentation_obligation_override_revocation_pair"
    CHECK (("revoked_at" IS NULL) = ("revoked_by_membership_id" IS NULL))
);--> statement-breakpoint
-- The gate's lookup: an unrevoked, unexpired override for this clinician and kind. Leads with organization_id, which also
-- covers that FK.
CREATE INDEX "documentation_obligation_override_active_idx"
  ON "documentation_obligation_override" ("organization_id", "subject_membership_id", "obligation_kind", "expires_at")
  WHERE "revoked_at" IS NULL;--> statement-breakpoint

ALTER TABLE "documentation_obligation_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documentation_obligation_policy" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "documentation_obligation_policy_org_isolation" ON "documentation_obligation_policy"
  FOR ALL TO chartwarden_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- The PUT upserts, so INSERT + UPDATE; no DELETE (a tenant resets to the default by writing mode warn / 24).
GRANT SELECT, INSERT, UPDATE ON "documentation_obligation_policy" TO chartwarden_app;--> statement-breakpoint

ALTER TABLE "documentation_obligation_override" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documentation_obligation_override" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "documentation_obligation_override_org_isolation" ON "documentation_obligation_override"
  FOR ALL TO chartwarden_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- Append-only: insert a grant, revoke it by stamping the two revocation columns, never delete.
GRANT SELECT, INSERT ON "documentation_obligation_override" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("revoked_at", "revoked_by_membership_id") ON "documentation_obligation_override" TO chartwarden_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_documentation_obligation_policy() RETURNS trigger
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
ALTER FUNCTION audit_phi_write_documentation_obligation_policy() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_documentation_obligation_policy"
  AFTER INSERT OR UPDATE OR DELETE ON documentation_obligation_policy
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_documentation_obligation_policy();--> statement-breakpoint

-- The override reason is free text a supervisor typed: it is recorded as changed, never as text, in the immutable audit log.
CREATE OR REPLACE FUNCTION audit_phi_write_documentation_obligation_override() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['reason']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME,
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
ALTER FUNCTION audit_phi_write_documentation_obligation_override() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_documentation_obligation_override"
  AFTER INSERT OR UPDATE OR DELETE ON documentation_obligation_override
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_documentation_obligation_override();--> statement-breakpoint

-- Tenant destruction (the 1099 / 1478 pattern): the destruction role may read and delete one organization's rows.
GRANT SELECT, DELETE ON "documentation_obligation_policy" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "documentation_obligation_policy_destruction" ON "documentation_obligation_policy"
  FOR ALL TO chartwarden_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, DELETE ON "documentation_obligation_override" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "documentation_obligation_override_destruction" ON "documentation_obligation_override"
  FOR ALL TO chartwarden_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
