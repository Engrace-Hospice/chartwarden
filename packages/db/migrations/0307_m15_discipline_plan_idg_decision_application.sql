-- M15 — `discipline_plan_idg_decision_application` (F-234, #248): the durable, idempotent record that M15's
-- IDG-decision consumer handled one `idg.decision_recorded` whose kind is `discipline_plan_update`
-- (M15 spec §1.1 / §7.7 / §4.5 idempotency key `idgDecisionId`; the M7 `care_plan_idg_decision_application`
-- and M11/M12 equivalents are the precedent). UNIQUE (org, idg_decision_id): a redelivery finds the row and
-- is a no-op, so a decision is applied to a plan at most once.
--
-- `status = 'applied'`: the mutations landed on an open draft `idg_review` version (`version_id` set,
-- `mutations_applied` > 0) and `m15.idg_decision.applied` was published in the same transaction.
-- `status = 'refused'`: a contract violation that retrying can never fix (plan discharged / not yet signed,
-- a Part 2 (SUD) goal targeted, an off-plan element, a malformed mutation). The row is the terminal,
-- idempotent verdict (`refusal_reason` set, `version_id` NULL, nothing applied, NO event published). A
-- transient condition (no plan bootstrapped yet for the patient) is a THROW, not a row, so the relay retries.
--
-- Patient-bearing (logical `patient_id`; `plan_id` is an intra-module FK): organization_id +
-- provider_entity_id + location_id NOT NULL, denormalized from the plan root. Metadata only — no narrative
-- text lives here (the mutations land on discipline_goal / discipline_intervention, which carry their own
-- audit denylists). RLS pivots on organization_id alone (canonical `app.org_id`, ENABLED + FORCED); the app
-- role can INSERT/SELECT, no UPDATE/DELETE. Idempotent.

CREATE TABLE IF NOT EXISTS "discipline_plan_idg_decision_application" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "plan_id" uuid NOT NULL,
  "version_id" uuid,
  "idg_decision_id" uuid NOT NULL,
  "idg_meeting_id" uuid NOT NULL,
  "source_outbox_event_id" uuid NOT NULL,
  "status" text NOT NULL,
  "mutations_applied" integer DEFAULT 0 NOT NULL,
  "refusal_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "discipline_plan_idg_decision_application_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "discipline_plan_idg_decision_application_provider_entity_id_provider_entity_id_fk"
    FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "discipline_plan_idg_decision_application_location_id_location_id_fk"
    FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "discipline_plan_idg_decision_application_plan_id_discipline_care_plan_id_fk"
    FOREIGN KEY ("plan_id") REFERENCES "public"."discipline_care_plan"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "discipline_plan_idg_decision_application_version_id_discipline_care_plan_version_id_fk"
    FOREIGN KEY ("version_id") REFERENCES "public"."discipline_care_plan_version"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "discipline_plan_idg_decision_application_status_chk" CHECK ("status" IN ('applied', 'refused')),
  CONSTRAINT "discipline_plan_idg_decision_application_verdict_chk" CHECK (
    ("status" = 'applied' AND "version_id" IS NOT NULL AND "mutations_applied" > 0 AND "refusal_reason" IS NULL)
    OR ("status" = 'refused' AND "version_id" IS NULL AND "mutations_applied" = 0 AND "refusal_reason" IS NOT NULL)
  )
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "discipline_plan_idg_decision_application_decision_uq"
  ON "discipline_plan_idg_decision_application" ("organization_id", "idg_decision_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_plan_idg_decision_application_plan_idx"
  ON "discipline_plan_idg_decision_application" ("organization_id", "plan_id", "status");--> statement-breakpoint

ALTER TABLE "discipline_plan_idg_decision_application" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "discipline_plan_idg_decision_application" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "discipline_plan_idg_decision_application_org" ON "discipline_plan_idg_decision_application";--> statement-breakpoint
CREATE POLICY "discipline_plan_idg_decision_application_org" ON "discipline_plan_idg_decision_application"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "discipline_plan_idg_decision_application" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "discipline_plan_idg_decision_application" TO wardenx_admin;--> statement-breakpoint

-- M4 write-audit trigger (metadata only; nothing to scrub).
CREATE OR REPLACE FUNCTION audit_phi_write_discipline_plan_idg_decision_application() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'discipline_plan_idg_decision_application.' || lower(TG_OP),
    'discipline_plan_idg_decision_application',
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
ALTER FUNCTION audit_phi_write_discipline_plan_idg_decision_application() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_discipline_plan_idg_decision_application" ON "discipline_plan_idg_decision_application";--> statement-breakpoint
CREATE TRIGGER "trg_audit_discipline_plan_idg_decision_application" AFTER INSERT OR UPDATE OR DELETE ON discipline_plan_idg_decision_application
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_discipline_plan_idg_decision_application();--> statement-breakpoint

-- Patient destruction: M15's `discipline_plan_record` eraser deletes the discipline subtree, so the
-- destruction role needs SELECT + DELETE and an org-pinned policy on this child too.
GRANT SELECT, DELETE ON "discipline_plan_idg_decision_application" TO wardenx_destruction;--> statement-breakpoint
DROP POLICY IF EXISTS "discipline_plan_idg_decision_application_destruction" ON "discipline_plan_idg_decision_application";--> statement-breakpoint
CREATE POLICY "discipline_plan_idg_decision_application_destruction" ON "discipline_plan_idg_decision_application"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
