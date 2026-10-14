-- M36 WP 3.4 - communication tasks. A task points at ONE message and names an assignee: ids, a status, an optional due
-- instant, two flags and a closing reason CODE. No title, no message excerpt, no free text - the message is read through
-- the conversation, so a task is never a second PHI store. `communication_task_event` is its append-only history.
--
-- Rules the database itself enforces (the service checks them first, these are the backstop):
--   * one ACTIVE task per (message, assignee) - the partial unique index is the idempotency arbiter;
--   * a patient task is always a clinical task, and a clinical task cannot be closed without a reason code;
--   * a reason exists only on a closed task; closed_at is set exactly when the task is closed.
-- wardenx_app has NO DELETE on either table (the lifecycle-no-delete gate); tasks leave with their message through the
-- ON DELETE CASCADE foreign key (the eraser / a hard delete), and wardenx_destruction may DELETE for that path.
-- Tenancy: organization_id plus a nullable server-derived patient_id (like clinical_link); M36 messages carry no
-- provider/location, so those two columns of the three-column rule are not modelled here.

CREATE TABLE "communication_task" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "message_id" uuid NOT NULL,
  "channel_id" uuid NOT NULL,
  "patient_id" uuid,
  "created_by" uuid NOT NULL,
  "assignee_id" uuid NOT NULL,
  "due_at" timestamptz,
  "status" text DEFAULT 'open' NOT NULL,
  "clinical_concern" boolean DEFAULT false NOT NULL,
  "closed_reason" text,
  "needs_owner" boolean DEFAULT false NOT NULL,
  "accepted_at" timestamptz,
  "closed_at" timestamptz,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "communication_task_org_id_uq" UNIQUE ("organization_id", "id"),
  CONSTRAINT "communication_task_message_org_fk"
    FOREIGN KEY ("organization_id", "message_id")
    REFERENCES "message"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "communication_task_status_shape"
    CHECK ("status" IN ('open', 'accepted', 'done', 'cancelled')),
  CONSTRAINT "communication_task_reason_shape"
    CHECK ("closed_reason" IS NULL OR "closed_reason" IN
      ('action_taken', 'handled_elsewhere', 'no_action_needed', 'unable_to_complete', 'duplicate')),
  CONSTRAINT "communication_task_reason_only_when_closed"
    CHECK ("closed_reason" IS NULL OR "status" IN ('done', 'cancelled')),
  CONSTRAINT "communication_task_clinical_close_needs_reason"
    CHECK (NOT ("clinical_concern" AND "status" IN ('done', 'cancelled')) OR "closed_reason" IS NOT NULL),
  CONSTRAINT "communication_task_patient_is_clinical"
    CHECK ("patient_id" IS NULL OR "clinical_concern"),
  CONSTRAINT "communication_task_closed_at_shape"
    CHECK (("status" IN ('done', 'cancelled')) = ("closed_at" IS NOT NULL))
);--> statement-breakpoint

CREATE UNIQUE INDEX "communication_task_active_per_assignee"
  ON "communication_task" ("organization_id", "message_id", "assignee_id")
  WHERE "status" IN ('open', 'accepted');--> statement-breakpoint
CREATE INDEX "communication_task_assignee_idx"
  ON "communication_task" ("organization_id", "assignee_id", "status", "due_at");--> statement-breakpoint
CREATE INDEX "communication_task_creator_idx"
  ON "communication_task" ("organization_id", "created_by", "status");--> statement-breakpoint
CREATE INDEX "communication_task_patient_idx"
  ON "communication_task" ("organization_id", "patient_id") WHERE "patient_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE "communication_task_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "task_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "actor_user_id" uuid,
  "actor_kind" text NOT NULL,
  "from_status" text,
  "to_status" text,
  "from_assignee_id" uuid,
  "to_assignee_id" uuid,
  "reason_code" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "communication_task_event_task_fk"
    FOREIGN KEY ("organization_id", "task_id")
    REFERENCES "communication_task"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "communication_task_event_type_shape"
    CHECK ("event_type" IN ('created', 'accepted', 'done', 'cancelled', 'reassigned', 'needs_owner')),
  CONSTRAINT "communication_task_event_actor_shape"
    CHECK ("actor_kind" IN ('user', 'system') AND (("actor_kind" = 'system') = ("actor_user_id" IS NULL)))
);--> statement-breakpoint
CREATE INDEX "communication_task_event_task_idx"
  ON "communication_task_event" ("organization_id", "task_id", "created_at");--> statement-breakpoint

ALTER TABLE "communication_task" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "communication_task" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "communication_task_org_isolation" ON "communication_task"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "communication_task" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("assignee_id", "status", "closed_reason", "needs_owner", "accepted_at", "closed_at", "version", "updated_at")
  ON "communication_task" TO wardenx_app;--> statement-breakpoint

ALTER TABLE "communication_task_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "communication_task_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "communication_task_event_org_isolation" ON "communication_task_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "communication_task_event" TO wardenx_app;--> statement-breakpoint

-- Task: bespoke trigger so the patient is recorded as changed without being copied into the immutable log. A system
-- write (offboarding runs with no app.user_id) is attributed to the system actor instead of a user.
CREATE OR REPLACE FUNCTION audit_phi_write_communication_task() RETURNS trigger
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
    'communication_task.' || lower(TG_OP), 'communication_task',
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
ALTER FUNCTION audit_phi_write_communication_task() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_communication_task"
  AFTER INSERT OR UPDATE OR DELETE ON communication_task
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_communication_task();--> statement-breakpoint

-- Event: ids, enums and instants only, so the generic trigger (no scrub list) is the right fit.
CREATE TRIGGER "communication_task_event_audit" AFTER INSERT OR UPDATE OR DELETE ON communication_task_event
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

GRANT SELECT, DELETE ON "communication_task" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "communication_task_destruction" ON "communication_task"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, DELETE ON "communication_task_event" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "communication_task_event_destruction" ON "communication_task_event"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
