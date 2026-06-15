/**
 * M1-T07 — Organization-Settings Registry + typed reader (spec §3.15).
 *
 * Accept criterion: "unit test for collision rejection." Two layers of the W-M1-08
 * collision guard:
 *   - APP layer (here): the registry build is fail-closed — two modules declaring the
 *     same settingsKey throws OrganizationSettingsCollisionError. Plus the typed reader
 *     contract (registered-keys discipline + schema validation + defaults).
 *   - DB layer (M1-T12 §7.7, live PG): the cross-tenant VALUE collision via the
 *     `validate_organization_settings()` trigger — drafted skipped below.
 */
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  buildOrganizationSettingsRegistry,
  MissingRequiredSettingError,
  ORGANIZATION_SETTINGS_REGISTRY,
  OrganizationSettingsCollisionError,
  OrganizationSettingsReader,
  SettingSchemaError,
  UnregisteredSettingError,
} from "../index";
import type { ModuleSettingsContribution } from "../types";

const entry = (overrides: Partial<ModuleSettingsContribution[number]> = {}) => ({
  settingsKey: "k",
  registeredByModule: "mX",
  description: "d",
  typeBoxSchema: Type.String(),
  uniqueAcrossTenants: false,
  defaultValue: null,
  required: false,
  ...overrides,
});

describe("buildOrganizationSettingsRegistry — collision rejection (W-M1-08, app layer)", () => {
  it("rejects two modules declaring the same settingsKey", () => {
    const a: ModuleSettingsContribution = [entry({ settingsKey: "dup", registeredByModule: "m1" })];
    const b: ModuleSettingsContribution = [entry({ settingsKey: "dup", registeredByModule: "m2" })];
    expect(() => buildOrganizationSettingsRegistry([a, b])).toThrow(OrganizationSettingsCollisionError);
  });

  it("names both colliding modules in the error", () => {
    const a: ModuleSettingsContribution = [entry({ settingsKey: "dup", registeredByModule: "m1" })];
    const b: ModuleSettingsContribution = [entry({ settingsKey: "dup", registeredByModule: "m2" })];
    try {
      buildOrganizationSettingsRegistry([a, b]);
      expect.unreachable("build should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(OrganizationSettingsCollisionError);
      const err = e as OrganizationSettingsCollisionError;
      expect(err.settingsKey).toBe("dup");
      expect([err.firstModule, err.secondModule]).toEqual(["m1", "m2"]);
    }
  });

  it("accepts distinct keys across modules", () => {
    const a: ModuleSettingsContribution = [entry({ settingsKey: "k1", registeredByModule: "m1" })];
    const b: ModuleSettingsContribution = [entry({ settingsKey: "k2", registeredByModule: "m2" })];
    const reg = buildOrganizationSettingsRegistry([a, b]);
    expect([...reg.keys()].sort()).toEqual(["k1", "k2"]);
  });
});

describe("ORGANIZATION_SETTINGS_REGISTRY — boot registry", () => {
  it("builds collision-free and carries M5's uniqueAcrossTenants MRN-authority key", () => {
    const mrn = ORGANIZATION_SETTINGS_REGISTRY.find(
      (e) => e.settingsKey === "hl7_internal_mrn_authority",
    );
    expect(mrn).toBeDefined();
    expect(mrn?.uniqueAcrossTenants).toBe(true);
    expect(mrn?.registeredByModule).toBe("m5");
  });
});

describe("OrganizationSettingsReader — registered-keys discipline (§3.15)", () => {
  const reader = new OrganizationSettingsReader(
    new Map([
      [
        "mrn",
        entry({ settingsKey: "mrn", typeBoxSchema: Type.String({ minLength: 1 }), defaultValue: null }),
      ],
      [
        "retention_days",
        entry({ settingsKey: "retention_days", typeBoxSchema: Type.Number(), defaultValue: 30 }),
      ],
    ]),
  );

  it("throws for an unregistered key", () => {
    expect(() => reader.get({}, "not_a_key")).toThrow(UnregisteredSettingError);
  });

  it("returns the registered default when the key is absent", () => {
    expect(reader.get({}, "retention_days")).toBe(30);
    expect(reader.get(null, "mrn")).toBeNull();
  });

  it("returns a present value that satisfies its schema", () => {
    expect(reader.get({ mrn: "ACME-MRN" }, "mrn")).toBe("ACME-MRN");
  });

  it("rejects a present value that violates its schema", () => {
    expect(() => reader.get({ retention_days: "thirty" }, "retention_days")).toThrow(SettingSchemaError);
  });

  it("require() throws when a value is absent with a null default", () => {
    expect(() => reader.require({}, "mrn")).toThrow(MissingRequiredSettingError);
  });

  it("isRegistered/entry reflect the registry", () => {
    expect(reader.isRegistered("mrn")).toBe(true);
    expect(reader.isRegistered("nope")).toBe(false);
    expect(reader.entry("retention_days")?.defaultValue).toBe(30);
  });
});

// DB-layer cross-tenant VALUE collision (the trigger in migration 0003). Un-skipped by
// M1-T12 §7.7 once the Testcontainers PG harness lands: two orgs claiming the same
// hl7_internal_mrn_authority value → the second write raises unique_violation (23505).
describe.skip("W-M1-08 cross-tenant value collision (live PG — owned by M1-T12 §7.7)", () => {
  it("rejects a second org claiming an already-claimed uniqueAcrossTenants value", () => {
    // boot registry → set org A settings.hl7_internal_mrn_authority='X' →
    // set org B settings.hl7_internal_mrn_authority='X' → expect 23505.
  });
});
