-- M36 WP 6.9 (ADR-0098, PROPOSED) - the death-event coordination board: after a patient's death, a fixed checklist of follow-up
-- items, each with exactly ONE accountable owner and an append-only history. Coordination only: nothing here writes to a chart.
-- Ids, enums and instants only (no title, note or free text): the item wording is the platform-floor template in
-- @chartwarden/types, resolved at read time. The patient label is re-resolved at read time through the M5 port.
--   * death_board: one row per (organization, patient) - the unique index is the idempotency arbiter, so the two death events
--     (m6.admission.discharged with reason death, then m5.patient.deceased) and any redelivery converge on ONE board.
--   * death_board_item: one row per (board, template key). owner_user_id is NOT NULL: an item is never ownerless. An owner who leaves
--     with nobody to take the item keeps the row and it is flagged needs_owner (visible, alerted), exactly like a communication task.
--   * death_board_item_event: append-only owner/status history (created, reassigned, completed, needs_owner).
-- Rules the database itself enforces (the service checks them first, these are the backstop):
--   * an item is BORN open, unflagged and unfinished; a done item is final;
--   * only the OWNER'S completion is accepted: completed_by_user_id must equal the owner, the owner cannot change in the same update,
--     and a flagged (needs_owner) item cannot be completed until it is reassigned;
--   * completed_at and updated_at are set from the DATABASE clock, whatever the client sends;
--   * an owner change clears needs_owner (a reassignment always lands on a person); needs_owner never changes the owner;
--   * the app role has NO DELETE and may UPDATE only the lifecycle columns; chartwarden_destruction may DELETE for tenant destruction.
-- Tenancy: organization_id plus a server-validated patient_id (a logical pointer, like clinical_handoff_item); M36 carries no
-- provider/location, so those columns of the three-column rule are not modelled here. The audit rows scrub patient_id.

CREATE TABLE "death_board" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "patient_id" uuid NOT NULL,
  "template_version" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "death_board_org_id_uq" UNIQUE ("organization_id", "id"),
  CONSTRAINT "death_board_template_version" CHECK ("template_version" >= 1)
);--> statement-breakpoint
CREATE UNIQUE INDEX "death_board_one_per_patient" ON "death_board" ("organization_id", "patient_id");--> statement-breakpoint
CREATE INDEX "death_board_recent_idx" ON "death_board" ("organization_id", "created_at");--> statement-breakpoint

CREATE TABLE "death_board_item" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "board_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "item_key" text NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "needs_owner" boolean DEFAULT false NOT NULL,
  "due_at" timestamptz NOT NULL,
  "completed_at" timestamptz,
  "completed_by_user_id" uuid,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "death_board_item_org_id_uq" UNIQUE ("organization_id", "id"),
  CONSTRAINT "death_board_item_board_fk"
    FOREIGN KEY ("organization_id", "board_id")
    REFERENCES "death_board"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "death_board_item_key_shape" CHECK ("item_key" IN
    ('pronouncement', 'family_notification', 'dme_pickup', 'medication_disposal', 'm4_record_tasks', 'm22_document_tasks')),
  CONSTRAINT "death_board_item_status_shape" CHECK ("status" IN ('open', 'done')),
  CONSTRAINT "death_board_item_done_shape"
    CHECK (("status" = 'done') = ("completed_at" IS NOT NULL) AND ("status" = 'done') = ("completed_by_user_id" IS NOT NULL)),
  CONSTRAINT "death_board_item_done_unflagged" CHECK ("status" = 'open' OR NOT "needs_owner"),
  CONSTRAINT "death_board_item_completed_by_owner"
    CHECK ("completed_by_user_id" IS NULL OR "completed_by_user_id" = "owner_user_id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "death_board_item_one_per_key" ON "death_board_item" ("organization_id", "board_id", "item_key");--> statement-breakpoint
-- Plain, NON-partial indexes: the ON DELETE CASCADE lookup from the board FK and the owner column (test:fk-indexes:live).
CREATE INDEX "death_board_item_board_idx" ON "death_board_item" ("organization_id", "board_id");--> statement-breakpoint
CREATE INDEX "death_board_item_patient_idx" ON "death_board_item" ("organization_id", "patient_id");--> statement-breakpoint
CREATE INDEX "death_board_item_owner_idx" ON "death_board_item" ("organization_id", "owner_user_id", "status");--> statement-breakpoint

CREATE TABLE "death_board_item_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "item_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_user_id" uuid,
  "from_owner_user_id" uuid,
  "to_owner_user_id" uuid,
  "reason_code" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "death_board_item_event_item_fk"
    FOREIGN KEY ("organization_id", "item_id")
    REFERENCES "death_board_item"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "death_board_item_event_type_shape"
    CHECK ("event_type" IN ('created', 'reassigned', 'completed', 'needs_owner')),
  CONSTRAINT "death_board_item_event_actor_shape"
    CHECK ("actor_kind" IN ('user', 'system') AND (("actor_kind" = 'system') = ("actor_user_id" IS NULL))),
  CONSTRAINT "death_board_item_event_reason_shape"
    CHECK ("reason_code" IS NULL OR "reason_code" IN ('creation', 'manual', 'supervisor', 'offboarding'))
);--> statement-breakpoint
CREATE INDEX "death_board_item_event_item_idx" ON "death_board_item_event" ("organization_id", "item_id", "created_at");--> statement-breakpoint
CREATE INDEX "death_board_item_event_actor_idx"
  ON "death_board_item_event" ("organization_id", "actor_user_id") WHERE "actor_user_id" IS NOT NULL;--> statement-breakpoint

-- An item is BORN open, unflagged and unfinished (no INSERT may plant a finished item).
CREATE OR REPLACE FUNCTION death_board_item_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'open' OR NEW.needs_owner THEN
    RAISE EXCEPTION 'death_board_item_insert_state: an item is created open and unflagged' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_death_board_item_insert_guard"
  BEFORE INSERT ON death_board_item
  FOR EACH ROW EXECUTE FUNCTION death_board_item_insert_guard();--> statement-breakpoint

-- Accountability and finality. SECURITY INVOKER; it reads no session variable (the actor is recorded by the audit trigger and the
-- event row). completed_at and updated_at come from the database clock, so a client cannot back-date a completion.
CREATE OR REPLACE FUNCTION death_board_item_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.status = 'done' THEN
    RAISE EXCEPTION 'death_board_item_final: a completed item cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'done' THEN
    IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
      RAISE EXCEPTION 'death_board_item_accountability: an item cannot change owner and complete in one step'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.needs_owner THEN
      RAISE EXCEPTION 'death_board_item_accountability: a flagged item must be reassigned before it is completed'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.completed_at := now();
  ELSIF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    IF NEW.needs_owner THEN
      RAISE EXCEPTION 'death_board_item_accountability: a reassignment lands on a person, so the flag is cleared'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.needs_owner IS DISTINCT FROM OLD.needs_owner AND NOT NEW.needs_owner THEN
    RAISE EXCEPTION 'death_board_item_accountability: the flag clears only by reassigning' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_death_board_item_guard"
  BEFORE UPDATE ON death_board_item
  FOR EACH ROW EXECUTE FUNCTION death_board_item_guard();--> statement-breakpoint

ALTER TABLE "death_board" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "death_board" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "death_board_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "death_board_item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "death_board_item_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "death_board_item_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "death_board_org_isolation" ON "death_board"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "death_board_item_org_isolation" ON "death_board_item"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "death_board_item_event_org_isolation" ON "death_board_item_event"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "death_board" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "death_board_item" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("owner_user_id", "status", "needs_owner", "completed_at", "completed_by_user_id", "version", "updated_at")
  ON "death_board_item" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "death_board_item_event" TO chartwarden_app;--> statement-breakpoint

-- The 1103 PHI audit pattern: patient_id is recorded as changed without being copied into the immutable log. A system write
-- (the consumer, the offboarding sweep) runs with no app.user_id and is attributed to the system actor.
CREATE OR REPLACE FUNCTION audit_phi_write_death_board() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['patient_id']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['patient_id']::text[]) ELSE NULL END;
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
ALTER FUNCTION audit_phi_write_death_board() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_death_board"
  AFTER INSERT OR UPDATE OR DELETE ON death_board
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_death_board();--> statement-breakpoint
CREATE TRIGGER "trg_audit_death_board_item"
  AFTER INSERT OR UPDATE OR DELETE ON death_board_item
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_death_board();--> statement-breakpoint
-- The event row holds ids, enums and instants only (no patient id), so the generic trigger is the right fit.
CREATE TRIGGER "death_board_item_event_audit"
  AFTER INSERT OR UPDATE OR DELETE ON death_board_item_event
  FOR EACH ROW EXECUTE FUNCTION chartwarden_audit_trigger();--> statement-breakpoint

GRANT SELECT, DELETE ON "death_board" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "death_board_item" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "death_board_item_event" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "death_board_destruction" ON "death_board"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "death_board_item_destruction" ON "death_board_item"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "death_board_item_event_destruction" ON "death_board_item_event"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
