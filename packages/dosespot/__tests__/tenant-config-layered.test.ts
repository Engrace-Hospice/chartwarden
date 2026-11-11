// Slice 4 — the layered per-tenant DoseSpot config: a database-backed source that can say "this org has a row" (and whether
// that row is usable for the purpose asked) in front of the env map that only serves an org with NO row. Pure: no database.
import { describe, expect, it } from "vitest";
import {
  type DoseSpotTenantConfig,
  type DoseSpotTenantConfigSource,
  createEnvTenantConfigResolver,
  createLayeredTenantConfigResolver,
} from "../src";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const dbConfig = (version: number): DoseSpotTenantConfig => ({
  baseUrl: "https://my.staging.dosespot.com/webapi/v2",
  subscriptionKey: "db-sub",
  clinicId: "db-clinic",
  clinicKey: "db-key",
  serviceClinicianId: "900",
  epcsCertified: false,
  version,
});

const ENV = createEnvTenantConfigResolver({
  DOSESPOT_TENANT_CONFIGS: JSON.stringify({
    [ORG]: {
      baseUrl: "https://env.dosespot.com/webapi/v2",
      subscriptionKey: "env-sub",
      clinicId: "env-clinic",
      clinicKey: "env-key",
      serviceClinicianId: "1",
    },
  }),
});

type Row = { usable: Record<"operate" | "setup", boolean>; config: DoseSpotTenantConfig };
function source(rows: Record<string, Row>, loads: string[] = []): DoseSpotTenantConfigSource {
  return {
    async lookup(org, purpose) {
      const row = rows[org];
      if (!row) return { kind: "absent" };
      return {
        kind: "present",
        usable: row.usable[purpose],
        load: async () => {
          loads.push(org);
          return row.config;
        },
      };
    },
  };
}

describe("layered tenant config resolver", () => {
  it("serves an org with no row from the env fallback", async () => {
    const r = createLayeredTenantConfigResolver({ source: source({}), fallback: ENV });
    expect(await r.isConfiguredFor(ORG)).toBe(true);
    expect((await r.configFor(ORG))?.clinicId).toBe("env-clinic");
    expect(await r.isConfiguredFor(OTHER)).toBe(false);
    expect(await r.configFor(OTHER)).toBeNull();
  });

  it("an active row wins over the env entry for the same org", async () => {
    const r = createLayeredTenantConfigResolver({
      source: source({ [ORG]: { usable: { operate: true, setup: true }, config: dbConfig(4) } }),
      fallback: ENV,
    });
    const cfg = await r.configFor(ORG);
    expect(cfg?.clinicId).toBe("db-clinic");
    expect(cfg?.version).toBe(4);
  });

  it("a row that is not usable is authoritative: the env entry never serves it", async () => {
    const r = createLayeredTenantConfigResolver({
      source: source({ [ORG]: { usable: { operate: false, setup: false }, config: dbConfig(2) } }),
      fallback: ENV,
    });
    expect(await r.isConfiguredFor(ORG)).toBe(false);
    expect(await r.configFor(ORG)).toBeNull();
    expect(await r.configFor(ORG, "setup")).toBeNull();
  });

  it("a verified row is usable for setup (prescriber enrolment) but not to operate", async () => {
    const r = createLayeredTenantConfigResolver({
      source: source({ [ORG]: { usable: { operate: false, setup: true }, config: dbConfig(3) } }),
      fallback: ENV,
    });
    expect(await r.configFor(ORG)).toBeNull();
    expect((await r.configFor(ORG, "setup"))?.clinicId).toBe("db-clinic");
  });

  it("answers isConfiguredFor without opening the sealed credential", async () => {
    const loads: string[] = [];
    const r = createLayeredTenantConfigResolver({
      source: source(
        { [ORG]: { usable: { operate: true, setup: true }, config: dbConfig(1) } },
        loads,
      ),
      fallback: ENV,
    });
    expect(await r.isConfiguredFor(ORG)).toBe(true);
    expect(loads).toEqual([]);
    await r.configFor(ORG);
    expect(loads).toEqual([ORG]);
  });

  it("names only the env fallback orgs without a lookup", () => {
    const r = createLayeredTenantConfigResolver({ source: source({}), fallback: ENV });
    expect(r.configuredOrganizationIds()).toEqual([ORG]);
    expect(r.isConfigured()).toBe(true);
  });
});
