-- M1 Foundation §3.12 — organization-settings collision guard (Decision D6) + the
-- module indexes for the two platform-shared registries (Decision D8).
--
-- The registry TABLES (organization_settings_registry, outbox_event_catalog) are
-- created by Drizzle in 0000. Their ROWS are boot-populated by each module's
-- registration code at startup (M1-T07 OrganizationSettingsReader / M1-T08 outbox
-- catalog), not seeded here — so this migration adds only the cross-cutting trigger
-- and the lookup indexes M1 owns.

-- Phase A — organization-settings validator function + trigger (D6).
-- Rejects an INSERT/UPDATE of organization.settings that would duplicate a value for
-- a registry key marked uniqueAcrossTenants (W-M1-08). Unknown keys are permitted
-- (additive principle). The SELECTs below are inside a plpgsql body — not a CHECK
-- constraint (check-ddl-legality.ts rule 2 applies only to CHECK subqueries).
CREATE OR REPLACE FUNCTION validate_organization_settings()
RETURNS trigger AS $$
DECLARE
  registry_entry JSONB;
  setting_key TEXT;
  setting_value TEXT;
  collision_id UUID;
BEGIN
  FOR setting_key, setting_value IN
    SELECT * FROM jsonb_each_text(NEW.settings)
  LOOP
    SELECT registry_entry_json INTO registry_entry
      FROM organization_settings_registry
     WHERE settings_key = setting_key
     LIMIT 1;

    IF registry_entry IS NULL THEN
      CONTINUE;
    END IF;

    IF (registry_entry->>'uniqueAcrossTenants')::boolean = TRUE THEN
      SELECT id INTO collision_id
        FROM organization
       WHERE settings->>setting_key = setting_value
         AND id != NEW.id
       LIMIT 1;

      IF collision_id IS NOT NULL THEN
        RAISE EXCEPTION
          'organization_settings_collision: % value already claimed by organization %',
          setting_key, collision_id
          USING ERRCODE = '23505';                   -- unique_violation
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_validate_organization_settings
  BEFORE INSERT OR UPDATE OF settings ON "organization"
  FOR EACH ROW
  EXECUTE FUNCTION validate_organization_settings();--> statement-breakpoint

-- Phase B — registry lookup indexes (the tables themselves come from 0000).
CREATE INDEX "idx_organization_settings_registry_module"
  ON "organization_settings_registry" ("registered_by_module");--> statement-breakpoint
CREATE INDEX "idx_outbox_event_catalog_module"
  ON "outbox_event_catalog" ("module_owner");
