-- compat: expand
-- M8 (WF09): the functional status (ADLs) a clinician records on one visit. A brand-new table the previous release never reads or
-- writes, so this is a pure expand.
--
--   encounter_adl  one row per encounter (UNIQUE encounter_id; the PUT route upserts, replacing the whole record while the encounter is an
--                  editable draft). One nullable text column per ADL item (NULL = not assessed), bladder / bowel continence, and the
--                  devices in use. Values are text + CHECK, not pg enums, so a value set can widen later without ALTER TYPE; the CHECK
--                  lists mirror the ADL_LEVELS / CONTINENCE_LEVELS / ADL_DEVICES constants of @chartwarden/hearthnote and
--                  findings-schema-parity.test.ts fails when either side drifts.
--
-- Tenancy: PHI, so the three columns. provider_entity_id / location_id are nullable and denormalized from the parent encounter (the
-- 0128 relaxation every M8 satellite carries: the draft route may not know a siting). RLS keys on app.org_id alone, ENABLEd and FORCEd.
-- Foreign keys: organization_id is indexed (encounter_adl_org_ix), encounter_id by its UNIQUE constraint; the siting and membership
-- stamps reference soft-deleted parents (the fk-index-coverage rule sanctions those unindexed).
-- No free-text column, so the audit snapshot carries the whole row (no scrub list).
-- Roles are the post-1139 names (chartwarden_*).
CREATE TABLE "encounter_adl" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "encounter_id" uuid NOT NULL REFERENCES "encounter"("id") ON DELETE CASCADE,
  "bathing" text,
  "dressing" text,
  "grooming" text,
  "toileting" text,
  "transferring" text,
  "ambulation" text,
  "eating" text,
  "bladder" text,
  "bowel" text,
  "devices" text[] DEFAULT '{}'::text[] NOT NULL,
  "created_by_membership_id" uuid NOT NULL REFERENCES "membership"("id") ON DELETE RESTRICT,
  "updated_by_membership_id" uuid NOT NULL REFERENCES "membership"("id") ON DELETE RESTRICT,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "encounter_adl_encounter_id_unique" UNIQUE ("encounter_id"),
  CONSTRAINT "encounter_adl_bathing_level" CHECK (bathing IS NULL OR bathing IN ('independent', 'supervision', 'limited_assist', 'extensive_assist', 'total_dependence', 'did_not_occur')),
  CONSTRAINT "encounter_adl_dressing_level" CHECK (dressing IS NULL OR dressing IN ('independent', 'supervision', 'limited_assist', 'extensive_assist', 'total_dependence', 'did_not_occur')),
  CONSTRAINT "encounter_adl_grooming_level" CHECK (grooming IS NULL OR grooming IN ('independent', 'supervision', 'limited_assist', 'extensive_assist', 'total_dependence', 'did_not_occur')),
  CONSTRAINT "encounter_adl_toileting_level" CHECK (toileting IS NULL OR toileting IN ('independent', 'supervision', 'limited_assist', 'extensive_assist', 'total_dependence', 'did_not_occur')),
  CONSTRAINT "encounter_adl_transferring_level" CHECK (transferring IS NULL OR transferring IN ('independent', 'supervision', 'limited_assist', 'extensive_assist', 'total_dependence', 'did_not_occur')),
  CONSTRAINT "encounter_adl_ambulation_level" CHECK (ambulation IS NULL OR ambulation IN ('independent', 'supervision', 'limited_assist', 'extensive_assist', 'total_dependence', 'did_not_occur')),
  CONSTRAINT "encounter_adl_eating_level" CHECK (eating IS NULL OR eating IN ('independent', 'supervision', 'limited_assist', 'extensive_assist', 'total_dependence', 'did_not_occur')),
  CONSTRAINT "encounter_adl_bladder_level" CHECK (bladder IS NULL OR bladder IN ('continent', 'occasionally_incontinent', 'frequently_incontinent', 'incontinent', 'catheter_or_ostomy')),
  CONSTRAINT "encounter_adl_bowel_level" CHECK (bowel IS NULL OR bowel IN ('continent', 'occasionally_incontinent', 'frequently_incontinent', 'incontinent', 'catheter_or_ostomy')),
  CONSTRAINT "encounter_adl_devices_known" CHECK (devices <@ ARRAY['cane', 'walker', 'wheelchair', 'hospital_bed', 'mechanical_lift', 'bedside_commode']::text[])
);--> statement-breakpoint
CREATE INDEX "encounter_adl_org_ix" ON "encounter_adl" ("organization_id", "created_at");--> statement-breakpoint

ALTER TABLE "encounter_adl" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encounter_adl" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "encounter_adl_org_isolation" ON "encounter_adl"
  FOR ALL TO chartwarden_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- The PUT upserts, so INSERT + UPDATE; no DELETE (a record is replaced, and a cleared one is a row of NULLs). Destroying a patient is
-- NOT done by the cascade: the M8 `encounter_record` eraser only TOMBSTONES the `encounter` root (the row survives), so the ON DELETE
-- CASCADE on encounter_id never fires there (it only covers a hard delete of the encounter row). The eraser deletes this table's rows by
-- name, as `chartwarden_destruction`, which is why that role holds DELETE below.
GRANT SELECT, INSERT ON "encounter_adl" TO chartwarden_app;--> statement-breakpoint
-- UPDATE is column-level: the value columns and the update stamps only, so the application role cannot rewrite what a record IS
-- (id, tenant, siting, encounter, creator, creation time). The guard trigger below holds the same line for every other role.
GRANT UPDATE ("bathing", "dressing", "grooming", "toileting", "transferring", "ambulation", "eating", "bladder", "bowel", "devices", "updated_by_membership_id", "updated_at") ON "encounter_adl" TO chartwarden_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION encounter_adl_update_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
     OR NEW.created_by_membership_id IS DISTINCT FROM OLD.created_by_membership_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'encounter_adl: the identity of a record cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_encounter_adl_update_guard"
  BEFORE UPDATE ON "encounter_adl"
  FOR EACH ROW EXECUTE FUNCTION encounter_adl_update_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_encounter_adl() RETURNS trigger
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
ALTER FUNCTION audit_phi_write_encounter_adl() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_encounter_adl"
  AFTER INSERT OR UPDATE OR DELETE ON encounter_adl
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_encounter_adl();--> statement-breakpoint

-- Tenant destruction (the 1099 / 1478 / 1514 pattern): the destruction role may read and delete one organization's rows.
GRANT SELECT, DELETE ON "encounter_adl" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "encounter_adl_destruction" ON "encounter_adl"
  FOR ALL TO chartwarden_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
