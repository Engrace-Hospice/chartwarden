-- M7 Phase 2 — governed IDG proposals.
--
-- M14 remains the owner of the IDG decision. M7 stores only the proposed care-plan mutations and
-- applies them when the governed idg_review version reaches quorum.

CREATE TYPE "public"."care_plan_idg_proposal_status" AS ENUM(
  'proposed',
  'in_review',
  'applied',
  'conflict'
);--> statement-breakpoint
CREATE TYPE "public"."care_plan_idg_proposed_change_status" AS ENUM(
  'proposed',
  'applied',
  'conflict'
);--> statement-breakpoint

ALTER TABLE "care_plan_idg_decision_application"
  ADD COLUMN IF NOT EXISTS "idg_meeting_id" uuid;--> statement-breakpoint
ALTER TABLE "care_plan_idg_decision_application"
  ADD COLUMN IF NOT EXISTS "status" "care_plan_idg_proposal_status" DEFAULT 'proposed' NOT NULL;--> statement-breakpoint
ALTER TABLE "care_plan_idg_decision_application"
  ADD COLUMN IF NOT EXISTS "baseline_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "care_plan_idg_decision_application"
  ADD COLUMN IF NOT EXISTS "proposed_at" timestamptz DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "care_plan_idg_decision_application"
  ADD COLUMN IF NOT EXISTS "in_review_at" timestamptz;--> statement-breakpoint
ALTER TABLE "care_plan_idg_decision_application"
  ADD COLUMN IF NOT EXISTS "conflict_reason" text;--> statement-breakpoint
ALTER TABLE "care_plan_idg_decision_application"
  ALTER COLUMN "applied_at" DROP NOT NULL;--> statement-breakpoint
UPDATE "care_plan_idg_decision_application"
  SET "status" = 'applied',
      "idg_meeting_id" = COALESCE("idg_meeting_id", "source_outbox_event_id")
  WHERE "applied_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "care_plan_idg_decision_application"
  ALTER COLUMN "idg_meeting_id" SET NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "care_plan_idg_proposed_change" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid,
  "location_id" uuid,
  "application_id" uuid NOT NULL,
  "care_plan_id" uuid NOT NULL,
  "care_plan_version_id" uuid NOT NULL,
  "idg_decision_id" uuid NOT NULL,
  "idg_meeting_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "entity_type" text NOT NULL,
  "operation" text NOT NULL,
  "target_entity_id" uuid,
  "before" jsonb,
  "proposed" jsonb NOT NULL,
  "status" "care_plan_idg_proposed_change_status" DEFAULT 'proposed' NOT NULL,
  "applied_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "care_plan_idg_change_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE restrict,
  CONSTRAINT "care_plan_idg_change_provider_fk"
    FOREIGN KEY ("provider_entity_id") REFERENCES "provider_entity"("id") ON DELETE restrict,
  CONSTRAINT "care_plan_idg_change_location_fk"
    FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE restrict,
  CONSTRAINT "care_plan_idg_change_application_fk"
    FOREIGN KEY ("application_id") REFERENCES "care_plan_idg_decision_application"("id") ON DELETE restrict,
  CONSTRAINT "care_plan_idg_change_plan_fk"
    FOREIGN KEY ("care_plan_id") REFERENCES "care_plan"("id") ON DELETE restrict,
  CONSTRAINT "care_plan_idg_change_version_fk"
    FOREIGN KEY ("care_plan_version_id") REFERENCES "care_plan_version"("id") ON DELETE restrict,
  CONSTRAINT "care_plan_idg_change_entity_type_ck"
    CHECK ("entity_type" IN ('problem', 'goal', 'intervention')),
  CONSTRAINT "care_plan_idg_change_operation_ck"
    CHECK ("operation" IN ('problem_add', 'problem_update', 'goal_add', 'goal_update', 'intervention_add', 'intervention_discontinue'))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "care_plan_idg_change_application_ordinal_uq"
  ON "care_plan_idg_proposed_change" ("application_id", "ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "care_plan_idg_change_decision_ordinal_uq"
  ON "care_plan_idg_proposed_change" ("organization_id", "idg_decision_id", "ordinal");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "care_plan_idg_change_version_idx"
  ON "care_plan_idg_proposed_change" ("care_plan_version_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "care_plan_idg_decision_application_version_status_idx"
  ON "care_plan_idg_decision_application" ("care_plan_version_id", "status");--> statement-breakpoint

ALTER TABLE "care_plan_idg_proposed_change" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "care_plan_idg_proposed_change" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "care_plan_idg_proposed_change_org" ON "care_plan_idg_proposed_change";--> statement-breakpoint
CREATE POLICY "care_plan_idg_proposed_change_org" ON "care_plan_idg_proposed_change"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "care_plan_idg_decision_application" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "care_plan_idg_proposed_change" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "care_plan_idg_proposed_change" TO wardenx_admin;--> statement-breakpoint

CREATE TRIGGER "care_plan_idg_proposed_change_audit"
  AFTER INSERT OR UPDATE OR DELETE ON care_plan_idg_proposed_change
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_care_plan_idg_proposal_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('in_review', 'applied') THEN
    IF NEW.baseline_snapshot IS DISTINCT FROM OLD.baseline_snapshot THEN
      RAISE EXCEPTION 'care_plan_idg_decision_application.baseline_snapshot is immutable in review/applied'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.care_plan_version_id IS DISTINCT FROM OLD.care_plan_version_id THEN
      RAISE EXCEPTION 'care_plan_idg_decision_application.version is immutable in review/applied'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_care_plan_idg_proposal_integrity ON care_plan_idg_decision_application;--> statement-breakpoint
CREATE TRIGGER trg_care_plan_idg_proposal_integrity
BEFORE UPDATE ON care_plan_idg_decision_application
FOR EACH ROW
EXECUTE FUNCTION enforce_care_plan_idg_proposal_integrity();--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_care_plan_idg_change_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('applied', 'conflict') THEN
    IF NEW.before IS DISTINCT FROM OLD.before OR NEW.proposed IS DISTINCT FROM OLD.proposed THEN
      RAISE EXCEPTION 'care_plan_idg_proposed_change payload is immutable after terminal state'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_care_plan_idg_change_integrity ON care_plan_idg_proposed_change;--> statement-breakpoint
CREATE TRIGGER trg_care_plan_idg_change_integrity
BEFORE UPDATE ON care_plan_idg_proposed_change
FOR EACH ROW
EXECUTE FUNCTION enforce_care_plan_idg_change_integrity();
