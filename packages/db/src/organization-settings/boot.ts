import type { NewOrganizationSettingsRegistryEntry } from "../schema/organization-settings-registry";
// @wardenx/db — Organization-settings registry boot UPSERT (M1 Foundation §3.15.2).
//
// Projects the validated ORGANIZATION_SETTINGS_REGISTRY into the rows persisted in the
// `organization_settings_registry` table (which the trigger reads at write time). The
// actual write is dependency-injected: the real Drizzle `db` handle + boot sequencing
// land with the backend bootstrap (M1-T09/T10), so this helper stays a pure leaf here
// and is wired then — mirroring the injected-auditor pattern in packages/tenancy.
import { ORGANIZATION_SETTINGS_REGISTRY } from "./registry";

/** The persisted form of a registry entry — `registry_entry_json` carries the metadata. */
export function toRegistryRows(
  registry: typeof ORGANIZATION_SETTINGS_REGISTRY = ORGANIZATION_SETTINGS_REGISTRY,
): NewOrganizationSettingsRegistryEntry[] {
  return registry.map((entry) => ({
    settingsKey: entry.settingsKey,
    registeredByModule: entry.registeredByModule,
    description: entry.description,
    registryEntryJson: {
      uniqueAcrossTenants: entry.uniqueAcrossTenants,
      typeBoxSchema: entry.typeBoxSchema,
      defaultValue: entry.defaultValue,
      required: entry.required,
    },
  }));
}

/** UPSERTs one registry row (insert-or-update on `settings_key`). Injected at boot. */
export type RegistryRowUpserter = (row: NewOrganizationSettingsRegistryEntry) => Promise<void>;

/**
 * Boot-populates `organization_settings_registry` from the in-code registry, UPSERTing
 * each row so re-runs are idempotent. Call once during the backend boot sequence with a
 * Drizzle-backed `upsert` (`db.insert(...).values(row).onConflictDoUpdate(...)`).
 */
export async function bootOrganizationSettingsRegistry(upsert: RegistryRowUpserter): Promise<void> {
  for (const row of toRegistryRows()) {
    await upsert(row);
  }
}
