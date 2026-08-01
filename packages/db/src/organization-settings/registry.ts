// @wardenx/db — Organization-Settings Registry aggregator (M1 Foundation §3.15.1).
//
// Aggregates every module's ModuleSettingsContribution into one validated registry.
// The build is FAIL-CLOSED: if two modules declare the same `settingsKey`, the build
// throws OrganizationSettingsCollisionError rather than letting one silently shadow
// the other (W-M1-08, application-layer half of the collision guard — the database
// trigger in migration 0003 guards the cross-tenant VALUE collision).
import { M3_ORGANIZATION_SETTINGS } from "./settings-by-m3";
import { M5_ORGANIZATION_SETTINGS } from "./settings-by-m5";
import type { ModuleSettingsContribution, OrganizationSettingEntry } from "./types";

// Every module that registers organization-settings keys appends its contribution here.
const CONTRIBUTIONS: readonly ModuleSettingsContribution[] = [
  M3_ORGANIZATION_SETTINGS,
  M5_ORGANIZATION_SETTINGS,
  // future module contributions append here
];

/** Thrown when two modules declare the same `settingsKey` (W-M1-08, app layer). */
export class OrganizationSettingsCollisionError extends Error {
  constructor(
    readonly settingsKey: string,
    readonly firstModule: string,
    readonly secondModule: string,
  ) {
    super(
      `organization_settings_collision: key '${settingsKey}' is registered by both ` +
        `'${firstModule}' and '${secondModule}' — a settings key may be owned by one module only`,
    );
    this.name = "OrganizationSettingsCollisionError";
  }
}

/**
 * Aggregates `contributions` into a key→entry map, rejecting duplicate `settingsKey`s.
 * Pure and total over its input — pass synthetic contributions to unit-test the guard.
 */
export function buildOrganizationSettingsRegistry(
  contributions: readonly ModuleSettingsContribution[] = CONTRIBUTIONS,
): ReadonlyMap<string, OrganizationSettingEntry> {
  const byKey = new Map<string, OrganizationSettingEntry>();
  for (const contribution of contributions) {
    for (const entry of contribution) {
      const existing = byKey.get(entry.settingsKey);
      if (existing) {
        throw new OrganizationSettingsCollisionError(
          entry.settingsKey,
          existing.registeredByModule,
          entry.registeredByModule,
        );
      }
      byKey.set(entry.settingsKey, entry);
    }
  }
  return byKey;
}

/** The validated, boot-time organization-settings registry (flat, collision-free). */
export const ORGANIZATION_SETTINGS_REGISTRY: readonly OrganizationSettingEntry[] = [
  ...buildOrganizationSettingsRegistry().values(),
];
