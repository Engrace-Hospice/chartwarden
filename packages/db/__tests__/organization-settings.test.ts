// PARAM-004 follow-up — proves the org_timezone setting (settings-by-m1.ts) resolves correctly
// through the real OrganizationSettingsReader/registry, not just that the entry object looks right.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORGANIZATION_TIMEZONE,
  ORGANIZATION_SETTINGS_REGISTRY,
  OrganizationSettingsReader,
  SettingSchemaError,
} from "../src/organization-settings";

describe("org_timezone (M1, PARAM-004 follow-up)", () => {
  it("is registered exactly once, owned by m1", () => {
    const entries = ORGANIZATION_SETTINGS_REGISTRY.filter((e) => e.settingsKey === "org_timezone");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.registeredByModule).toBe("m1");
  });

  it("defaults to DEFAULT_ORGANIZATION_TIMEZONE when the org never set one", () => {
    const reader = new OrganizationSettingsReader();
    expect(reader.get<string>({}, "org_timezone")).toBe(DEFAULT_ORGANIZATION_TIMEZONE);
    expect(reader.get<string>(null, "org_timezone")).toBe(DEFAULT_ORGANIZATION_TIMEZONE);
  });

  it("reads back a tenant-set IANA zone", () => {
    const reader = new OrganizationSettingsReader();
    expect(reader.get<string>({ org_timezone: "America/Los_Angeles" }, "org_timezone")).toBe(
      "America/Los_Angeles",
    );
  });

  it("rejects a value that doesn't look like an IANA zone at the schema level", () => {
    const reader = new OrganizationSettingsReader();
    expect(() => reader.get({ org_timezone: "not a timezone!!" }, "org_timezone")).toThrow(
      SettingSchemaError,
    );
  });
});
