-- compat: expand
-- ADR-0109 D3 - `bereavement_assessment_task`: the two risk-assessment checkpoints of the Medicare-aligned timeline (initial assessment
-- at death + 28 days, midpoint reassessment at death + 180 days) as TASKS, never `bereavement_outreach` rows. An outreach row for a
-- checkpoint would count in the M30 CoP 418.64(d) numerator for a contact nobody made.
--   * One row per (contact, task_kind), generated at plan seed and topped up forward-only on the regenerate paths. The partial index below is
--     what the hourly miss pass scans (scheduled tasks past `late_grace_until`).
--   * Lifecycle: scheduled -> completed | missed | cancelled; missed -> completed (a late human assessment still closes the task);
--     cancelled -> scheduled (a rescinded opt-out / resumed plan revives the forward tasks). `completed` is terminal.
--   * `risk_score_id` points at the immutable `bereavement_risk_score` row a HUMAN-appended score produced; the automatic initial score
--     at plan seed does not complete a task.
--   * No free text (no audit denylist); ids, status and instants only. `assignee_user_id` / `completed_by_membership_id` are logical M2 uuids.
-- Patient-bearing through the plan: carries organization_id NOT NULL + provider_entity_id NOT NULL + location_id (nullable) (three-column rule).
CREATE TABLE "bereavement_assessment_task" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "plan_id" uuid NOT NULL REFERENCES "bereavement_plan"("id") ON DELETE RESTRICT,
  "bereaved_contact_id" uuid NOT NULL REFERENCES "bereaved_contact"("id") ON DELETE RESTRICT,
  "task_kind" text NOT NULL,
  "status" text DEFAULT 'scheduled' NOT NULL,
  "due_at" timestamptz NOT NULL,
  "late_grace_until" timestamptz NOT NULL,
  "completed_at" timestamptz,
  "completed_by_membership_id" uuid,
  "risk_score_id" uuid REFERENCES "bereavement_risk_score"("id") ON DELETE RESTRICT,
  "assignee_user_id" uuid,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "berv_assessment_task_kind_chk" CHECK ("task_kind" IN ('initial_assessment', 'midpoint_reassessment')),
  CONSTRAINT "berv_assessment_task_status_chk" CHECK ("status" IN ('scheduled', 'completed', 'missed', 'cancelled')),
  CONSTRAINT "berv_assessment_task_grace_after_due" CHECK ("late_grace_until" >= "due_at"),
  -- A completed task names the human score and the instant it was completed; no other status carries either.
  CONSTRAINT "berv_assessment_task_completion_chk" CHECK (
    ("status" = 'completed') = ("completed_at" IS NOT NULL AND "risk_score_id" IS NOT NULL)
  )
);--> statement-breakpoint
-- One checkpoint of each kind per contact: the seed and every forward top-up are ON CONFLICT DO NOTHING against this.
CREATE UNIQUE INDEX "berv_assessment_task_contact_kind_uniq" ON "bereavement_assessment_task" ("bereaved_contact_id", "task_kind");--> statement-breakpoint
CREATE INDEX "berv_assessment_task_plan_due_idx" ON "bereavement_assessment_task" ("plan_id", "due_at");--> statement-breakpoint
-- The hourly miss pass: scheduled tasks whose late grace has passed.
CREATE INDEX "berv_assessment_task_scheduled_grace_idx" ON "bereavement_assessment_task" ("organization_id", "late_grace_until") WHERE "status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "berv_assessment_task_org_ix" ON "bereavement_assessment_task" ("organization_id", "created_at");--> statement-breakpoint
CREATE INDEX "berv_assessment_task_risk_score_idx" ON "bereavement_assessment_task" ("risk_score_id") WHERE "risk_score_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "berv_assessment_task_provider_entity_idx" ON "bereavement_assessment_task" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX "berv_assessment_task_location_idx" ON "bereavement_assessment_task" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint

-- RLS on app.org_id (FORCEd). The app role reads, inserts and updates; nothing deletes (destruction goes through the admin-run eraser).
ALTER TABLE "bereavement_assessment_task" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bereavement_assessment_task" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bereavement_assessment_task_org_isolation" ON "bereavement_assessment_task"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "bereavement_assessment_task" TO chartwarden_app;--> statement-breakpoint

-- The 1200 PHI audit pattern. The row carries no free text, so nothing is scrubbed (structural capture only).
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_assessment_task() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_before jsonb; v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    TG_ARGV[0] || '.' || lower(TG_OP), TG_ARGV[0],
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
ALTER FUNCTION audit_phi_write_bereavement_assessment_task() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_assessment_task"
  AFTER INSERT OR UPDATE OR DELETE ON bereavement_assessment_task
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_assessment_task('bereavement_assessment_task');
