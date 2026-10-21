// apps/backend/src/bootstrap/organization-settings-persister.ts — M1 Foundation §3.12 / D6 boot
// population of `organization_settings_registry` (ARCH-023 / TASK-066).
//
// packages/db/src/organization-settings/boot.ts's `bootOrganizationSettingsRegistry` has existed since
// M1 landed, with a header comment saying the real write "lands with the backend bootstrap... wired
// then" — it never was. The registry table stayed permanently empty, which is silent everywhere EXCEPT
// one place: migration 0003's `validate_organization_settings()` trigger looks up each settings key's
// registry row to decide whether it is `uniqueAcrossTenants`, and treats an absent row as "unknown key,
// no opinion" (`IF registry_entry IS NULL THEN CONTINUE;` — additive-by-design, so writes were never
// blocked). With the registry never seeded, EVERY key reads as unknown, so the W-M1-08
// uniqueAcrossTenants collision guard has been permanently inert for every module that declared one.
//
// Mirrors the M1-T10 `outbox_event_catalog` boot-population shape exactly (buildDbCatalogUpserter /
// wireOutboxCatalog in ./outbox-persister.ts) — same idempotent UPSERT-on-primary-key pattern, same
// NON_ORG_SCOPED platform-reference-data posture, same fail-soft (never blocks boot) call site.
import {
  type DbClient,
  type RegistryRowUpserter,
  bootOrganizationSettingsRegistry,
  schema,
} from "@chartwarden/db";

/** Idempotent `organization_settings_registry` row UPSERTer (insert-or-update on `settings_key`). */
export function buildDbOrganizationSettingsUpserter(db: DbClient): RegistryRowUpserter {
  const T = schema.organizationSettingsRegistry;
  return async (row) => {
    await db
      .insert(T)
      .values(row)
      .onConflictDoUpdate({
        target: T.settingsKey,
        set: {
          registeredByModule: row.registeredByModule,
          description: row.description,
          registryEntryJson: row.registryEntryJson,
        },
      });
  };
}

/** Boot-populate `organization_settings_registry` from the in-code registry (idempotent). */
export async function wireOrganizationSettingsRegistry(db: DbClient): Promise<void> {
  await bootOrganizationSettingsRegistry(buildDbOrganizationSettingsUpserter(db));
}
