-- compat: expand
-- M8 (WF09): the nutrition and hydration status a clinician records on one visit. A brand-new table the previous release never reads
-- or writes, so this is a pure expand.
--
--   encounter_nutrition  one row per encounter (UNIQUE encounter_id; the PUT route upserts, replacing the whole record while the
--                        encounter is an editable draft). appetite, meal_intake_percent (a whole percent 0..100), fluid_intake,
--                        swallowing and support, each nullable (NULL = not assessed). Values are text + CHECK, not pg enums; the CHECK
--                        lists mirror the APPETITE_LEVELS / FLUID_INTAKE_LEVELS / SWALLOWING_LEVELS / NUTRITION_SUPPORTS constants of
--                        @chartwarden/hearthnote and findings-schema-parity.test.ts fails when either side drifts.
--
-- Tenancy, foreign-key indexes, audit snapshot and roles: exactly as 1528 (encounter_adl). No free-text column.
CREATE TABLE "encounter_nutrition" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "encounter_id" uuid NOT NULL REFERENCES "encounter"("id") ON DELETE CASCADE,
  "appetite" text,
  "meal_intake_percent" smallint,
  "fluid_intake" text,
  "swallowing" text,
  "support" text,
  "created_by_membership_id" uuid NOT NULL REFERENCES "membership"("id") ON DELETE RESTRICT,
  "updated_by_membership_id" uuid NOT NULL REFERENCES "membership"("id") ON DELETE RESTRICT,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "encounter_nutrition_encounter_id_unique" UNIQUE ("encounter_id"),
  CONSTRAINT "encounter_nutrition_appetite_level" CHECK (appetite IS NULL OR appetite IN ('good', 'fair', 'poor', 'none')),
  CONSTRAINT "encounter_nutrition_meal_intake_percent_range" CHECK (meal_intake_percent IS NULL OR meal_intake_percent BETWEEN 0 AND 100),
  CONSTRAINT "encounter_nutrition_fluid_intake_level" CHECK (fluid_intake IS NULL OR fluid_intake IN ('adequate', 'decreased', 'minimal')),
  CONSTRAINT "encounter_nutrition_swallowing_level" CHECK (swallowing IS NULL OR swallowing IN ('no_difficulty', 'difficulty_solids', 'difficulty_liquids', 'difficulty_solids_and_liquids', 'unable_to_swallow')),
  CONSTRAINT "encounter_nutrition_support_level" CHECK (support IS NULL OR support IN ('none', 'oral_supplements', 'tube_feeding', 'parenteral'))
);--> statement-breakpoint
CREATE INDEX "encounter_nutrition_org_ix" ON "encounter_nutrition" ("organization_id", "created_at");--> statement-breakpoint

ALTER TABLE "encounter_nutrition" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encounter_nutrition" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "encounter_nutrition_org_isolation" ON "encounter_nutrition"
  FOR ALL TO chartwarden_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- The PUT upserts, so INSERT + UPDATE; no DELETE. Destroying a patient is NOT done by the cascade: the M8 `encounter_record` eraser only
-- TOMBSTONES the `encounter` root (the row survives), so the ON DELETE CASCADE on encounter_id never fires there (it only covers a hard
-- delete of the encounter row). The eraser deletes this table's rows by name, as `chartwarden_destruction`, which holds DELETE below.
GRANT SELECT, INSERT ON "encounter_nutrition" TO chartwarden_app;--> statement-breakpoint
-- UPDATE is column-level: the value columns and the update stamps only, so the application role cannot rewrite what a record IS
-- (id, tenant, siting, encounter, creator, creation time). The guard trigger below holds the same line for every other role.
GRANT UPDATE ("appetite", "meal_intake_percent", "fluid_intake", "swallowing", "support", "updated_by_membership_id", "updated_at") ON "encounter_nutrition" TO chartwarden_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION encounter_nutrition_update_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
     OR NEW.created_by_membership_id IS DISTINCT FROM OLD.created_by_membership_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'encounter_nutrition: the identity of a record cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_encounter_nutrition_update_guard"
  BEFORE UPDATE ON "encounter_nutrition"
  FOR EACH ROW EXECUTE FUNCTION encounter_nutrition_update_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_encounter_nutrition() RETURNS trigger
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
ALTER FUNCTION audit_phi_write_encounter_nutrition() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_encounter_nutrition"
  AFTER INSERT OR UPDATE OR DELETE ON encounter_nutrition
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_encounter_nutrition();--> statement-breakpoint

-- Tenant destruction (the 1099 / 1478 / 1514 pattern): the destruction role may read and delete one organization's rows.
GRANT SELECT, DELETE ON "encounter_nutrition" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "encounter_nutrition_destruction" ON "encounter_nutrition"
  FOR ALL TO chartwarden_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
