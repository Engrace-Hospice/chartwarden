-- compat: expand
-- ADR-0109 D5 - `bereavement_risk_assessment_draft`: the eight D17 risk factors for an ADMISSION, recorded by an MSW, chaplain or
-- bereavement counselor on the patient's care team (or bereavement oversight) BEFORE the death. At plan seed the draft is carried into
-- the initial risk score ("true wins": it never lowers a derived risk) and stamped `carried_score_id` / `carried_at`.
--   * One draft per (organization, admission). It exists before any bereavement plan, so it keys on the admission, not on a plan;
--     `patient_id` / `admission_id` are logical uuids (M5 / M6 own those rows; no cross-module FK).
--   * `factors_jsonb` holds exactly the eight rubric keys, each true | false | "unknown" (default all unknown). The CHECK pins the key set
--     and the object shape; the tri-state values are validated at the route boundary (a CHECK may not run a subquery). NO free text.
--   * The substance-use slot is forced "unknown" by the service unless the writer is cleared for 42 CFR Part 2 content.
--   * Writable only while no plan exists for the admission: the service checks it in the same transaction as the write (409 DRAFT_LOCKED).
--   * `version` is the If-Match token: 1 on the first write, +1 per edit; a draft that does not exist yet reads as version 0, so the first
--     PUT names `If-Match: "0"`. No DELETE for the app role (destruction goes through the admin-run eraser).
-- Patient-bearing: carries organization_id NOT NULL + provider_entity_id NOT NULL + location_id (nullable) (three-column rule), sited from
-- the admission.
CREATE TABLE "bereavement_risk_assessment_draft" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "patient_id" uuid NOT NULL,
  "admission_id" uuid NOT NULL,
  "factors_jsonb" jsonb DEFAULT '{"ambivalentRelationship":"unknown","suddenUnexpectedDeath":"unknown","priorUnresolvedLoss":"unknown","preExistingMentalHealth":"unknown","socialIsolation":"unknown","financialStrain":"unknown","primaryCaregiverRole":"unknown","activeSubstanceUse":"unknown"}'::jsonb NOT NULL,
  "last_edited_by_membership_id" uuid NOT NULL,
  "last_edited_discipline" text NOT NULL,
  "carried_score_id" uuid REFERENCES "bereavement_risk_score"("id") ON DELETE RESTRICT,
  "carried_at" timestamptz,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "berv_assessment_draft_factors_chk" CHECK (
    jsonb_typeof("factors_jsonb") = 'object'
    AND "factors_jsonb" ?& ARRAY['ambivalentRelationship', 'suddenUnexpectedDeath', 'priorUnresolvedLoss', 'preExistingMentalHealth',
                                  'socialIsolation', 'financialStrain', 'primaryCaregiverRole', 'activeSubstanceUse']
  ),
  CONSTRAINT "berv_assessment_draft_discipline_chk" CHECK (char_length(btrim("last_edited_discipline")) BETWEEN 1 AND 64),
  -- A draft is carried once: the score and the instant are stamped together or not at all.
  CONSTRAINT "berv_assessment_draft_carried_chk" CHECK (("carried_score_id" IS NULL) = ("carried_at" IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "berv_assessment_draft_admission_uniq" ON "bereavement_risk_assessment_draft" ("organization_id", "admission_id");--> statement-breakpoint
CREATE INDEX "berv_assessment_draft_patient_idx" ON "bereavement_risk_assessment_draft" ("organization_id", "patient_id");--> statement-breakpoint
CREATE INDEX "berv_assessment_draft_org_ix" ON "bereavement_risk_assessment_draft" ("organization_id", "created_at");--> statement-breakpoint
CREATE INDEX "berv_assessment_draft_carried_score_idx" ON "bereavement_risk_assessment_draft" ("carried_score_id") WHERE "carried_score_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "berv_assessment_draft_provider_entity_idx" ON "bereavement_risk_assessment_draft" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX "berv_assessment_draft_location_idx" ON "bereavement_risk_assessment_draft" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint

-- RLS on app.org_id (FORCEd). The app role reads, inserts and updates; nothing deletes.
ALTER TABLE "bereavement_risk_assessment_draft" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bereavement_risk_assessment_draft" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bereavement_risk_assessment_draft_org_isolation" ON "bereavement_risk_assessment_draft"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "bereavement_risk_assessment_draft" TO chartwarden_app;--> statement-breakpoint

-- The 1200 PHI audit pattern. The row holds eight tri-state values and no free text, so nothing is scrubbed.
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_risk_assessment_draft() RETURNS trigger
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
ALTER FUNCTION audit_phi_write_bereavement_risk_assessment_draft() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_risk_assessment_draft"
  AFTER INSERT OR UPDATE OR DELETE ON bereavement_risk_assessment_draft
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_risk_assessment_draft('bereavement_risk_assessment_draft');
