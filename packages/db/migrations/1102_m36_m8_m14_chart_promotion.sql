-- M36 WP 3.7 - chart promotion (ADR-0063). A clinician PROPOSES that a secure message belongs in the chart. The proposal is a
-- thin pointer: ids, a status, who wrote the message and when, and a SHA-256 of the body at request time. No text and no
-- copy of the message is stored; the text is re-read (and checked against the hash) when a reviewer opens it. Nothing
-- reaches the chart until a reviewer acts in the owning module: an M8 addendum they author and sign, or an M14 agenda item a
-- coordinator adds. There is no target that creates a clinical order (the CHECK below names exactly two targets).
--
-- Rules the database itself enforces (the service checks them first, these are the backstop):
--   * one PROPOSED request per (message, target) - the partial unique index is the idempotency arbiter;
--   * accepted and rejected are final; a withdrawn or superseded request may only move to accepted (a reviewer signed a
--     record, so the truth beats the requester's earlier intent); the identity and attribution columns never change;
--   * a request is BORN proposed with no outcome fields (insert guard).
-- wardenx_app has NO DELETE and may UPDATE only the outcome columns; wardenx_destruction may DELETE for tenant destruction.
-- A request is a compliance record: no foreign key to a message or a patient, no cascade from either.
--
-- The same migration adds the attribution columns to the two owning tables (M8 encounter_addendum, M14 idg_agenda_item): a
-- promoted record carries the request id, the message id, the author, the sent time and the body hash, all-or-none and
-- immutable, and an insert guard proves they equal the proposal they claim to come from.

CREATE TABLE "chart_promotion_request" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "message_id" uuid NOT NULL,
  "channel_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "target_module" text NOT NULL,
  "target_kind" text NOT NULL,
  "suggested_target_ref" uuid,
  "status" text DEFAULT 'proposed' NOT NULL,
  "requested_by_user_id" uuid NOT NULL,
  "requested_at" timestamptz DEFAULT now() NOT NULL,
  "source_author_user_id" uuid NOT NULL,
  "source_sent_at" timestamptz NOT NULL,
  "source_body_sha256" text NOT NULL,
  "result_ref" uuid,
  "decided_by_user_id" uuid,
  "decided_at" timestamptz,
  "reason_code" text,
  "closed_at" timestamptz,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "chart_promotion_request_org_id_uq" UNIQUE ("organization_id", "id"),
  CONSTRAINT "chart_promotion_request_target"
    CHECK (("target_module", "target_kind") IN (('m8', 'encounter_addendum'), ('m14', 'idg_agenda_item'))),
  CONSTRAINT "chart_promotion_request_suggested_ref"
    CHECK ("suggested_target_ref" IS NULL OR "target_module" = 'm14'),
  CONSTRAINT "chart_promotion_request_status_shape"
    CHECK ("status" IN ('proposed', 'accepted', 'rejected', 'superseded', 'withdrawn')),
  CONSTRAINT "chart_promotion_request_sha_shape" CHECK ("source_body_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "chart_promotion_request_accepted_shape"
    CHECK (("status" = 'accepted') = ("result_ref" IS NOT NULL)),
  CONSTRAINT "chart_promotion_request_decided_shape"
    CHECK (("status" IN ('accepted', 'rejected')) = ("decided_by_user_id" IS NOT NULL AND "decided_at" IS NOT NULL)),
  CONSTRAINT "chart_promotion_request_closed_shape"
    CHECK (("status" = 'proposed') = ("closed_at" IS NULL)),
  CONSTRAINT "chart_promotion_request_reason_shape"
    CHECK ("reason_code" IS NULL OR "reason_code" IN
      ('not_clinically_relevant', 'already_documented', 'duplicate', 'wrong_patient', 'other', 'requester', 'superseded')),
  -- Which reason belongs to which status: superseded and withdrawn are system/requester-set; accepted and proposed carry
  -- none (an accepted request that was once withdrawn drops the 'requester' reason in the same update).
  CONSTRAINT "chart_promotion_request_reason_by_status" CHECK (
    CASE "status"
      WHEN 'proposed' THEN "reason_code" IS NULL
      WHEN 'accepted' THEN "reason_code" IS NULL
      WHEN 'superseded' THEN "reason_code" = 'superseded'
      WHEN 'withdrawn' THEN "reason_code" = 'requester'
      ELSE "reason_code" IS NOT NULL AND "reason_code" NOT IN ('requester', 'superseded')
    END)
);--> statement-breakpoint
CREATE UNIQUE INDEX "chart_promotion_request_one_proposed"
  ON "chart_promotion_request" ("organization_id", "message_id", "target_module", "target_kind")
  WHERE "status" = 'proposed';--> statement-breakpoint
-- Plain, NON-partial indexes (test:fk-indexes:live ignores a partial index).
CREATE INDEX "chart_promotion_request_message_idx"
  ON "chart_promotion_request" ("organization_id", "message_id");--> statement-breakpoint
CREATE INDEX "chart_promotion_request_patient_idx"
  ON "chart_promotion_request" ("organization_id", "patient_id", "target_module", "status");--> statement-breakpoint
CREATE INDEX "chart_promotion_request_requester_idx"
  ON "chart_promotion_request" ("organization_id", "requested_by_user_id", "status");--> statement-breakpoint

-- A request is BORN proposed with no outcome: no INSERT may plant an already-decided request.
CREATE OR REPLACE FUNCTION chart_promotion_request_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'proposed' OR NEW.result_ref IS NOT NULL OR NEW.decided_by_user_id IS NOT NULL
     OR NEW.decided_at IS NOT NULL OR NEW.reason_code IS NOT NULL OR NEW.closed_at IS NOT NULL OR NEW.version <> 0 THEN
    RAISE EXCEPTION 'chart_promotion_insert_state: a request is created proposed with no outcome'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_chart_promotion_request_insert_guard"
  BEFORE INSERT ON chart_promotion_request
  FOR EACH ROW EXECUTE FUNCTION chart_promotion_request_insert_guard();--> statement-breakpoint

-- accepted and rejected are final. A superseded or withdrawn request may only become accepted (and keeps its closed_at).
-- Identity and attribution never change. DELETE (the eraser) is not an UPDATE and is unaffected.
CREATE OR REPLACE FUNCTION chart_promotion_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.message_id IS DISTINCT FROM OLD.message_id
     OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.target_module IS DISTINCT FROM OLD.target_module
     OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
     OR NEW.suggested_target_ref IS DISTINCT FROM OLD.suggested_target_ref
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.source_author_user_id IS DISTINCT FROM OLD.source_author_user_id
     OR NEW.source_sent_at IS DISTINCT FROM OLD.source_sent_at
     OR NEW.source_body_sha256 IS DISTINCT FROM OLD.source_body_sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'chart_promotion_immutable: a request''s identity and attribution cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('accepted', 'rejected') THEN
    RAISE EXCEPTION 'chart_promotion_final: a decided request cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('superseded', 'withdrawn') THEN
    IF NEW.status IS DISTINCT FROM 'accepted' OR NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
      RAISE EXCEPTION 'chart_promotion_closed: a closed request can only become accepted'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = 'proposed' THEN
    RAISE EXCEPTION 'chart_promotion_noop: a proposed request changes only by being decided or closed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_chart_promotion_request_guard"
  BEFORE UPDATE ON chart_promotion_request
  FOR EACH ROW EXECUTE FUNCTION chart_promotion_request_guard();--> statement-breakpoint

ALTER TABLE "chart_promotion_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chart_promotion_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "chart_promotion_request_org_isolation" ON "chart_promotion_request"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "chart_promotion_request" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("status", "result_ref", "decided_by_user_id", "decided_at", "reason_code", "closed_at", "version", "updated_at")
  ON "chart_promotion_request" TO wardenx_app;--> statement-breakpoint

-- Bespoke audit trigger: the patient and the body hash are recorded as changed without being copied into the immutable
-- log. A system write (the outcome consumer) runs with no app.user_id and is attributed to the system.
CREATE OR REPLACE FUNCTION audit_phi_write_chart_promotion_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['patient_id','source_body_sha256']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['patient_id','source_body_sha256']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'chart_promotion_request.' || lower(TG_OP), 'chart_promotion_request',
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
ALTER FUNCTION audit_phi_write_chart_promotion_request() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_chart_promotion_request"
  AFTER INSERT OR UPDATE OR DELETE ON chart_promotion_request
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_chart_promotion_request();--> statement-breakpoint

GRANT SELECT, DELETE ON "chart_promotion_request" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "chart_promotion_request_destruction" ON "chart_promotion_request"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- ── permission: who may PROPOSE a message for the chart (1092's shape) ──────────────────────────────────────────────────
-- A catalog row (category clinical, no ABAC) granted to the clinical role keys, wherever a tenant has created them (nothing
-- materializes ROLE_TEMPLATES, so a tenant without a role is unchanged - the 0379 precedent). NEVER the aide, volunteer,
-- compliance or admin-only roles. A tenant tightens by removing the grant from a role it owns. Proposing is not
-- accepting: the reviewer decides in the owning module under that module's own permission.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.promote', 'chart_promotion', 'request', 'clinical', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.promote'
  FROM "role" r
 WHERE r."key" IN ('rn', 'lpn', 'rn_case_manager', 'director_of_nursing', 'md', 'physician', 'hospice_physician',
                   'medical_director', 'attending_clinician', 'np', 'nurse_practitioner', 'pa', 'msw', 'chaplain',
                   'clinical_supervisor')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint

-- ── M8: attribution on the addendum a reviewer authors from a proposal ──────────────────────────────────────────────────
ALTER TABLE "encounter_addendum"
  ADD COLUMN "promotion_request_id" uuid,
  ADD COLUMN "source_message_id" uuid,
  ADD COLUMN "source_author_user_id" uuid,
  ADD COLUMN "source_sent_at" timestamptz,
  ADD COLUMN "source_body_sha256" text;--> statement-breakpoint
ALTER TABLE "encounter_addendum"
  ADD CONSTRAINT "encounter_addendum_promotion_shape" CHECK (
    ("promotion_request_id" IS NULL) = ("source_message_id" IS NULL)
    AND ("promotion_request_id" IS NULL) = ("source_author_user_id" IS NULL)
    AND ("promotion_request_id" IS NULL) = ("source_sent_at" IS NULL)
    AND ("promotion_request_id" IS NULL) = ("source_body_sha256" IS NULL)),
  ADD CONSTRAINT "encounter_addendum_promotion_sha_shape"
    CHECK ("source_body_sha256" IS NULL OR "source_body_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
-- One live addendum per proposal: a second draft for the same request is a unique violation (a voided one frees it).
CREATE UNIQUE INDEX "encounter_addendum_promotion_uq"
  ON "encounter_addendum" ("organization_id", "promotion_request_id")
  WHERE "promotion_request_id" IS NOT NULL AND "status" <> 'voided';--> statement-breakpoint

-- ── M14: the same attribution on an agenda item (a pointer; no message text is ever copied into the agenda) ────────────
ALTER TABLE "idg_agenda_item"
  ADD COLUMN "promotion_request_id" uuid,
  ADD COLUMN "source_message_id" uuid,
  ADD COLUMN "source_author_user_id" uuid,
  ADD COLUMN "source_sent_at" timestamptz,
  ADD COLUMN "source_body_sha256" text;--> statement-breakpoint
ALTER TABLE "idg_agenda_item"
  ADD CONSTRAINT "idg_agenda_item_promotion_shape" CHECK (
    ("promotion_request_id" IS NULL) = ("source_message_id" IS NULL)
    AND ("promotion_request_id" IS NULL) = ("source_author_user_id" IS NULL)
    AND ("promotion_request_id" IS NULL) = ("source_sent_at" IS NULL)
    AND ("promotion_request_id" IS NULL) = ("source_body_sha256" IS NULL)),
  ADD CONSTRAINT "idg_agenda_item_promotion_sha_shape"
    CHECK ("source_body_sha256" IS NULL OR "source_body_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "idg_agenda_item_promotion_patient"
    CHECK ("promotion_request_id" IS NULL OR "patient_id" IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "idg_agenda_item_promotion_uq"
  ON "idg_agenda_item" ("organization_id", "promotion_request_id")
  WHERE "promotion_request_id" IS NOT NULL;--> statement-breakpoint

-- The attribution on a promoted record is immutable, and an INSERT must equal the proposal it claims to come from (same
-- organisation, target module, message, author, sent time and body hash, still proposed, and the same patient). The
-- guards read chart_promotion_request as the calling role, so they only ever see the caller's own tenant.
CREATE OR REPLACE FUNCTION encounter_addendum_promotion_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.promotion_request_id IS DISTINCT FROM OLD.promotion_request_id
       OR NEW.source_message_id IS DISTINCT FROM OLD.source_message_id
       OR NEW.source_author_user_id IS DISTINCT FROM OLD.source_author_user_id
       OR NEW.source_sent_at IS DISTINCT FROM OLD.source_sent_at
       OR NEW.source_body_sha256 IS DISTINCT FROM OLD.source_body_sha256 THEN
      RAISE EXCEPTION 'encounter_addendum_promotion_immutable: promotion attribution cannot change'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.promotion_request_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM chart_promotion_request p
      JOIN encounter e ON e.organization_id = NEW.organization_id AND e.id = NEW.encounter_id
     WHERE p.organization_id = NEW.organization_id AND p.id = NEW.promotion_request_id
       AND p.target_module = 'm8' AND p.status = 'proposed'
       AND p.message_id = NEW.source_message_id AND p.source_author_user_id = NEW.source_author_user_id
       AND p.source_sent_at = NEW.source_sent_at AND p.source_body_sha256 = NEW.source_body_sha256
       AND p.patient_id = e.patient_id) THEN
    RAISE EXCEPTION 'encounter_addendum_promotion_source: the attribution does not match an open proposal for this patient'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_encounter_addendum_promotion_guard"
  BEFORE INSERT OR UPDATE ON encounter_addendum
  FOR EACH ROW EXECUTE FUNCTION encounter_addendum_promotion_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION idg_agenda_item_promotion_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.promotion_request_id IS DISTINCT FROM OLD.promotion_request_id
       OR NEW.source_message_id IS DISTINCT FROM OLD.source_message_id
       OR NEW.source_author_user_id IS DISTINCT FROM OLD.source_author_user_id
       OR NEW.source_sent_at IS DISTINCT FROM OLD.source_sent_at
       OR NEW.source_body_sha256 IS DISTINCT FROM OLD.source_body_sha256 THEN
      RAISE EXCEPTION 'idg_agenda_item_promotion_immutable: promotion attribution cannot change'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.promotion_request_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM chart_promotion_request p
     WHERE p.organization_id = NEW.organization_id AND p.id = NEW.promotion_request_id
       AND p.target_module = 'm14' AND p.status = 'proposed'
       AND p.message_id = NEW.source_message_id AND p.source_author_user_id = NEW.source_author_user_id
       AND p.source_sent_at = NEW.source_sent_at AND p.source_body_sha256 = NEW.source_body_sha256
       AND p.patient_id = NEW.patient_id) THEN
    RAISE EXCEPTION 'idg_agenda_item_promotion_source: the attribution does not match an open proposal for this patient'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_idg_agenda_item_promotion_guard"
  BEFORE INSERT OR UPDATE ON idg_agenda_item
  FOR EACH ROW EXECUTE FUNCTION idg_agenda_item_promotion_guard();--> statement-breakpoint

-- The M4 write-audit triggers of the two owning tables now also scrub the body hash (a content fingerprint of a secure
-- message; ids, times and enums stay). Same bodies as 0031 / 0043 with one more scrubbed column.
CREATE OR REPLACE FUNCTION audit_phi_write_encounter_addendum() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['reason','source_body_sha256']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['reason','source_body_sha256']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'encounter_addendum.' || lower(TG_OP),
    'encounter_addendum',
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
ALTER FUNCTION audit_phi_write_encounter_addendum() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_encounter_addendum" ON encounter_addendum;--> statement-breakpoint
CREATE TRIGGER "trg_audit_encounter_addendum" AFTER INSERT OR UPDATE OR DELETE ON encounter_addendum
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_encounter_addendum();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_idg_agenda_item() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['body_text','source_body_sha256']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['body_text','source_body_sha256']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'idg_agenda_item.' || lower(TG_OP),
    'idg_agenda_item',
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
ALTER FUNCTION audit_phi_write_idg_agenda_item() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_idg_agenda_item" ON idg_agenda_item;--> statement-breakpoint
CREATE TRIGGER "trg_audit_idg_agenda_item" AFTER INSERT OR UPDATE OR DELETE ON idg_agenda_item
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_idg_agenda_item();
