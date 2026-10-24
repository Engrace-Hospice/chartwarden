-- M25 milestone 13a (hospice ADR/TPE/QIC PRD, milestone 13): beneficiary-filed appeals and appointments of representative.
-- RECORD-KEEPING ONLY. No CMS rule is encoded and nothing is seeded as fact:
--
--  * representative_form_version: an organization's own appointment form version, typed by the person who verified it
--    (label, identifier and edition AS ENTERED, a mandatory source note, and the list of required-element labels). With
--    none configured the intake says so; there is no platform default. A version is frozen; edit = retire and add.
--  * representative_appointment: patient-level, always recorded from a claim (the patient and provider entity are
--    resolved from the claim server-side). The instrument is an org form version or "other written instrument" with a
--    note. Every date is TYPED; the validity end is a typed date with a source note (or absent), never computed. It is
--    born a draft; a SECOND membership activates it, and that rule is enforced HERE, atomically with the UPDATE
--    (author <> activator, an active member of this organization, a signed document attached, every element ticked).
--    An appointment grants no portal access, consent or caregiver row (nothing here writes one).
--  * beneficiary_appeal: an appeal the BENEFICIARY or their representative filed and the hospice learned of or supports.
--    Deliberately NOT appeal_case (that aggregate is the hospice's own Medicare chain: NOT NULL denial and computed deadline,
--    one live appeal per tier, auto-spawn). No deadline is computed for it; deadlines are recorded_deadline rows typed from
--    a notice (1241). It never changes an appeal_case or denial_case.
--  * beneficiary_appeal_document / _event: the documents (each pinned to the validated M22 ACTIVE version) and the trail.
--
-- Org scoped (canonical app.org_id RLS, FORCEd, no DELETE for the app role). Closed sets are text + CHECK mirrored in
-- domain/representative.ts and domain/beneficiary-appeal.ts. There is no 'hospice_staff' representative kind: staff may
-- assist (notes and documents) but not act as the representative. Free text is audit-scrubbed. Idempotent.

CREATE TABLE IF NOT EXISTS "representative_form_version" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "label" text NOT NULL CHECK (btrim("label") <> ''),
  "form_identifier" text,
  "edition_text" text,
  "source_note" text NOT NULL CHECK (btrim("source_note") <> ''),
  "verified_on" date,
  "verified_by_membership_id" uuid,
  "required_elements" jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof("required_elements") = 'array' AND jsonb_array_length("required_elements") <= 30),
  "retired_at" timestamptz,
  "created_by_membership_id" uuid,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "representative_form_version_verified_pair" CHECK (("verified_on" IS NULL) = ("verified_by_membership_id" IS NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "representative_form_version_org_ix" ON "representative_form_version" ("organization_id", "created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "representative_appointment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL, -- M5 logical FK, resolved from the claim
  "recorded_from_claim_id" uuid NOT NULL, -- M23 logical FK
  "instrument_kind" text NOT NULL CHECK ("instrument_kind" IN ('org_form','other_written_instrument')),
  "form_version_id" uuid REFERENCES "representative_form_version"("id") ON DELETE RESTRICT,
  "instrument_note" text,
  "representative_name" text NOT NULL CHECK (btrim("representative_name") <> ''), -- audit-scrubbed
  "relationship_label" text, -- audit-scrubbed
  "representative_kind" text NOT NULL CHECK ("representative_kind" IN ('family_or_friend','legal_representative','attorney','other')),
  "beneficiary_signed_on" date,
  "representative_signed_on" date,
  "valid_through_on" date,
  "validity_source_note" text,
  "elements_confirmed" jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof("elements_confirmed") = 'array'),
  "document_id" uuid, -- M22 logical FK
  "document_version_id" uuid, -- the validated ACTIVE version
  "state" text NOT NULL DEFAULT 'draft' CHECK ("state" IN ('draft','active','revoked','superseded')),
  "recorded_by_membership_id" uuid NOT NULL,
  -- Whoever last changed the evidence (name, dates, checklist, signed document). The activator must differ from this person too.
  "last_edited_by_membership_id" uuid NOT NULL,
  "verified_by_membership_id" uuid,
  "verified_at" timestamptz,
  "revoked_on" date,
  "revoked_by_membership_id" uuid,
  "revocation_note" text,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "representative_appointment_form_matches_kind" CHECK (("instrument_kind" = 'org_form') = ("form_version_id" IS NOT NULL)),
  CONSTRAINT "representative_appointment_other_needs_note" CHECK ("instrument_kind" <> 'other_written_instrument' OR ("instrument_note" IS NOT NULL AND btrim("instrument_note") <> '')),
  CONSTRAINT "representative_appointment_kind_other_needs_label" CHECK ("representative_kind" <> 'other' OR ("relationship_label" IS NOT NULL AND btrim("relationship_label") <> '')),
  CONSTRAINT "representative_appointment_validity_pair" CHECK (("valid_through_on" IS NULL) = ("validity_source_note" IS NULL) AND ("validity_source_note" IS NULL OR btrim("validity_source_note") <> '')),
  CONSTRAINT "representative_appointment_document_pair" CHECK (("document_id" IS NULL) = ("document_version_id" IS NULL)),
  -- The activator is a person other than the recorder (the database trigger also decides it atomically on the UPDATE).
  CONSTRAINT "representative_appointment_verifier_not_recorder" CHECK ("verified_by_membership_id" IS NULL OR "verified_by_membership_id" <> "recorded_by_membership_id"),
  CONSTRAINT "representative_appointment_verified_pair" CHECK (("verified_by_membership_id" IS NULL) = ("verified_at" IS NULL)),
  CONSTRAINT "representative_appointment_active_is_verified" CHECK ("state" NOT IN ('active','superseded') OR ("verified_by_membership_id" IS NOT NULL AND "document_id" IS NOT NULL)),
  CONSTRAINT "representative_appointment_revoked_has_record" CHECK ("state" <> 'revoked' OR ("revoked_on" IS NOT NULL AND "revocation_note" IS NOT NULL AND btrim("revocation_note") <> '' AND "revoked_by_membership_id" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_representative_appointment_patient" ON "representative_appointment" ("organization_id", "patient_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_representative_appointment_form" ON "representative_appointment" ("form_version_id") WHERE "form_version_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "beneficiary_appeal" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL,
  "claim_id" uuid NOT NULL, -- M23 logical FK
  "patient_id" uuid NOT NULL, -- resolved from the claim
  "denial_case_id" uuid REFERENCES "denial_case"("id") ON DELETE RESTRICT,
  "filer_kind" text NOT NULL CHECK ("filer_kind" IN ('beneficiary','representative')),
  "representative_appointment_id" uuid REFERENCES "representative_appointment"("id") ON DELETE RESTRICT,
  "tier_label" text NOT NULL CHECK ("tier_label" IN ('redetermination','reconsideration','alj','council','federal_court','other')),
  "filed_on" date,
  "external_reference" text, -- audit-scrubbed
  "source_note" text NOT NULL CHECK (btrim("source_note") <> ''), -- how the hospice learned of it; audit-scrubbed
  "state" text NOT NULL DEFAULT 'recorded' CHECK ("state" IN ('recorded','supporting','decided','closed','withdrawn')),
  "outcome_label" text CHECK ("outcome_label" IS NULL OR "outcome_label" IN ('favorable','partial','unfavorable','dismissed','other')),
  "outcome_note" text, -- audit-scrubbed
  "closed_at" timestamptz,
  "created_by_membership_id" uuid,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "beneficiary_appeal_appointment_only_representative" CHECK ("representative_appointment_id" IS NULL OR "filer_kind" = 'representative'),
  CONSTRAINT "beneficiary_appeal_decided_has_outcome" CHECK ("state" <> 'decided' OR "outcome_label" IS NOT NULL),
  CONSTRAINT "beneficiary_appeal_other_needs_note" CHECK ("outcome_label" IS DISTINCT FROM 'other' OR ("outcome_note" IS NOT NULL AND btrim("outcome_note") <> '')),
  CONSTRAINT "beneficiary_appeal_note_needs_label" CHECK ("outcome_note" IS NULL OR "outcome_label" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_beneficiary_appeal_claim" ON "beneficiary_appeal" ("claim_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_beneficiary_appeal_denial" ON "beneficiary_appeal" ("denial_case_id") WHERE "denial_case_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_beneficiary_appeal_appointment" ON "beneficiary_appeal" ("representative_appointment_id") WHERE "representative_appointment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "beneficiary_appeal_org_ix" ON "beneficiary_appeal" ("organization_id", "created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "beneficiary_appeal_document" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "beneficiary_appeal_id" uuid NOT NULL REFERENCES "beneficiary_appeal"("id") ON DELETE RESTRICT,
  "document_id" uuid NOT NULL, -- M22 logical FK
  "document_version_id" uuid NOT NULL, -- the validated ACTIVE version
  "attached_by_membership_id" uuid,
  "attached_at" timestamptz NOT NULL DEFAULT now(),
  "removed_at" timestamptz
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "beneficiary_appeal_document_live_unique" ON "beneficiary_appeal_document" ("beneficiary_appeal_id", "document_id") WHERE "removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "beneficiary_appeal_document_org_ix" ON "beneficiary_appeal_document" ("organization_id", "attached_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "beneficiary_appeal_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "beneficiary_appeal_id" uuid NOT NULL REFERENCES "beneficiary_appeal"("id") ON DELETE RESTRICT,
  "event_kind" text NOT NULL,
  "event_payload" jsonb, -- ids and counts only
  "actor_membership_id" uuid,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_beneficiary_appeal_event_case" ON "beneficiary_appeal_event" ("beneficiary_appeal_id", "occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "beneficiary_appeal_event_org_ix" ON "beneficiary_appeal_event" ("organization_id", "occurred_at");--> statement-breakpoint

-- Row-level security: canonical app.org_id, FORCEd, one policy per table.
ALTER TABLE "representative_form_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "representative_form_version" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "representative_form_version_org" ON "representative_form_version";--> statement-breakpoint
CREATE POLICY "representative_form_version_org" ON "representative_form_version" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "representative_appointment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "representative_appointment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "representative_appointment_org" ON "representative_appointment";--> statement-breakpoint
CREATE POLICY "representative_appointment_org" ON "representative_appointment" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "beneficiary_appeal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "beneficiary_appeal" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "beneficiary_appeal_org" ON "beneficiary_appeal";--> statement-breakpoint
CREATE POLICY "beneficiary_appeal_org" ON "beneficiary_appeal" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "beneficiary_appeal_document" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "beneficiary_appeal_document" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "beneficiary_appeal_document_org" ON "beneficiary_appeal_document";--> statement-breakpoint
CREATE POLICY "beneficiary_appeal_document_org" ON "beneficiary_appeal_document" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "beneficiary_appeal_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "beneficiary_appeal_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "beneficiary_appeal_event_org" ON "beneficiary_appeal_event";--> statement-breakpoint
CREATE POLICY "beneficiary_appeal_event_org" ON "beneficiary_appeal_event" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- Column-level UPDATE grants: scope, subject and authorship never change after insert; no DELETE for the app role.
GRANT SELECT, INSERT ON "representative_form_version" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("retired_at", "version", "updated_at") ON "representative_form_version" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "representative_form_version" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, INSERT ON "representative_appointment" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("instrument_note", "representative_name", "relationship_label", "representative_kind", "beneficiary_signed_on",
  "representative_signed_on", "valid_through_on", "validity_source_note", "elements_confirmed", "document_id",
  "document_version_id", "state", "verified_by_membership_id", "verified_at", "revoked_on", "revoked_by_membership_id",
  "revocation_note", "last_edited_by_membership_id", "version", "updated_at") ON "representative_appointment" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "representative_appointment" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, INSERT ON "beneficiary_appeal" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("denial_case_id", "filer_kind", "representative_appointment_id", "tier_label", "filed_on", "external_reference",
  "source_note", "state", "outcome_label", "outcome_note", "closed_at", "version", "updated_at") ON "beneficiary_appeal" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "beneficiary_appeal" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, INSERT ON "beneficiary_appeal_document" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("removed_at") ON "beneficiary_appeal_document" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "beneficiary_appeal_document" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, INSERT ON "beneficiary_appeal_event" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "beneficiary_appeal_event" TO chartwarden_admin;--> statement-breakpoint

-- M4 write-audit triggers (the 0084 shape). The representative's name and label, every note and the external reference are scrubbed.
CREATE OR REPLACE FUNCTION audit_phi_write_representative_form_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['label','form_identifier','edition_text','source_note'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'representative_form_version.' || lower(TG_OP), 'representative_form_version', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_representative_form_version() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_representative_form_version" ON representative_form_version;--> statement-breakpoint
CREATE TRIGGER "trg_audit_representative_form_version" AFTER INSERT OR UPDATE OR DELETE ON representative_form_version FOR EACH ROW EXECUTE FUNCTION audit_phi_write_representative_form_version();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_representative_appointment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['representative_name','relationship_label','instrument_note','validity_source_note','revocation_note'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'representative_appointment.' || lower(TG_OP), 'representative_appointment', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_representative_appointment() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_representative_appointment" ON representative_appointment;--> statement-breakpoint
CREATE TRIGGER "trg_audit_representative_appointment" AFTER INSERT OR UPDATE OR DELETE ON representative_appointment FOR EACH ROW EXECUTE FUNCTION audit_phi_write_representative_appointment();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_beneficiary_appeal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['external_reference','source_note','outcome_note'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'beneficiary_appeal.' || lower(TG_OP), 'beneficiary_appeal', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_beneficiary_appeal() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_beneficiary_appeal" ON beneficiary_appeal;--> statement-breakpoint
CREATE TRIGGER "trg_audit_beneficiary_appeal" AFTER INSERT OR UPDATE OR DELETE ON beneficiary_appeal FOR EACH ROW EXECUTE FUNCTION audit_phi_write_beneficiary_appeal();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_beneficiary_appeal_document() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'beneficiary_appeal_document.' || lower(TG_OP), 'beneficiary_appeal_document', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_beneficiary_appeal_document() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_beneficiary_appeal_document" ON beneficiary_appeal_document;--> statement-breakpoint
CREATE TRIGGER "trg_audit_beneficiary_appeal_document" AFTER INSERT OR UPDATE OR DELETE ON beneficiary_appeal_document FOR EACH ROW EXECUTE FUNCTION audit_phi_write_beneficiary_appeal_document();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_beneficiary_appeal_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['event_payload'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'beneficiary_appeal_event.' || lower(TG_OP), 'beneficiary_appeal_event', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_beneficiary_appeal_event() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_beneficiary_appeal_event" ON beneficiary_appeal_event;--> statement-breakpoint
CREATE TRIGGER "trg_audit_beneficiary_appeal_event" AFTER INSERT OR UPDATE OR DELETE ON beneficiary_appeal_event FOR EACH ROW EXECUTE FUNCTION audit_phi_write_beneficiary_appeal_event();--> statement-breakpoint

-- A form version is frozen once written; only retiring it changes it (edit = retire and add a new one).
CREATE OR REPLACE FUNCTION m25_representative_form_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'M25_REP_FORM_FROZEN: representative_form_version % is retired and cannot change', OLD.id;
    END IF;
    IF NEW.retired_at IS NULL THEN
      RAISE EXCEPTION 'M25_REP_FORM_FROZEN: representative_form_version % can only be retired, not edited', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_representative_form_version_guard" ON representative_form_version;--> statement-breakpoint
CREATE TRIGGER "trg_representative_form_version_guard" BEFORE UPDATE ON representative_form_version FOR EACH ROW EXECUTE FUNCTION m25_representative_form_version_guard();--> statement-breakpoint

-- An appointment is born a draft. Activation is decided HERE, atomically with the UPDATE (the row is locked by it): a person
-- other than the recorder, an active membership of this organization, a signed document attached, every element ticked.
-- An app-side read-then-write check could be raced; this cannot (a concurrent second activation finds the row active and hits
-- the frozen branch). Once active, only revocation may follow; a revoked or superseded appointment never changes.
CREATE OR REPLACE FUNCTION m25_representative_appointment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_form record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'draft' THEN
      RAISE EXCEPTION 'M25_REP_BORN_DRAFT: an appointment is recorded as a draft and activated by a second person';
    END IF;
    IF NEW.last_edited_by_membership_id IS DISTINCT FROM NEW.recorded_by_membership_id THEN
      RAISE EXCEPTION 'M25_REP_EDITOR: a new draft is last edited by the person who recorded it';
    END IF;
    IF NEW.form_version_id IS NOT NULL THEN
      SELECT retired_at, jsonb_array_length(required_elements) AS n INTO v_form
        FROM representative_form_version WHERE id = NEW.form_version_id AND organization_id = NEW.organization_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'M25_REP_FORM_PARENT: representative_form_version % is not visible to this organization', NEW.form_version_id;
      END IF;
      IF v_form.retired_at IS NOT NULL THEN
        RAISE EXCEPTION 'M25_REP_FORM_RETIRED: representative_form_version % is retired', NEW.form_version_id;
      END IF;
      IF jsonb_array_length(NEW.elements_confirmed) <> v_form.n THEN
        RAISE EXCEPTION 'M25_REP_ELEMENTS_SNAPSHOT: the element checklist must list every element of the form version';
      END IF;
    ELSIF jsonb_array_length(NEW.elements_confirmed) <> 0 THEN
      RAISE EXCEPTION 'M25_REP_ELEMENTS_SNAPSHOT: only an org form version carries an element checklist';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state IN ('revoked','superseded') THEN
    RAISE EXCEPTION 'M25_REP_FROZEN: representative_appointment % is % and cannot change', OLD.id, OLD.state;
  END IF;
  IF OLD.state = 'active' THEN
    IF NEW.state <> 'revoked'
       OR NEW.instrument_note IS DISTINCT FROM OLD.instrument_note
       OR NEW.representative_name IS DISTINCT FROM OLD.representative_name
       OR NEW.relationship_label IS DISTINCT FROM OLD.relationship_label
       OR NEW.representative_kind IS DISTINCT FROM OLD.representative_kind
       OR NEW.beneficiary_signed_on IS DISTINCT FROM OLD.beneficiary_signed_on
       OR NEW.representative_signed_on IS DISTINCT FROM OLD.representative_signed_on
       OR NEW.valid_through_on IS DISTINCT FROM OLD.valid_through_on
       OR NEW.validity_source_note IS DISTINCT FROM OLD.validity_source_note
       OR NEW.elements_confirmed IS DISTINCT FROM OLD.elements_confirmed
       OR NEW.document_id IS DISTINCT FROM OLD.document_id
       OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id
       OR NEW.verified_by_membership_id IS DISTINCT FROM OLD.verified_by_membership_id
       OR NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
      RAISE EXCEPTION 'M25_REP_FROZEN: representative_appointment % is active; only revoking it is allowed', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  -- OLD is a draft.
  IF NEW.state = 'active' THEN
    IF NEW.verified_by_membership_id IS NULL OR NEW.verified_by_membership_id = OLD.recorded_by_membership_id THEN
      RAISE EXCEPTION 'M25_REP_VERIFIER: an appointment is activated by a person other than the one who recorded it';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM membership m WHERE m.id = NEW.verified_by_membership_id AND m.organization_id = OLD.organization_id AND m.status = 'active') THEN
      RAISE EXCEPTION 'M25_REP_VERIFIER: the verifier is not an active member of this organization';
    END IF;
    -- Compare PEOPLE, not membership rows: one user with two membership rows (e.g. a revoked and a re-issued one) is one person.
    IF EXISTS (
      SELECT 1 FROM membership v JOIN membership r ON r.id = OLD.recorded_by_membership_id
       WHERE v.id = NEW.verified_by_membership_id AND v.user_id = r.user_id) THEN
      RAISE EXCEPTION 'M25_REP_VERIFIER: an appointment is activated by a different person (user) than the one who recorded it';
    END IF;
    -- The activator also must not be the person who last changed the evidence (name, dates, checklist, signed document).
    IF EXISTS (
      SELECT 1 FROM membership v JOIN membership e ON e.id = NEW.last_edited_by_membership_id
       WHERE v.id = NEW.verified_by_membership_id AND v.user_id = e.user_id) THEN
      RAISE EXCEPTION 'M25_REP_VERIFIER: an appointment is activated by someone other than the person who last edited it';
    END IF;
    IF NEW.document_id IS NULL OR NEW.document_version_id IS NULL THEN
      RAISE EXCEPTION 'M25_REP_NO_DOCUMENT: attach the signed appointment document before activating';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.elements_confirmed) e WHERE e->>'state' IS DISTINCT FROM 'confirmed') THEN
      RAISE EXCEPTION 'M25_REP_ELEMENTS_INCOMPLETE: every required element must be confirmed before activating';
    END IF;
  ELSIF NEW.state NOT IN ('draft','revoked') THEN
    RAISE EXCEPTION 'M25_REP_TRANSITION: a draft appointment can only be activated or revoked';
  END IF;
  -- The checklist labels are the form version's at the time the draft was written; only their ticks may change.
  IF (SELECT coalesce(jsonb_agg(e->'label'), '[]'::jsonb) FROM jsonb_array_elements(NEW.elements_confirmed) e)
     IS DISTINCT FROM (SELECT coalesce(jsonb_agg(e->'label'), '[]'::jsonb) FROM jsonb_array_elements(OLD.elements_confirmed) e) THEN
    RAISE EXCEPTION 'M25_REP_ELEMENTS_SNAPSHOT: the element labels of an appointment cannot change';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_representative_appointment_guard" ON representative_appointment;--> statement-breakpoint
CREATE TRIGGER "trg_representative_appointment_guard" BEFORE INSERT OR UPDATE ON representative_appointment FOR EACH ROW EXECUTE FUNCTION m25_representative_appointment_guard();--> statement-breakpoint

-- A beneficiary appeal: the denial (when linked) must be this organization's and on the same claim; the appointment (when
-- linked) must be this organization's and the same patient (RLS hides another tenant's rows, so a cross-tenant id fails
-- closed). A closed or withdrawn appeal is frozen. It never touches appeal_case or denial_case.
CREATE OR REPLACE FUNCTION m25_beneficiary_appeal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_claim uuid; v_patient uuid; v_astate text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.state IN ('closed','withdrawn') THEN
    RAISE EXCEPTION 'M25_BENEFICIARY_APPEAL_TERMINAL_IMMUTABLE: beneficiary_appeal % is % and cannot be modified', OLD.id, OLD.state;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.state <> 'recorded' THEN
    RAISE EXCEPTION 'M25_BENEFICIARY_APPEAL_BORN_RECORDED: a beneficiary appeal is recorded first and moved afterwards';
  END IF;
  IF NEW.denial_case_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.denial_case_id IS DISTINCT FROM OLD.denial_case_id) THEN
    SELECT claim_id INTO v_claim FROM denial_case WHERE id = NEW.denial_case_id AND organization_id = NEW.organization_id;
    IF NOT FOUND OR v_claim IS DISTINCT FROM NEW.claim_id THEN
      RAISE EXCEPTION 'M25_BENEFICIARY_APPEAL_DENIAL: the denial is not visible to this organization or belongs to another claim';
    END IF;
  END IF;
  IF NEW.representative_appointment_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.representative_appointment_id IS DISTINCT FROM OLD.representative_appointment_id) THEN
    SELECT patient_id, state INTO v_patient, v_astate FROM representative_appointment
      WHERE id = NEW.representative_appointment_id AND organization_id = NEW.organization_id;
    IF NOT FOUND OR v_patient IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'M25_BENEFICIARY_APPEAL_APPOINTMENT: the appointment is not visible to this organization or is another patient''s';
    END IF;
    -- A NEW link needs an ACTIVE appointment (existing links keep showing their derived status).
    IF v_astate <> 'active' THEN
      RAISE EXCEPTION 'M25_BENEFICIARY_APPEAL_APPOINTMENT_STATE: only an active appointment can be linked to a beneficiary appeal';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_beneficiary_appeal_guard" ON beneficiary_appeal;--> statement-breakpoint
CREATE TRIGGER "trg_beneficiary_appeal_guard" BEFORE INSERT OR UPDATE ON beneficiary_appeal FOR EACH ROW EXECUTE FUNCTION m25_beneficiary_appeal_guard();--> statement-breakpoint

-- A document hangs under a live (not closed / withdrawn) beneficiary appeal of this organization.
CREATE OR REPLACE FUNCTION m25_beneficiary_appeal_document_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  SELECT state INTO v_state FROM beneficiary_appeal WHERE id = NEW.beneficiary_appeal_id AND organization_id = NEW.organization_id FOR SHARE;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'M25_BENEFICIARY_DOCUMENT_PARENT: beneficiary_appeal % is not visible to this organization', NEW.beneficiary_appeal_id;
  END IF;
  IF v_state IN ('closed','withdrawn') THEN
    RAISE EXCEPTION 'M25_BENEFICIARY_APPEAL_TERMINAL_IMMUTABLE: beneficiary_appeal % is % and its documents cannot change', NEW.beneficiary_appeal_id, v_state;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_beneficiary_appeal_document_guard" ON beneficiary_appeal_document;--> statement-breakpoint
CREATE TRIGGER "trg_beneficiary_appeal_document_guard" BEFORE INSERT OR UPDATE ON beneficiary_appeal_document FOR EACH ROW EXECUTE FUNCTION m25_beneficiary_appeal_document_guard();--> statement-breakpoint

-- Permissions. beneficiary_appeal.read / .manage: see and record an appeal the beneficiary filed. representative.read /
-- .manage: see and draft an appointment; representative.verify: the SECOND person who activates (or revokes) it, step-up gated.
-- representative_form.configure: the organization's own appointment form versions (org config). Full-catalog roles
-- receive every non-platform key from the template materializer; existing tenants' roles get them from 1242.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('beneficiary_appeal.read', 'beneficiary_appeal', 'read', 'billing', 'provider_entity_scope', ''),
  ('beneficiary_appeal.manage', 'beneficiary_appeal', 'manage', 'billing', 'provider_entity_scope', ''),
  ('representative.read', 'representative_appointment', 'read', 'billing', 'provider_entity_scope', ''),
  ('representative.manage', 'representative_appointment', 'manage', 'billing', 'provider_entity_scope', ''),
  ('representative.verify', 'representative_appointment', 'verify', 'billing', 'provider_entity_scope', ''),
  ('representative_form.configure', 'representative_form_version', 'configure', 'billing', 'inOrg', '')
ON CONFLICT ("key") DO NOTHING;
