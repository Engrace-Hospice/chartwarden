-- M6 milestone 10a (hospice ADR/TPE/QIC appeals PRD, milestone 10): NOMNC delivery and BFCC-QIO expedited-review
-- record-keeping. Three M6-owned tables, NO rule encoded:
--
--  * nomnc_notice       who delivered which Notice of Medicare Non-Coverage, when, to whom, as the staff member typed it
--                       (ADR-0015 D5; M06-F09). Hangs off `admission` (the notice precedes `discharge_event`). Versioned by
--                       supersession: one ACTIVE notice per admission.
--  * expedited_review   the BFCC-QIO fast-track case for a notice (0..1 per notice): QIO identity as typed, when the QIO told
--                       the hospice, DENC / records-sent facts, and the decision as a LABEL.
--  * expedited_deadline a deadline a person types FROM the notice or the QIO's call, to the MINUTE (local date AND time, no
--                       default, mandatory source note). `due_at` is the instant in the org zone at write time; `due_local`
--                       echoes exactly what was typed. M25 `recorded_deadline` is date-only and is deliberately not reused.
--
-- No computed column: deadline status, "next deadline" and every prompt are derived on read. Closed sets are text + CHECK
-- (no pgEnum: enums are irreversible) mirrored in 06-admission/nomnc/domain.ts; none implies a CMS rule. Org scoped
-- (canonical app.org_id RLS, FORCEd, no DELETE for the app role). Idempotent (the 1116/1117 renumber lesson).

CREATE TABLE IF NOT EXISTS "nomnc_notice" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "patient_id" uuid NOT NULL,
  "admission_id" uuid NOT NULL REFERENCES "admission"("id") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active','superseded','withdrawn')),
  -- The last covered day AS PRINTED on the notice, typed.
  "services_end_on" date NOT NULL,
  "delivered_at" timestamptz NOT NULL,
  "delivered_by_user_id" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "recipient_kind" text NOT NULL CHECK ("recipient_kind" IN ('beneficiary','representative')),
  "representative_name" text,
  "delivery_note" text,
  "acknowledgement_kind" text CHECK ("acknowledgement_kind" IN ('signed','refused','other')),
  "acknowledgement_note" text,
  "document_id" uuid, -- M22 logical FK (a scanned copy of the notice as delivered); NULL shows a prompt
  "source_note" text NOT NULL CHECK (btrim("source_note") <> ''),
  -- DEFERRED: a supersession marks the old row (pointing at the new id) before the new row is inserted, in one transaction
  -- (the one-active partial unique index forbids inserting the new row first).
  "superseded_by_id" uuid REFERENCES "nomnc_notice"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  "withdrawn_reason" text,
  "created_by_user_id" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "nomnc_notice_representative_named" CHECK ("recipient_kind" <> 'representative' OR (
    "representative_name" IS NOT NULL AND btrim("representative_name") <> '')),
  CONSTRAINT "nomnc_notice_ack_note_needed" CHECK ("acknowledgement_kind" IS NULL OR "acknowledgement_kind" = 'signed' OR (
    "acknowledgement_note" IS NOT NULL AND btrim("acknowledgement_note") <> '')),
  CONSTRAINT "nomnc_notice_withdrawn_reason" CHECK ("status" <> 'withdrawn' OR (
    "withdrawn_reason" IS NOT NULL AND btrim("withdrawn_reason") <> '')),
  CONSTRAINT "nomnc_notice_superseded_shape" CHECK (("status" = 'superseded') = ("superseded_by_id" IS NOT NULL))
);--> statement-breakpoint
-- One ACTIVE notice per admission.
CREATE UNIQUE INDEX IF NOT EXISTS "nomnc_notice_one_active_uq" ON "nomnc_notice" ("admission_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nomnc_notice_org_admission_idx" ON "nomnc_notice" ("organization_id", "admission_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nomnc_notice_superseded_by_idx" ON "nomnc_notice" ("superseded_by_id") WHERE "superseded_by_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nomnc_notice_provider_entity_idx" ON "nomnc_notice" ("provider_entity_id") WHERE "provider_entity_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nomnc_notice_location_idx" ON "nomnc_notice" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nomnc_notice_delivered_by_idx" ON "nomnc_notice" ("delivered_by_user_id") WHERE "delivered_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nomnc_notice_created_by_idx" ON "nomnc_notice" ("created_by_user_id") WHERE "created_by_user_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "expedited_review" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "patient_id" uuid NOT NULL,
  "admission_id" uuid NOT NULL REFERENCES "admission"("id") ON DELETE RESTRICT,
  "nomnc_notice_id" uuid NOT NULL REFERENCES "nomnc_notice"("id") ON DELETE RESTRICT,
  "state" text NOT NULL DEFAULT 'open' CHECK ("state" IN ('open','decided','withdrawn')),
  -- BFCC-QIO identity AS TYPED per review (no directory is seeded).
  "qio_name" text NOT NULL CHECK (btrim("qio_name") <> ''),
  "qio_reference" text,
  "qio_notified_at" timestamptz NOT NULL,
  "requested_by_kind" text NOT NULL CHECK ("requested_by_kind" IN ('beneficiary','representative','unknown')),
  "denc_delivered_at" timestamptz,
  "denc_document_id" uuid, -- M22 logical FK
  "records_sent_at" timestamptz,
  "records_sent_note" text,
  "decision_outcome" text CHECK ("decision_outcome" IN ('discharge_upheld','discharge_reversed','other')),
  "decision_received_at" timestamptz,
  "decision_note" text,
  "decision_document_id" uuid, -- M22 logical FK
  "created_by_user_id" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "expedited_review_one_per_notice" UNIQUE ("nomnc_notice_id"),
  CONSTRAINT "expedited_review_decided_shape" CHECK ("state" <> 'decided' OR ("decision_outcome" IS NOT NULL AND "decision_received_at" IS NOT NULL)),
  CONSTRAINT "expedited_review_outcome_only_when_decided" CHECK ("state" = 'decided' OR "decision_outcome" IS NULL),
  CONSTRAINT "expedited_review_other_needs_note" CHECK ("decision_outcome" IS DISTINCT FROM 'other' OR (
    "decision_note" IS NOT NULL AND btrim("decision_note") <> ''))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expedited_review_org_admission_idx" ON "expedited_review" ("organization_id", "admission_id");--> statement-breakpoint
-- The hub bucket: open reviews of an org.
CREATE INDEX IF NOT EXISTS "expedited_review_open_idx" ON "expedited_review" ("organization_id", "qio_notified_at") WHERE "state" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expedited_review_admission_idx" ON "expedited_review" ("admission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expedited_review_provider_entity_idx" ON "expedited_review" ("provider_entity_id") WHERE "provider_entity_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expedited_review_location_idx" ON "expedited_review" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expedited_review_created_by_idx" ON "expedited_review" ("created_by_user_id") WHERE "created_by_user_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "expedited_deadline" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "patient_id" uuid NOT NULL,
  "admission_id" uuid NOT NULL REFERENCES "admission"("id") ON DELETE RESTRICT,
  -- Exactly one subject.
  "nomnc_notice_id" uuid REFERENCES "nomnc_notice"("id") ON DELETE RESTRICT,
  "expedited_review_id" uuid REFERENCES "expedited_review"("id") ON DELETE RESTRICT,
  "kind" text NOT NULL CHECK ("kind" IN ('appeal_request','denc_delivery','records_to_qio','qio_decision','other')),
  "label" text,
  -- The instant, in the org zone at write time, to the minute; `due_local` is what the person typed (YYYY-MM-DDTHH:MM).
  "due_at" timestamptz NOT NULL,
  "due_local" text NOT NULL CHECK ("due_local" ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  "zone" text NOT NULL CHECK (btrim("zone") <> ''),
  -- Where the date and time came from (the notice, the QIO's call). Mandatory: an untraceable deadline is not recorded.
  "source_note" text NOT NULL CHECK (btrim("source_note") <> ''),
  "notice_document_id" uuid, -- M22 logical FK
  "satisfied_at" timestamptz,
  "last_alerted_boundary_hours" integer CHECK ("last_alerted_boundary_hours" IS NULL OR "last_alerted_boundary_hours" > 0),
  "overdue_alerted_at" timestamptz,
  "created_by_membership_id" uuid,
  "created_by_user_id" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "expedited_deadline_one_subject" CHECK (num_nonnulls("nomnc_notice_id","expedited_review_id") = 1),
  CONSTRAINT "expedited_deadline_kind_matches_subject" CHECK (
    ("nomnc_notice_id" IS NOT NULL AND "kind" IN ('appeal_request','other'))
    OR ("expedited_review_id" IS NOT NULL AND "kind" IN ('denc_delivery','records_to_qio','qio_decision','other'))),
  CONSTRAINT "expedited_deadline_other_needs_label" CHECK ("kind" <> 'other' OR ("label" IS NOT NULL AND btrim("label") <> ''))
);--> statement-breakpoint
-- One unsatisfied deadline per (subject, kind), except `other`.
CREATE UNIQUE INDEX IF NOT EXISTS "expedited_deadline_notice_kind_uq" ON "expedited_deadline" ("nomnc_notice_id", "kind")
  WHERE "nomnc_notice_id" IS NOT NULL AND "satisfied_at" IS NULL AND "kind" <> 'other';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "expedited_deadline_review_kind_uq" ON "expedited_deadline" ("expedited_review_id", "kind")
  WHERE "expedited_review_id" IS NOT NULL AND "satisfied_at" IS NULL AND "kind" <> 'other';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expedited_deadline_admission_idx" ON "expedited_deadline" ("organization_id", "admission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expedited_deadline_notice_idx" ON "expedited_deadline" ("nomnc_notice_id") WHERE "nomnc_notice_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expedited_deadline_review_idx" ON "expedited_deadline" ("expedited_review_id") WHERE "expedited_review_id" IS NOT NULL;--> statement-breakpoint
-- The 15-minute scan reads the unsatisfied deadlines of an org, soonest first.
CREATE INDEX IF NOT EXISTS "expedited_deadline_open_idx" ON "expedited_deadline" ("organization_id", "due_at") WHERE "satisfied_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expedited_deadline_provider_entity_idx" ON "expedited_deadline" ("provider_entity_id") WHERE "provider_entity_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expedited_deadline_location_idx" ON "expedited_deadline" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expedited_deadline_created_by_idx" ON "expedited_deadline" ("created_by_user_id") WHERE "created_by_user_id" IS NOT NULL;--> statement-breakpoint

-- RLS (canonical app.org_id), FORCEd.
ALTER TABLE "nomnc_notice" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "nomnc_notice" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "nomnc_notice_org" ON "nomnc_notice";--> statement-breakpoint
CREATE POLICY "nomnc_notice_org" ON "nomnc_notice" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "expedited_review" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "expedited_review" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "expedited_review_org" ON "expedited_review";--> statement-breakpoint
CREATE POLICY "expedited_review_org" ON "expedited_review" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "expedited_deadline" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "expedited_deadline" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "expedited_deadline_org" ON "expedited_deadline";--> statement-breakpoint
CREATE POLICY "expedited_deadline_org" ON "expedited_deadline" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- No DELETE for the app role: a notice, a review and a deadline are part of the record. Identity columns (org, admission,
-- patient, subject, kind) never change after insert.
GRANT SELECT, INSERT ON "nomnc_notice" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("status", "services_end_on", "delivered_at", "delivered_by_user_id", "recipient_kind", "representative_name",
  "delivery_note", "acknowledgement_kind", "acknowledgement_note", "document_id", "source_note", "superseded_by_id",
  "withdrawn_reason", "version", "updated_at") ON "nomnc_notice" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "nomnc_notice" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, INSERT ON "expedited_review" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("state", "qio_name", "qio_reference", "qio_notified_at", "requested_by_kind", "denc_delivered_at",
  "denc_document_id", "records_sent_at", "records_sent_note", "decision_outcome", "decision_received_at", "decision_note",
  "decision_document_id", "version", "updated_at") ON "expedited_review" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "expedited_review" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, INSERT ON "expedited_deadline" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("label", "due_at", "due_local", "zone", "source_note", "notice_document_id", "satisfied_at",
  "last_alerted_boundary_hours", "overdue_alerted_at", "version", "updated_at") ON "expedited_deadline" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "expedited_deadline" TO chartwarden_admin;--> statement-breakpoint

-- M4 write-audit triggers (the 0084 shape). The representative's name and every free-text note are scrubbed.
CREATE OR REPLACE FUNCTION audit_phi_write_nomnc_notice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), ARRAY['representative_name','delivery_note','acknowledgement_note','withdrawn_reason','source_note']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), ARRAY['representative_name','delivery_note','acknowledgement_note','withdrawn_reason','source_note']::text[]) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'nomnc_notice.' || lower(TG_OP), 'nomnc_notice', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_nomnc_notice() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_nomnc_notice" ON nomnc_notice;--> statement-breakpoint
CREATE TRIGGER "trg_audit_nomnc_notice" AFTER INSERT OR UPDATE OR DELETE ON nomnc_notice
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_nomnc_notice();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_expedited_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), ARRAY['qio_name','qio_reference','records_sent_note','decision_note']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), ARRAY['qio_name','qio_reference','records_sent_note','decision_note']::text[]) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'expedited_review.' || lower(TG_OP), 'expedited_review', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_expedited_review() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_expedited_review" ON expedited_review;--> statement-breakpoint
CREATE TRIGGER "trg_audit_expedited_review" AFTER INSERT OR UPDATE OR DELETE ON expedited_review
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_expedited_review();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_expedited_deadline() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), ARRAY['label','source_note']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), ARRAY['label','source_note']::text[]) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'expedited_deadline.' || lower(TG_OP), 'expedited_deadline', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_expedited_deadline() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_expedited_deadline" ON expedited_deadline;--> statement-breakpoint
CREATE TRIGGER "trg_audit_expedited_deadline" AFTER INSERT OR UPDATE OR DELETE ON expedited_deadline
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_expedited_deadline();--> statement-breakpoint

-- nomnc_notice: the admission must be visible to this organization and the patient must be the admission's (a FK alone
-- checks as the table owner, so a cross-tenant admission_id would pass it; RLS hides the foreign row here and fails closed).
CREATE OR REPLACE FUNCTION m6_nomnc_notice_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_patient uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT patient_id INTO v_patient FROM admission WHERE id = NEW.admission_id AND organization_id = NEW.organization_id;
    IF v_patient IS NULL THEN
      RAISE EXCEPTION 'M6_NOMNC_PARENT: admission % is not visible to this organization', NEW.admission_id;
    END IF;
    IF v_patient <> NEW.patient_id THEN
      RAISE EXCEPTION 'M6_NOMNC_PATIENT: patient does not match admission %', NEW.admission_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_nomnc_notice_guard" ON nomnc_notice;--> statement-breakpoint
CREATE TRIGGER "trg_nomnc_notice_guard" BEFORE INSERT ON nomnc_notice FOR EACH ROW EXECUTE FUNCTION m6_nomnc_notice_guard();--> statement-breakpoint

-- expedited_review: the notice must be visible to this organization and ACTIVE when the review opens; the review carries
-- the notice's admission / patient; once decided or withdrawn only the document links (and bookkeeping) may change.
CREATE OR REPLACE FUNCTION m6_expedited_review_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_adm uuid; v_patient uuid; v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT admission_id, patient_id, status INTO v_adm, v_patient, v_status FROM nomnc_notice
      WHERE id = NEW.nomnc_notice_id AND organization_id = NEW.organization_id;
    IF v_adm IS NULL THEN
      RAISE EXCEPTION 'M6_EXPEDITED_REVIEW_PARENT: nomnc_notice % is not visible to this organization', NEW.nomnc_notice_id;
    END IF;
    IF v_adm <> NEW.admission_id OR v_patient <> NEW.patient_id THEN
      RAISE EXCEPTION 'M6_EXPEDITED_REVIEW_ADMISSION: admission / patient do not match nomnc_notice %', NEW.nomnc_notice_id;
    END IF;
    IF v_status <> 'active' THEN
      RAISE EXCEPTION 'M6_EXPEDITED_REVIEW_NOTICE_NOT_ACTIVE: nomnc_notice % is %', NEW.nomnc_notice_id, v_status;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state <> 'open' AND (
       NEW.state IS DISTINCT FROM OLD.state
    OR NEW.qio_name IS DISTINCT FROM OLD.qio_name
    OR NEW.qio_reference IS DISTINCT FROM OLD.qio_reference
    OR NEW.qio_notified_at IS DISTINCT FROM OLD.qio_notified_at
    OR NEW.requested_by_kind IS DISTINCT FROM OLD.requested_by_kind
    OR NEW.denc_delivered_at IS DISTINCT FROM OLD.denc_delivered_at
    OR NEW.records_sent_at IS DISTINCT FROM OLD.records_sent_at
    OR NEW.records_sent_note IS DISTINCT FROM OLD.records_sent_note
    OR NEW.decision_outcome IS DISTINCT FROM OLD.decision_outcome
    OR NEW.decision_received_at IS DISTINCT FROM OLD.decision_received_at
    OR NEW.decision_note IS DISTINCT FROM OLD.decision_note) THEN
    RAISE EXCEPTION 'M6_EXPEDITED_REVIEW_FROZEN: expedited_review % is % and cannot change (document links aside)', OLD.id, OLD.state;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_expedited_review_guard" ON expedited_review;--> statement-breakpoint
CREATE TRIGGER "trg_expedited_review_guard" BEFORE INSERT OR UPDATE ON expedited_review FOR EACH ROW EXECUTE FUNCTION m6_expedited_review_guard();--> statement-breakpoint

-- expedited_deadline: the subject must be visible to this organization and carry the same admission (cross-tenant ids
-- fail closed); once satisfied the deadline is frozen except for the alert bookkeeping.
CREATE OR REPLACE FUNCTION m6_expedited_deadline_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_adm uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.nomnc_notice_id IS NOT NULL THEN
      SELECT admission_id INTO v_adm FROM nomnc_notice WHERE id = NEW.nomnc_notice_id AND organization_id = NEW.organization_id;
    ELSE
      SELECT admission_id INTO v_adm FROM expedited_review WHERE id = NEW.expedited_review_id AND organization_id = NEW.organization_id;
    END IF;
    IF v_adm IS NULL THEN
      RAISE EXCEPTION 'M6_EXPEDITED_DEADLINE_PARENT: the subject is not visible to this organization';
    END IF;
    IF v_adm <> NEW.admission_id THEN
      RAISE EXCEPTION 'M6_EXPEDITED_DEADLINE_ADMISSION: admission does not match the subject';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.satisfied_at IS NOT NULL AND (
       NEW.label IS DISTINCT FROM OLD.label
    OR NEW.due_at IS DISTINCT FROM OLD.due_at
    OR NEW.due_local IS DISTINCT FROM OLD.due_local
    OR NEW.zone IS DISTINCT FROM OLD.zone
    OR NEW.source_note IS DISTINCT FROM OLD.source_note
    OR NEW.notice_document_id IS DISTINCT FROM OLD.notice_document_id
    OR NEW.satisfied_at IS DISTINCT FROM OLD.satisfied_at) THEN
    RAISE EXCEPTION 'M6_EXPEDITED_DEADLINE_FROZEN: expedited_deadline % is satisfied and cannot change', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_expedited_deadline_guard" ON expedited_deadline;--> statement-breakpoint
CREATE TRIGGER "trg_expedited_deadline_guard" BEFORE INSERT OR UPDATE ON expedited_deadline FOR EACH ROW EXECUTE FUNCTION m6_expedited_deadline_guard();--> statement-breakpoint

-- nomnc.read / nomnc.record: catalogue the keys in the `permission` mirror and grant them, in the same migration, to the
-- roles that already hold the counterpart (the 0382 pattern). Nobody gains anything they could not already reach:
--   admission.read                                     -> nomnc.read
--   discharge.no_longer_terminal | discharge.for_cause -> nomnc.record  (the roles that record those live discharges)
-- Idempotent; never removes a grant.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('nomnc.read', 'nomnc', 'read', 'clinical', 'admission.scope', ''),
  ('nomnc.record', 'nomnc', 'record', 'clinical', 'admission.scope', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", m.new_key
  FROM "role_permission" rp
  JOIN (VALUES
    ('admission.read', 'nomnc.read'),
    ('discharge.no_longer_terminal', 'nomnc.record'),
    ('discharge.for_cause', 'nomnc.record')
  ) AS m(old_key, new_key) ON m.old_key = rp."permission_key"
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
