-- compat: expand
-- M9 longitudinal wounds (1 of 2): the `wound` register. A patient has wounds; each wound is observed again and again
-- over its life (`wound_observation`, migration 1529) and is finally resolved. This table is the identity of the wound,
-- not what was seen on a visit: where it is, what caused it, whether it came with the patient, and whether it is still open.
--   * Everything is CODED. No free text, so there is nothing for a sealing or screening layer to catch.
--   * Tenancy: the three-column rule. provider_entity_id / location_id are nullable and stay NULL for now (no published seam
--     carries a patient-level siting; the clinical_assessment precedent, migration 0129).
--   * The application role can INSERT, and can only close a wound (status, closed_on, updated_at); a guard trigger makes the
--     close one-way (open -> healed | resolved_other) and freezes the identity columns. No DELETE for the application role;
--     the destruction role may read and delete one organisation's rows (patient destruction, the 0481 pattern).
--   * Reads are audited by the route's read-audit; writes by the trigger below.
-- Roles are the post-1139 names (chartwarden_*).
CREATE TABLE "wound" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "patient_id" uuid NOT NULL,
  "site_code" text NOT NULL,
  "laterality" text NOT NULL,
  "etiology" text NOT NULL,
  "acquired" text DEFAULT 'unknown' NOT NULL,
  "onset_on" date,
  "status" text DEFAULT 'open' NOT NULL,
  "closed_on" date,
  "created_by_membership_id" uuid NOT NULL REFERENCES "membership"("id") ON DELETE RESTRICT,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "wound_site_code_chk" CHECK ("site_code" IN ('sacrum', 'coccyx', 'ischium', 'trochanter', 'buttock', 'hip', 'sacral_perineal', 'spine', 'back', 'scapula', 'shoulder', 'elbow', 'arm', 'hand', 'chest', 'abdomen', 'groin', 'thigh', 'knee', 'calf_shin', 'ankle', 'malleolus', 'heel', 'foot', 'toe', 'ear', 'head', 'face', 'neck', 'other')),
  CONSTRAINT "wound_laterality_chk" CHECK ("laterality" IN ('left', 'right', 'midline', 'bilateral', 'not_applicable')),
  CONSTRAINT "wound_etiology_chk" CHECK ("etiology" IN ('pressure_injury', 'diabetic_ulcer', 'venous_ulcer', 'arterial_ulcer', 'surgical', 'traumatic', 'skin_tear', 'malignant_fungating', 'moisture_associated', 'other')),
  CONSTRAINT "wound_acquired_chk" CHECK ("acquired" IN ('present_on_admission', 'acquired_in_care', 'unknown')),
  CONSTRAINT "wound_status_chk" CHECK ("status" IN ('open', 'healed', 'resolved_other')),
  CONSTRAINT "wound_closed_on_chk" CHECK (("status" = 'open') = ("closed_on" IS NULL)),
  CONSTRAINT "wound_onset_before_close_chk" CHECK ("onset_on" IS NULL OR "closed_on" IS NULL OR "onset_on" <= "closed_on"),
  -- The target of wound_observation's composite FK: an observation can only name a wound of its own organisation AND patient.
  CONSTRAINT "wound_id_org_patient_uq" UNIQUE ("id", "organization_id", "patient_id")
);--> statement-breakpoint
-- The chart list: one patient's wounds, open first. Leads with organization_id, which also covers that FK.
CREATE INDEX "wound_patient_status_idx" ON "wound" ("organization_id", "patient_id", "status", "created_at");--> statement-breakpoint

ALTER TABLE "wound" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wound" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "wound_org_isolation" ON "wound"
  FOR ALL TO chartwarden_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "wound" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("status", "closed_on", "updated_at") ON "wound" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, DELETE ON "wound" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "wound_destruction" ON "wound"
  FOR ALL TO chartwarden_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- Closing a wound is one-way and touches nothing but the close columns. The column-level UPDATE grant already keeps the
-- application role off the identity columns; this guard holds for every role and refuses a re-open.
CREATE OR REPLACE FUNCTION wound_update_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'closed_on' - 'updated_at') <> (to_jsonb(OLD) - 'status' - 'closed_on' - 'updated_at') THEN
    RAISE EXCEPTION 'wound: the identity of a wound cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'wound: a resolved wound cannot be changed or re-opened' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_wound_update_guard"
  BEFORE UPDATE ON "wound"
  FOR EACH ROW EXECUTE FUNCTION wound_update_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_wound() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
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
ALTER FUNCTION audit_phi_write_wound() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_wound"
  AFTER INSERT OR UPDATE OR DELETE ON wound
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_wound();
