-- compat: expand
-- M9 longitudinal wounds (2 of 2): `wound_observation`, one dated look at a wound. Each visit adds observations to a wound
-- (migration 1530); the visit note (M8) states the ones recorded at its encounter by reading them through the
-- WoundProvider seam. M9 may not import M8, so `source_encounter_id` is a logical uuid with no FK.
--   * Everything is CODED or numeric (no free text), so nothing needs sealing and nothing can hold a typed identifier. Even
--     the reason for a correction is a code.
--   * APPEND-ONLY, by the M9 convention (clinical_assessment): a correction INSERTs a new row that names the one it corrects
--     (corrects_observation_id + a coded reason) and the AFTER INSERT trigger flips the target to `superseded`, version + 1.
--     Unlike clinical_assessment the guard is total: the application role holds no UPDATE on any value column (only
--     status + version), and a BEFORE UPDATE trigger refuses every change but that one flip, for every role.
--   * An observation can only name a wound of its own organisation AND patient (composite FK to wound's unique triple).
--   * Tenancy: the three-column rule (provider_entity_id / location_id nullable, NULL for now). RLS enabled and FORCEd.
--     The destruction role may read and delete one organisation's rows (patient destruction, the 0481 pattern).
-- Roles are the post-1139 names (chartwarden_*).

-- A text[] holds no repeated value and no NULL element (a CHECK cannot hold a sub-select, so the count lives here).
CREATE OR REPLACE FUNCTION wound_text_array_is_set(a text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT a IS NULL OR cardinality(a) = (SELECT count(DISTINCT x) FROM unnest(a) AS x)
$$;--> statement-breakpoint

CREATE TABLE "wound_observation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "wound_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "observed_by_membership_id" uuid NOT NULL REFERENCES "membership"("id") ON DELETE RESTRICT,
  "source_encounter_id" uuid,
  "stage" text,
  "length_cm" numeric(5,1),
  "width_cm" numeric(5,1),
  "depth_cm" numeric(5,1),
  "undermining" boolean,
  "wound_bed" text[] DEFAULT '{}' NOT NULL,
  "exudate_amount" text,
  "exudate_type" text,
  "odor" text,
  "periwound" text[] DEFAULT '{}' NOT NULL,
  "pain_score" smallint,
  "dressing" text,
  "dressing_changed" boolean,
  "infection_signs" boolean,
  "trend" text,
  "status" text DEFAULT 'active' NOT NULL,
  "corrects_observation_id" uuid REFERENCES "wound_observation"("id"),
  "correction_reason" text,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "wound_observation_wound_fk" FOREIGN KEY ("wound_id", "organization_id", "patient_id")
    REFERENCES "wound"("id", "organization_id", "patient_id") ON DELETE RESTRICT,
  CONSTRAINT "wound_observation_stage_chk" CHECK ("stage" IN ('stage_1', 'stage_2', 'stage_3', 'stage_4', 'unstageable', 'deep_tissue_injury')),
  CONSTRAINT "wound_observation_length_chk" CHECK ("length_cm" >= 0 AND "length_cm" <= 100),
  CONSTRAINT "wound_observation_width_chk" CHECK ("width_cm" >= 0 AND "width_cm" <= 100),
  CONSTRAINT "wound_observation_depth_chk" CHECK ("depth_cm" >= 0 AND "depth_cm" <= 30),
  CONSTRAINT "wound_observation_depth_needs_area_chk" CHECK ("depth_cm" IS NULL OR ("length_cm" IS NOT NULL AND "width_cm" IS NOT NULL)),
  CONSTRAINT "wound_observation_wound_bed_chk" CHECK ("wound_bed" <@ ARRAY['granulation', 'slough', 'eschar', 'epithelializing', 'necrotic', 'hypergranulation', 'bone_or_tendon_exposed']::text[] AND wound_text_array_is_set("wound_bed")),
  CONSTRAINT "wound_observation_exudate_amount_chk" CHECK ("exudate_amount" IN ('none', 'scant', 'small', 'moderate', 'large')),
  CONSTRAINT "wound_observation_exudate_type_chk" CHECK ("exudate_type" IN ('serous', 'serosanguineous', 'sanguineous', 'purulent')),
  CONSTRAINT "wound_observation_odor_chk" CHECK ("odor" IN ('none', 'mild', 'moderate', 'strong')),
  CONSTRAINT "wound_observation_periwound_chk" CHECK ("periwound" <@ ARRAY['intact', 'erythema', 'macerated', 'indurated', 'edematous', 'warm', 'excoriated']::text[] AND wound_text_array_is_set("periwound")),
  CONSTRAINT "wound_observation_periwound_intact_chk" CHECK (NOT ('intact' = ANY("periwound") AND cardinality("periwound") > 1)),
  CONSTRAINT "wound_observation_pain_chk" CHECK ("pain_score" BETWEEN 0 AND 10),
  CONSTRAINT "wound_observation_dressing_chk" CHECK ("dressing" IN ('foam', 'hydrocolloid', 'alginate', 'hydrogel', 'gauze', 'silver', 'transparent_film', 'negative_pressure', 'other')),
  CONSTRAINT "wound_observation_dressing_changed_chk" CHECK ("dressing_changed" IS NOT TRUE OR "dressing" IS NOT NULL),
  CONSTRAINT "wound_observation_trend_chk" CHECK ("trend" IN ('new', 'improving', 'stable', 'worsening')),
  CONSTRAINT "wound_observation_status_chk" CHECK ("status" IN ('active', 'superseded')),
  CONSTRAINT "wound_observation_correction_reason_chk" CHECK ("correction_reason" IN ('entered_on_wrong_wound', 'measurement_error', 'assessment_error', 'wrong_visit', 'other')),
  CONSTRAINT "wound_observation_correction_pair_chk" CHECK (("corrects_observation_id" IS NULL) = ("correction_reason" IS NULL)),
  CONSTRAINT "wound_observation_not_self_correcting_chk" CHECK ("corrects_observation_id" IS NULL OR "corrects_observation_id" <> "id"),
  CONSTRAINT "wound_observation_version_chk" CHECK ("version" >= 1)
);--> statement-breakpoint
-- A wound's history, newest first. The leading three columns are the composite FK to wound, so this also covers that FK.
CREATE INDEX "wound_observation_wound_idx" ON "wound_observation" ("wound_id", "organization_id", "patient_id", "observed_at" DESC, "id");--> statement-breakpoint
-- The chart: one patient's latest observations. Leads with organization_id, which also covers that FK.
CREATE INDEX "wound_observation_patient_idx" ON "wound_observation" ("organization_id", "patient_id", "observed_at" DESC);--> statement-breakpoint
-- The visit note's read: the current observations of one encounter.
CREATE INDEX "wound_observation_encounter_idx" ON "wound_observation" ("organization_id", "source_encounter_id", "observed_at", "id")
  WHERE "source_encounter_id" IS NOT NULL AND "status" = 'active';--> statement-breakpoint
-- Covers the self-FK of a correction.
CREATE INDEX "wound_observation_corrects_idx" ON "wound_observation" ("corrects_observation_id")
  WHERE "corrects_observation_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "wound_observation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wound_observation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "wound_observation_org_isolation" ON "wound_observation"
  FOR ALL TO chartwarden_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- Append-only: insert an observation, supersede it by a correction (status + version only), never delete.
GRANT SELECT, INSERT ON "wound_observation" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("status", "version") ON "wound_observation" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, DELETE ON "wound_observation" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "wound_observation_destruction" ON "wound_observation"
  FOR ALL TO chartwarden_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- INSERT: a new observation is always active, and only a pressure injury carries a stage (the one rule that spans two tables).
CREATE OR REPLACE FUNCTION wound_observation_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_etiology text;
BEGIN
  IF NEW.status <> 'active' OR NEW.version <> 1 THEN
    RAISE EXCEPTION 'wound_observation: a new observation is active, version 1' USING ERRCODE = '23514';
  END IF;
  IF NEW.stage IS NOT NULL THEN
    SELECT etiology INTO v_etiology FROM wound WHERE id = NEW.wound_id AND organization_id = NEW.organization_id;
    IF v_etiology IS DISTINCT FROM 'pressure_injury' THEN
      RAISE EXCEPTION 'wound_observation: only a pressure injury carries a stage' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_wound_observation_insert_guard"
  BEFORE INSERT ON "wound_observation"
  FOR EACH ROW EXECUTE FUNCTION wound_observation_insert_guard();--> statement-breakpoint

-- UPDATE: the one change allowed is the supersede flip (active -> superseded, version + 1) and only when the correction's own
-- AFTER INSERT trigger makes it (trigger depth 2), for every role. A direct UPDATE of any kind, the same flip included, is
-- refused: a recorded observation is corrected by a new one, never edited or hidden.
CREATE OR REPLACE FUNCTION wound_observation_update_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF pg_trigger_depth() > 1
     AND OLD.status = 'active' AND NEW.status = 'superseded' AND NEW.version = OLD.version + 1
     AND (to_jsonb(NEW) - 'status' - 'version') = (to_jsonb(OLD) - 'status' - 'version') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'wound_observation: a recorded observation cannot be changed; correct it with a new observation'
    USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_wound_observation_update_guard"
  BEFORE UPDATE ON "wound_observation"
  FOR EACH ROW EXECUTE FUNCTION wound_observation_update_guard();--> statement-breakpoint

-- AFTER INSERT of a correction: flip the observation it corrects. The target must be an active observation of the same
-- organisation, wound and patient, else the whole insert fails.
CREATE OR REPLACE FUNCTION wound_observation_supersede_on_correction() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.corrects_observation_id IS NOT NULL THEN
    UPDATE wound_observation
       SET status = 'superseded', version = version + 1
     WHERE id = NEW.corrects_observation_id
       AND organization_id = NEW.organization_id
       AND wound_id = NEW.wound_id
       AND patient_id = NEW.patient_id
       AND status = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'wound_observation: the observation to correct is not an active observation of the same wound'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_wound_observation_supersede_on_correction"
  AFTER INSERT ON "wound_observation"
  FOR EACH ROW EXECUTE FUNCTION wound_observation_supersede_on_correction();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_wound_observation() RETURNS trigger
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
ALTER FUNCTION audit_phi_write_wound_observation() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_wound_observation"
  AFTER INSERT OR UPDATE OR DELETE ON wound_observation
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_wound_observation();
