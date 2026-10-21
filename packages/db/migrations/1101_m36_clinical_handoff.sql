-- M36 WP 3.5 - clinical handoffs (ADR-0062). A sender offers a set of open-work POINTERS (patient, visit, refill request,
-- symptom follow-up, task) to one named colleague, who accepts or declines PER ITEM. No title, note or free text: the
-- patient label and each item's status are re-resolved at read time through the owning module's seam, so a handoff is
-- never a second PHI store. `clinical_handoff_event` is the append-only history.
--
-- Accountability lives on the ITEM (`accountable_user_id`): the sender at insert, the recipient only in the very update
-- that sets the item `accepted`. The item-guard trigger below is the database backstop for that rule, so a pending,
-- declined, expired or cancelled item can never name anyone but the sender.
--
-- Rules the database itself enforces (the service checks them first, these are the backstop):
--   * one OPEN handoff per (sender, recipient) pair - the partial unique index is the idempotency arbiter;
--   * one PENDING handoff per work item - a second offer of the same item is a unique violation;
--   * a closed handoff, and any item that is no longer pending, is final (BEFORE UPDATE triggers);
--   * the sender and recipient differ; the deadline is after the offer.
-- wardenx_app has NO DELETE on the three handoff tables (the lifecycle-no-delete gate) and may UPDATE only the status
-- columns; wardenx_destruction may DELETE for tenant destruction. Handoffs are compliance records: no foreign key to a
-- message or a patient, no cascade from either.
-- Tenancy: organization_id plus a server-validated patient_id on the item (a logical pointer, like clinical_link); M36
-- carries no provider/location, so those columns of the three-column rule are not modelled here.

CREATE TABLE "clinical_handoff" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "from_user_id" uuid NOT NULL,
  "to_user_id" uuid NOT NULL,
  "state" text DEFAULT 'offered' NOT NULL,
  "offered_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "accepted_at" timestamptz,
  "closed_at" timestamptz,
  "closed_reason" text,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "clinical_handoff_org_id_uq" UNIQUE ("organization_id", "id"),
  CONSTRAINT "clinical_handoff_state_shape"
    CHECK ("state" IN ('offered', 'accepted', 'declined', 'expired', 'cancelled')),
  CONSTRAINT "clinical_handoff_parties" CHECK ("from_user_id" <> "to_user_id"),
  CONSTRAINT "clinical_handoff_deadline" CHECK ("expires_at" > "offered_at"),
  CONSTRAINT "clinical_handoff_reason_shape"
    CHECK ("closed_reason" IS NULL OR "closed_reason" IN
      ('all_resolved', 'deadline', 'sender_cancelled', 'recipient_left')),
  CONSTRAINT "clinical_handoff_closed_shape"
    CHECK (("state" = 'offered') = ("closed_at" IS NULL) AND ("state" = 'offered') = ("closed_reason" IS NULL)),
  CONSTRAINT "clinical_handoff_accepted_shape"
    CHECK (("state" = 'accepted') = ("accepted_at" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_handoff_open_per_pair"
  ON "clinical_handoff" ("organization_id", "from_user_id", "to_user_id")
  WHERE "state" = 'offered';--> statement-breakpoint
CREATE INDEX "clinical_handoff_to_idx"
  ON "clinical_handoff" ("organization_id", "to_user_id", "state", "expires_at");--> statement-breakpoint
CREATE INDEX "clinical_handoff_from_idx"
  ON "clinical_handoff" ("organization_id", "from_user_id", "state");--> statement-breakpoint
CREATE INDEX "clinical_handoff_due_idx"
  ON "clinical_handoff" ("organization_id", "expires_at") WHERE "state" = 'offered';--> statement-breakpoint

CREATE TABLE "clinical_handoff_item" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "handoff_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "item_kind" text NOT NULL,
  "ref_id" uuid NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "accountable_user_id" uuid NOT NULL,
  "resolved_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "clinical_handoff_item_handoff_fk"
    FOREIGN KEY ("organization_id", "handoff_id")
    REFERENCES "clinical_handoff"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "clinical_handoff_item_kind_shape"
    CHECK ("item_kind" IN ('patient', 'visit', 'refill_request', 'symptom_followup', 'task')),
  CONSTRAINT "clinical_handoff_item_state_shape"
    CHECK ("state" IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
  CONSTRAINT "clinical_handoff_item_resolved_shape"
    CHECK (("state" = 'pending') = ("resolved_at" IS NULL)),
  CONSTRAINT "clinical_handoff_item_patient_anchor"
    CHECK ("item_kind" <> 'patient' OR "ref_id" = "patient_id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_handoff_item_unique_in_handoff"
  ON "clinical_handoff_item" ("organization_id", "handoff_id", "item_kind", "ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_handoff_item_one_pending"
  ON "clinical_handoff_item" ("organization_id", "item_kind", "ref_id")
  WHERE "state" = 'pending';--> statement-breakpoint
-- Plain, NON-partial indexes: the ON DELETE CASCADE lookup from the handoff FK and the patient column must be served
-- by an index the partial ones above cannot replace (test:fk-indexes:live).
CREATE INDEX "clinical_handoff_item_handoff_idx"
  ON "clinical_handoff_item" ("organization_id", "handoff_id");--> statement-breakpoint
CREATE INDEX "clinical_handoff_item_patient_idx"
  ON "clinical_handoff_item" ("organization_id", "patient_id");--> statement-breakpoint
CREATE INDEX "clinical_handoff_item_accountable_idx"
  ON "clinical_handoff_item" ("organization_id", "accountable_user_id", "state");--> statement-breakpoint

CREATE TABLE "clinical_handoff_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "handoff_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "actor_user_id" uuid,
  "actor_kind" text NOT NULL,
  "item_count" integer DEFAULT 0 NOT NULL,
  "reason_code" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "clinical_handoff_event_handoff_fk"
    FOREIGN KEY ("organization_id", "handoff_id")
    REFERENCES "clinical_handoff"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "clinical_handoff_event_type_shape"
    CHECK ("event_type" IN ('offered', 'items_accepted', 'items_declined', 'closed', 'cancelled',
      'needs_attention', 'recipient_left', 'sender_left')),
  CONSTRAINT "clinical_handoff_event_actor_shape"
    CHECK ("actor_kind" IN ('user', 'system') AND (("actor_kind" = 'system') = ("actor_user_id" IS NULL))),
  CONSTRAINT "clinical_handoff_event_count" CHECK ("item_count" >= 0)
);--> statement-breakpoint
CREATE INDEX "clinical_handoff_event_handoff_idx"
  ON "clinical_handoff_event" ("organization_id", "handoff_id", "created_at");--> statement-breakpoint

-- Tenant policy: one row per organisation, absent = the platform default. Tighten-only: the deadline can only be
-- SHORTENED from the 240-minute platform ceiling (the CHECK pins the same bounds as HANDOFF_EXPIRY_* in @wardenx/types,
-- with a pin test). The ceiling is re-applied on every read.
CREATE TABLE "tenant_handoff_policy" (
  "organization_id" uuid PRIMARY KEY REFERENCES "organization"("id") ON DELETE RESTRICT,
  "expiry_minutes" integer NOT NULL,
  "configured_by_user_id" uuid NOT NULL REFERENCES "user"("id"),
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "tenant_handoff_policy_expiry" CHECK ("expiry_minutes" BETWEEN 15 AND 240)
);--> statement-breakpoint
CREATE INDEX "tenant_handoff_policy_configured_by_idx" ON "tenant_handoff_policy" ("configured_by_user_id");--> statement-breakpoint

-- A closed handoff is final: refuse any UPDATE of a non-offered row (a new offer is a new handoff). DELETE (the eraser)
-- is not an UPDATE and is unaffected. Row-level BEFORE trigger, so it fires before the audit trigger.
CREATE OR REPLACE FUNCTION clinical_handoff_refuse_closed_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.state <> 'offered' THEN
    RAISE EXCEPTION 'clinical_handoff_closed: a closed handoff cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_clinical_handoff_closed_final"
  BEFORE UPDATE ON clinical_handoff
  FOR EACH ROW EXECUTE FUNCTION clinical_handoff_refuse_closed_update();--> statement-breakpoint

-- Per-item accountability: an item that is no longer pending is final; an item may only change while its handoff is
-- still offered; it may become `accepted` only with the handoff's RECIPIENT as the accountable clinician; every other
-- outcome leaves the accountable clinician exactly as it was (the sender).
CREATE OR REPLACE FUNCTION clinical_handoff_item_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_state text; v_to uuid;
BEGIN
  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'clinical_handoff_item_final: a resolved item cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  SELECT h.state, h.to_user_id INTO v_state, v_to
    FROM clinical_handoff h WHERE h.organization_id = NEW.organization_id AND h.id = NEW.handoff_id;
  IF v_state IS DISTINCT FROM 'offered' THEN
    RAISE EXCEPTION 'clinical_handoff_item_closed: the handoff is not open' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'accepted' THEN
    IF NEW.accountable_user_id IS DISTINCT FROM v_to THEN
      RAISE EXCEPTION 'clinical_handoff_item_accountability: an accepted item belongs to the recipient'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.accountable_user_id IS DISTINCT FROM OLD.accountable_user_id THEN
    RAISE EXCEPTION 'clinical_handoff_item_accountability: accountability moves only on acceptance'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_clinical_handoff_item_guard"
  BEFORE UPDATE ON clinical_handoff_item
  FOR EACH ROW EXECUTE FUNCTION clinical_handoff_item_guard();--> statement-breakpoint

-- An item is BORN pending and owned by the offering sender: no INSERT may plant an already-resolved item or hand
-- accountability to anyone else. The parent is read in the same organisation (the item's FK already pins the pair).
CREATE OR REPLACE FUNCTION clinical_handoff_item_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_from uuid;
BEGIN
  SELECT h.from_user_id INTO v_from
    FROM clinical_handoff h WHERE h.organization_id = NEW.organization_id AND h.id = NEW.handoff_id;
  IF NEW.state IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'clinical_handoff_item_insert_state: an item is created pending' USING ERRCODE = 'check_violation';
  END IF;
  IF v_from IS NULL OR NEW.accountable_user_id IS DISTINCT FROM v_from THEN
    RAISE EXCEPTION 'clinical_handoff_item_insert_accountability: a new item belongs to the offering sender'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_clinical_handoff_item_insert_guard"
  BEFORE INSERT ON clinical_handoff_item
  FOR EACH ROW EXECUTE FUNCTION clinical_handoff_item_insert_guard();--> statement-breakpoint

ALTER TABLE "clinical_handoff" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clinical_handoff" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "clinical_handoff_org_isolation" ON "clinical_handoff"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "clinical_handoff" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("state", "accepted_at", "closed_at", "closed_reason", "version", "updated_at")
  ON "clinical_handoff" TO wardenx_app;--> statement-breakpoint

ALTER TABLE "clinical_handoff_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clinical_handoff_item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "clinical_handoff_item_org_isolation" ON "clinical_handoff_item"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "clinical_handoff_item" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("state", "accountable_user_id", "resolved_at")
  ON "clinical_handoff_item" TO wardenx_app;--> statement-breakpoint

ALTER TABLE "clinical_handoff_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clinical_handoff_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "clinical_handoff_event_org_isolation" ON "clinical_handoff_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "clinical_handoff_event" TO wardenx_app;--> statement-breakpoint

ALTER TABLE "tenant_handoff_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_handoff_policy" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_handoff_policy_org_isolation" ON "tenant_handoff_policy"
  FOR ALL TO wardenx_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_handoff_policy" TO wardenx_app;--> statement-breakpoint

-- Handoff and event: ids, enums and instants only, so the generic trigger (no scrub list) is the right fit.
CREATE TRIGGER "clinical_handoff_audit" AFTER INSERT OR UPDATE OR DELETE ON clinical_handoff
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "clinical_handoff_event_audit" AFTER INSERT OR UPDATE OR DELETE ON clinical_handoff_event
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

-- Item: bespoke trigger so the patient and the work item are recorded as changed without being copied into the
-- immutable log. A system write (the expiry tick, offboarding) runs with no app.user_id and is attributed to the system.
CREATE OR REPLACE FUNCTION audit_phi_write_clinical_handoff_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['patient_id','ref_id']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['patient_id','ref_id']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'clinical_handoff_item.' || lower(TG_OP), 'clinical_handoff_item',
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
ALTER FUNCTION audit_phi_write_clinical_handoff_item() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_clinical_handoff_item"
  AFTER INSERT OR UPDATE OR DELETE ON clinical_handoff_item
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_clinical_handoff_item();--> statement-breakpoint

-- Policy: org-level configuration (an integer), no PHI. Its primary key is the organization, so the audit resource id
-- is the organization id (the generic trigger reads NEW.id, which this table does not have).
CREATE OR REPLACE FUNCTION audit_phi_write_tenant_handoff_policy() RETURNS trigger
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
    'user', 'tenant_handoff_policy.' || lower(TG_OP), 'tenant_handoff_policy',
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
ALTER FUNCTION audit_phi_write_tenant_handoff_policy() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tenant_handoff_policy"
  AFTER INSERT OR UPDATE OR DELETE ON tenant_handoff_policy
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tenant_handoff_policy();--> statement-breakpoint

GRANT SELECT, DELETE ON "clinical_handoff" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "clinical_handoff_destruction" ON "clinical_handoff"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, DELETE ON "clinical_handoff_item" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "clinical_handoff_item_destruction" ON "clinical_handoff_item"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, DELETE ON "clinical_handoff_event" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "clinical_handoff_event_destruction" ON "clinical_handoff_event"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, DELETE ON "tenant_handoff_policy" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "tenant_handoff_policy_destruction" ON "tenant_handoff_policy"
  FOR ALL TO wardenx_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
