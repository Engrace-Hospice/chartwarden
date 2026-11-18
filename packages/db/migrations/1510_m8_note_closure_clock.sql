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
--     revocation columns; it has no DELETE. Three triggers close what the grants alone leave open (all expand: nothing in the
--     previous release writes these columns or this table): a revoked override can never be un-revoked, an override's subject and
--     grantor must be members of the override's own organization (the FKs are single-column and FK checks bypass RLS), and an
--     encounter's clock is write-once.
--     The free-text reason is typed by a supervisor, so it may hold a name or another identifier: the application screens it for
--     SSN / MBI shapes before the insert, the row trigger scrubs it from the row's audit snapshot, and the catalogued
--     m8.encounter.closure_override_granted event carries the screened text as the only audit copy.
-- Tenancy: both new tables are organization-level configuration or supervisor action with no patient column, so they carry
-- organization_id only (the tenant_sbar_policy precedent, migration 1099). The override reason is the one free-text field and is
-- treated as potentially identifying (see above). The encounter keeps its own three columns.
-- DEV DATABASES: this file was edited in place before it was ever released, so a database that applied an EARLIER copy of 1510 (the
-- runner records the ordinal, not the content) does not have the later pieces (the write-once clock trigger, the override org guard, the
-- board index, the 500-character reason cap). Reset such a database, or hand-apply the missing statements from this file. Nothing
-- released ever carried an earlier copy.
-- Lock behaviour (accepted, not restructured): ADD COLUMN ... CHECK on encounter scans the table once under ACCESS EXCLUSIVE, and
-- each CREATE INDEX (not CONCURRENTLY) holds a SHARE lock for its build (both indexes are partial: they hold only open clocked notes). Both columns are NULL for every existing row and the previous
-- release never writes them, so the change is expand-safe; encounter is small relative to the deploy window and the runner is
-- transactional, so a CONCURRENTLY build (which cannot run in a transaction) would cost more than it saves.
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
-- The supervisor board asks a different question: the ORG's oldest clocked open notes, across every author, newest page last. The
-- index above leads with the author, so that query read every matching note and sorted them all (measured: all 20,000 overdue
-- rows of a 61,000-row table for a 51-row page); this one is ordered by the clock, so the page is the first 51 index entries.
CREATE INDEX "encounter_open_clock_board_idx"
  ON "encounter" ("organization_id", "clock_started_at", "id")
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
  CONSTRAINT "documentation_obligation_override_reason_len"
    CHECK (char_length(btrim("reason")) >= 40 AND char_length("reason") <= 500),
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

-- The override reason is free text a supervisor typed (it may hold an identifier the application screen missed): the row's audit
-- snapshot records it as changed, never as text. The one audit copy is the screened text on m8.encounter.closure_override_granted.
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

-- Hardening the grants cannot express (ADR-0113 D7). SECURITY INVOKER with a pinned search_path (the 1430 shape): the membership
-- reads run under the caller's org RLS, and the explicit organization_id comparison keeps the check true on a connection that
-- bypasses RLS (a membership row of another tenant is neither visible nor equal).
--   * INSERT: the subject and the grantor are members of THIS organization. The two FKs are single-column and an FK check ignores
--     RLS, so without this an application bug could record a grant that names another tenant's membership.
--   * UPDATE: once revoked_at is set the two revocation columns are final (the column-level UPDATE grant alone would let the app
--     role write both back to NULL, which un-revokes a grant); a new revoker must be a member of this organization too.
CREATE OR REPLACE FUNCTION documentation_obligation_override_org_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM membership m WHERE m.id = NEW.subject_membership_id AND m.organization_id = NEW.organization_id)
       OR NOT EXISTS (SELECT 1 FROM membership m WHERE m.id = NEW.granted_by_membership_id AND m.organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'documentation_obligation_override: the subject and the grantor must be members of the override''s organization'
        USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
          OR NEW.revoked_by_membership_id IS DISTINCT FROM OLD.revoked_by_membership_id) THEN
    RAISE EXCEPTION 'documentation_obligation_override: a revoked override cannot be changed'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.revoked_by_membership_id IS NOT NULL
     AND NEW.revoked_by_membership_id IS DISTINCT FROM OLD.revoked_by_membership_id
     AND NOT EXISTS (SELECT 1 FROM membership m WHERE m.id = NEW.revoked_by_membership_id AND m.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'documentation_obligation_override: the revoker must be a member of the override''s organization'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_documentation_obligation_override_org_guard"
  BEFORE INSERT OR UPDATE ON "documentation_obligation_override"
  FOR EACH ROW EXECUTE FUNCTION documentation_obligation_override_org_guard();--> statement-breakpoint

-- The clock is write-once: the only legitimate write is NULL -> value (the stamp), and nothing in the product moves or clears a
-- clock that exists. A rewritten clock would silently move a note's deadline, so the database refuses it for every role. The trigger
-- fires only when an UPDATE names one of the two columns, so ordinary note edits pay nothing.
CREATE OR REPLACE FUNCTION encounter_clock_write_once_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.clock_started_at IS NOT NULL
     AND (NEW.clock_started_at IS DISTINCT FROM OLD.clock_started_at
          OR NEW.clock_start_source IS DISTINCT FROM OLD.clock_start_source) THEN
    RAISE EXCEPTION 'encounter: the visit-note closure clock is write-once and cannot be changed or cleared'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_encounter_clock_write_once"
  BEFORE UPDATE OF "clock_started_at", "clock_start_source" ON "encounter"
  FOR EACH ROW EXECUTE FUNCTION encounter_clock_write_once_guard();--> statement-breakpoint

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
