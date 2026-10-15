-- M36 WP 3.8 - the lifecycle review queue (ADR-0065). When a patient is discharged, dies or transfers out, the open
-- communication tasks on the patient's care-team channel are queued here for a supervisor, who reassigns each one or closes
-- it with a reason CODE. Nothing is ever deleted: the channel is archived (GAP-104, unchanged) and its history stays
-- readable to its members. A row holds ids and enums only (no free text, no patient name); the patient label is resolved
-- at read time, in an authorised, read-audited response.
--
-- The same table serves WP 3.9 (care-team removal): `source` / `cause` already admit 'care_team_change' /
-- 'care_team_removed'.
--
-- Rules the database itself enforces (the service checks them first, these are the backstop):
--   * one row per (trigger, task) and at most ONE open review per task - a redelivered or repeated trigger inserts nothing;
--   * a decided row is final (BEFORE UPDATE trigger);
--   * a decision names who made it, a reassignment names the new assignee, a close names a reason code;
--   * closing the TASK itself (any path, any actor) resolves its open review as closed_elsewhere (AFTER UPDATE trigger).
-- wardenx_app has NO DELETE (the lifecycle-no-delete gate) and may UPDATE only the decision columns;
-- wardenx_destruction may DELETE for tenant destruction. patient_id, item_id and trigger_ref are logical pointers.

CREATE TABLE "messaging_review_item" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "source" text NOT NULL,
  "cause" text NOT NULL,
  "trigger_ref" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "subject_user_id" uuid NOT NULL,
  "item_kind" text NOT NULL,
  "item_id" uuid NOT NULL,
  "state" text DEFAULT 'open' NOT NULL,
  "resolution" text,
  "resolution_reason" text,
  "reassigned_to_user_id" uuid,
  "resolved_by_user_id" uuid,
  "resolved_at" timestamptz,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "messaging_review_item_org_id_uq" UNIQUE ("organization_id", "id"),
  CONSTRAINT "messaging_review_item_source_cause" CHECK (
    ("source" = 'patient_lifecycle' AND "cause" IN ('death', 'discharge', 'transfer'))
    OR ("source" = 'care_team_change' AND "cause" = 'care_team_removed')),
  CONSTRAINT "messaging_review_item_kind_shape" CHECK ("item_kind" IN ('task')),
  CONSTRAINT "messaging_review_item_state_shape" CHECK ("state" IN ('open', 'resolved')),
  CONSTRAINT "messaging_review_item_resolution_shape"
    CHECK ("resolution" IS NULL OR "resolution" IN ('reassigned', 'closed', 'closed_elsewhere')),
  CONSTRAINT "messaging_review_item_resolved_shape"
    CHECK ((("state" = 'open') = ("resolved_at" IS NULL)) AND (("state" = 'open') = ("resolution" IS NULL))),
  CONSTRAINT "messaging_review_item_closed_reason"
    CHECK ("resolution" IS DISTINCT FROM 'closed' OR "resolution_reason" IN
      ('action_taken', 'handled_elsewhere', 'no_action_needed', 'unable_to_complete', 'duplicate')),
  CONSTRAINT "messaging_review_item_reassigned_to"
    CHECK (("resolution" = 'reassigned') = ("reassigned_to_user_id" IS NOT NULL)),
  CONSTRAINT "messaging_review_item_decided_by"
    CHECK ("resolution" NOT IN ('reassigned', 'closed') OR "resolved_by_user_id" IS NOT NULL)
);--> statement-breakpoint

CREATE UNIQUE INDEX "messaging_review_item_trigger_uq"
  ON "messaging_review_item" ("organization_id", "source", "trigger_ref", "item_kind", "item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_review_item_one_open"
  ON "messaging_review_item" ("organization_id", "item_kind", "item_id") WHERE "state" = 'open';--> statement-breakpoint
CREATE INDEX "messaging_review_item_queue_idx"
  ON "messaging_review_item" ("organization_id", "state", "created_at");--> statement-breakpoint
-- Plain (not partial) so the trigger below and the service find a task's reviews in any state.
CREATE INDEX "messaging_review_item_item_idx"
  ON "messaging_review_item" ("organization_id", "item_kind", "item_id");--> statement-breakpoint
CREATE INDEX "messaging_review_item_patient_idx"
  ON "messaging_review_item" ("organization_id", "patient_id");--> statement-breakpoint
CREATE INDEX "messaging_review_item_subject_idx"
  ON "messaging_review_item" ("organization_id", "subject_user_id", "state");--> statement-breakpoint

-- A decided row is final. DELETE (tenant destruction) is not an UPDATE and is unaffected. Row-level BEFORE trigger, so it
-- fires before the audit trigger.
CREATE OR REPLACE FUNCTION messaging_review_item_refuse_resolved_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.state = 'resolved' THEN
    RAISE EXCEPTION 'messaging_review_item_resolved: a decided review item cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_messaging_review_item_resolved_final"
  BEFORE UPDATE ON messaging_review_item
  FOR EACH ROW EXECUTE FUNCTION messaging_review_item_refuse_resolved_update();--> statement-breakpoint

-- Closing the task by ANY path (its assignee or creator, a supervisor, offboarding) satisfies the rule: the open review of
-- that task is resolved as closed_elsewhere. SECURITY INVOKER: wardenx_app holds the column UPDATE below, and RLS applies.
-- A supervisor decision resolves the review row FIRST (service order), so this finds nothing open in that case.
-- resolved_by_user_id stays NULL here (who closed the task is on the task's own event row; arch:tenancy forbids reading
-- app.user_id outside an audit trigger), and the reason may be NULL for a non-clinical task.
CREATE OR REPLACE FUNCTION communication_task_resolve_review() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE messaging_review_item
     SET state = 'resolved',
         resolution = 'closed_elsewhere',
         resolution_reason = NEW.closed_reason,
         resolved_at = now(),
         version = version + 1,
         updated_at = now()
   WHERE organization_id = NEW.organization_id
     AND item_kind = 'task'
     AND item_id = NEW.id
     AND state = 'open';
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_communication_task_resolve_review"
  AFTER UPDATE OF status ON communication_task
  FOR EACH ROW
  WHEN (OLD.status IN ('open', 'accepted') AND NEW.status IN ('done', 'cancelled'))
  EXECUTE FUNCTION communication_task_resolve_review();--> statement-breakpoint

ALTER TABLE "messaging_review_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messaging_review_item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "messaging_review_item_org_isolation" ON "messaging_review_item"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "messaging_review_item" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("state", "resolution", "resolution_reason", "reassigned_to_user_id", "resolved_by_user_id", "resolved_at", "version", "updated_at")
  ON "messaging_review_item" TO wardenx_app;--> statement-breakpoint

-- Bespoke trigger so the patient and the trigger reference are recorded as changed without being copied into the immutable
-- log. A system write (the consumer, the task-close trigger under offboarding) runs with no app.user_id and is attributed
-- to the system actor.
CREATE OR REPLACE FUNCTION audit_phi_write_messaging_review_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['patient_id','trigger_ref']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['patient_id','trigger_ref']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'messaging_review_item.' || lower(TG_OP), 'messaging_review_item',
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
ALTER FUNCTION audit_phi_write_messaging_review_item() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_messaging_review_item"
  AFTER INSERT OR UPDATE OR DELETE ON messaging_review_item
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_messaging_review_item();--> statement-breakpoint

GRANT SELECT, DELETE ON "messaging_review_item" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "messaging_review_item_destruction" ON "messaging_review_item"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- ── permission: who may decide the queue (1102's shape) ──────────────────────────────────────────────────────────────────
-- A catalog row (category clinical, no ABAC) granted to the supervisory role keys, wherever a tenant has created them
-- (nothing materializes ROLE_TEMPLATES, so a tenant without a role is unchanged). NEVER org_admin, aides, volunteers or
-- compliance roles. A tenant tightens by removing the grant from a role it owns. Role keys are PROVISIONAL (no clinical-lead
-- sign-off recorded): clinical_supervisor / don mirror the supervisor alert audience; director_of_nursing is the platform
-- template; clinical_lead is the messaging member-admin role.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.review', 'review_item', 'manage', 'clinical', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.review'
  FROM "role" r
 WHERE r."key" IN ('clinical_supervisor', 'director_of_nursing', 'don', 'clinical_lead')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
