// @chartwarden/db — OrganizationSettingsReader (M1 Foundation §3.15).
//
// The typed reader over an `organization.settings` JSONB object. It exposes ONLY
// registered keys (registry-discipline, D6): reading an unregistered key throws,
// every returned value is validated against the key's TypeBox schema, and absent
// keys fall back to the registered `defaultValue`. Construct once at boot from the
// validated registry and reuse per request.
import { Value } from "@sinclair/typebox/value";
import { ORGANIZATION_SETTINGS_REGISTRY, buildOrganizationSettingsRegistry } from "./registry";
import type { OrganizationSettingEntry } from "./types";

/** A raw `organization.settings` JSONB object as read from the database. */
export type OrganizationSettings = Record<string, unknown>;

/** Thrown when code reads an `organization.settings` key that no module registered. */
export class UnregisteredSettingError extends Error {
  constructor(readonly settingsKey: string) {
    super(`unregistered organization setting '${settingsKey}' (no module declared it)`);
    this.name = "UnregisteredSettingError";
  }
}

/** Thrown when a stored value does not satisfy its registered TypeBox schema. */
export class SettingSchemaError extends Error {
  constructor(readonly settingsKey: string) {
    super(`organization setting '${settingsKey}' failed its registered schema`);
    this.name = "SettingSchemaError";
  }
}

/** Thrown when a `required` setting is absent and has no default. */
export class MissingRequiredSettingError extends Error {
  constructor(readonly settingsKey: string) {
    super(`required organization setting '${settingsKey}' is missing`);
    this.name = "MissingRequiredSettingError";
  }
}

export class OrganizationSettingsReader {
  private readonly byKey: ReadonlyMap<string, OrganizationSettingEntry>;

  /** Defaults to the boot registry; pass a custom map (e.g. in tests) to override. */
  constructor(registry?: ReadonlyMap<string, OrganizationSettingEntry>) {
    this.byKey = registry ?? buildOrganizationSettingsRegistry();
  }

  /** True if `settingsKey` is a registered key. */
  isRegistered(settingsKey: string): boolean {
    return this.byKey.has(settingsKey);
  }

  /** The registry entry for `settingsKey`, or undefined if unregistered. */
  entry(settingsKey: string): OrganizationSettingEntry | undefined {
    return this.byKey.get(settingsKey);
  }

  /**
   * Reads `settingsKey` from `settings`. Throws UnregisteredSettingError for an
   * unknown key. Absent values return the registered `defaultValue`. Present values
   * are validated against the registered TypeBox schema (SettingSchemaError on miss).
   */
  get<T = unknown>(
    settings: OrganizationSettings | null | undefined,
    settingsKey: string,
  ): T | null {
    const entry = this.byKey.get(settingsKey);
    if (!entry) throw new UnregisteredSettingError(settingsKey);

    const raw = settings?.[settingsKey];
    if (raw === undefined || raw === null) return entry.defaultValue as T | null;

    if (!Value.Check(entry.typeBoxSchema, raw)) throw new SettingSchemaError(settingsKey);
    return raw as T;
  }

  /**
   * Like `get`, but throws MissingRequiredSettingError when the value resolves to
   * null/undefined — for keys a caller treats as mandatory.
   */
  require<T = unknown>(settings: OrganizationSettings | null | undefined, settingsKey: string): T {
    const value = this.get<T>(settings, settingsKey);
    if (value === null || value === undefined) throw new MissingRequiredSettingError(settingsKey);
    return value;
  }
}

/** Shared reader built from the boot registry — the common case. */
export const organizationSettingsReader = new OrganizationSettingsReader(
  new Map(ORGANIZATION_SETTINGS_REGISTRY.map((e) => [e.settingsKey, e])),
);
