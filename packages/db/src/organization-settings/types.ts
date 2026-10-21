// @chartwarden/db — Organization-Settings Registry types (M1 Foundation §3.15).
//
// `organization.settings` is a typed JSONB column governed by a registered-keys
// discipline (Decision D6): a module may only store a settings key it has declared
// here. Each declaration is an OrganizationSettingEntry; a module contributes a
// readonly array of them (ModuleSettingsContribution), aggregated by registry.ts.
//
// Re-homed from the banned `packages/foundation/src/organization-settings/` to
// `packages/db` per ADR-0005 D3 — M1 owns this schema-adjacent surface.
import type { TSchema } from "@sinclair/typebox";

/** A single registered `organization.settings` key and its governing metadata. */
export interface OrganizationSettingEntry {
  /** The JSONB key under `organization.settings`. */
  readonly settingsKey: string;
  /** Owning module id (e.g. `m5`) — recorded in the registry row for traceability. */
  readonly registeredByModule: string;
  /** Human-readable description of what the key holds. */
  readonly description: string;
  /** TypeBox schema the value must satisfy (validated by OrganizationSettingsReader). */
  readonly typeBoxSchema: TSchema;
  /**
   * When true, the value must be unique across ALL tenants — enforced at the database
   * by the `validate_organization_settings()` trigger (migration 0003, W-M1-08) and,
   * at the application layer, by the registry's per-key collision guard (registry.ts).
   */
  readonly uniqueAcrossTenants: boolean;
  /** Value returned by the reader when the key is absent from `organization.settings`. */
  readonly defaultValue: unknown | null;
  /** When true, the key must be present (OrganizationSettingsReader.require throws otherwise). */
  readonly required: boolean;
}

/** One module's contribution to the organization-settings registry. */
export type ModuleSettingsContribution = readonly OrganizationSettingEntry[];
