/**
 * GAP-032 - M40 `emergency_service_jurisdiction`: the TENANT-CURATED PSAP catalog the SOS terminus resolves.
 * LIVE Postgres, as the RLS-enforced `wardenx_app` role. Proves the store (create stamps verification, an edit
 * of the number or its coverage clears it, verify restores it), the partial-unique defaults, the CHECKs, the
 * seam reader against a real polygon, and that a tenant sees neither another tenant's PSAP rows nor can write
 * into them. Gated on a live DB:
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m40:psap-jurisdiction:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import type { OrgId } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildEmergencyServiceJurisdictionReader,
  createPsapJurisdictionStore,
} from "../src/modules/40-mdm/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_platform_login",
  "wardenx_platform",
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "tenant_platform_writer",
];
const ORG_A = "11111111-1111-4111-8111-111111114001";
const ORG_B = "22222222-2222-4222-8222-222222224002";

const COUNTY = [
  [
    [-123, 45],
    [-122, 45],
    [-122, 46],
    [-123, 46],
    [-123, 45],
  ],
] as const;

describe.skipIf(!DB_URL)("GAP-032 M40 PSAP jurisdiction catalog, LIVE Postgres", () => {
  let admin: Client;
  let app: ReturnType<typeof createDbClient>;
  let appUrl = "";
  let locationA = "";
  let clock = new Date("2026-10-08T12:00:00.000Z");
  const now = () => clock;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [org, slug] of [
      [ORG_A, "m40psap-a"],
      [ORG_B, "m40psap-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [org, slug],
      );
    }
    const pe = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-PSAP','PSAP PE','NPI-PSAP','enc','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    locationA = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [pe],
      )
    ).rows[0].id as string;
    appUrl = await appRoleConnectionString(admin, DB_URL as string);
    app = createDbClient({ connectionString: appUrl });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  const input = (over: Record<string, unknown> = {}) =>
    ({
      name: "Multnomah",
      state: "OR",
      psapName: "Multnomah PSAP",
      psapPhone: "+15035550123",
      isOrgDefault: true,
      ...over,
    }) as never;

  it("create stamps a verification; an edit of the number clears it until verify restores it", async () => {
    const store = createPsapJurisdictionStore(app.db, now);
    const created = await store.create(ORG_A, null, input());
    expect(created).toMatchObject({ stale: false, isActive: true, isOrgDefault: true });

    const edited = await store.update(ORG_A, created.id, { psapPhone: "+15035550999" });
    expect(edited.stale).toBe(true); // the old verification no longer vouches for the new number
    const verified = await store.verify(ORG_A, created.id, null);
    expect(verified.stale).toBe(false);

    // A cosmetic edit does not clear the verification.
    expect((await store.update(ORG_A, created.id, { name: "Multnomah County" })).stale).toBe(false);

    // A row ages into "stale" with the clock, still returned.
    clock = new Date("2027-06-01T12:00:00.000Z"); // > 180 days
    const aged = (await store.list(ORG_A)).find((r) => r.id === created.id);
    expect(aged?.stale).toBe(true);
    clock = new Date("2026-10-08T12:00:00.000Z");
    await store.setActive(ORG_A, created.id, false);
    expect(await store.list(ORG_A)).toHaveLength(0);
    expect(await store.list(ORG_A, { includeInactive: true })).toHaveLength(1);
  });

  it("allows one ACTIVE org default per org and one active default per location", async () => {
    await admin.query("DELETE FROM emergency_service_jurisdiction");
    const store = createPsapJurisdictionStore(app.db, now);
    const first = await store.create(ORG_A, null, input());
    await expect(store.create(ORG_A, null, input({ name: "Second default" }))).rejects.toThrow();
    await store.setActive(ORG_A, first.id, false);
    await expect(
      store.create(ORG_A, null, input({ name: "Second default" })),
    ).resolves.toBeTruthy();

    await store.create(
      ORG_A,
      null,
      input({ name: "Loc PSAP", isOrgDefault: false, appliesToLocationId: locationA }),
    );
    await expect(
      store.create(
        ORG_A,
        null,
        input({ name: "Loc PSAP 2", isOrgDefault: false, appliesToLocationId: locationA }),
      ),
    ).rejects.toThrow();
  });

  it("the database refuses a row that matches nothing, an org default with a polygon, and a bad number", async () => {
    const insert = (cols: string, vals: unknown[]) =>
      admin.query(
        `INSERT INTO emergency_service_jurisdiction (organization_id, name, state, psap_name, psap_phone, verified_at, ${cols})
         VALUES ($1,'x','OR','p','+15035550123',now(), ${vals.map((_, i) => `$${i + 2}`).join(",")})`,
        [ORG_A, ...vals],
      );
    await expect(insert("is_org_default", [false])).rejects.toThrow(/matches_something/);
    await expect(insert("is_org_default, polygon", [true, JSON.stringify(COUNTY)])).rejects.toThrow(
      /org_default_plain/,
    );
    await expect(
      admin.query(
        `INSERT INTO emergency_service_jurisdiction (organization_id, name, state, psap_name, psap_phone, verified_at, is_org_default)
         VALUES ($1,'x','OR','p','503-555-0123',now(), true)`,
        [ORG_A],
      ),
    ).rejects.toThrow(/m40_esj_phone/);
  });

  it("the seam reader resolves by real polygon, then location, then org default, and never invents a number", async () => {
    await admin.query("DELETE FROM emergency_service_jurisdiction");
    const store = createPsapJurisdictionStore(app.db, now);
    const reader = buildEmergencyServiceJurisdictionReader(app.db, now);
    const orgDefault = await store.create(ORG_A, null, input({ name: "State PSAP" }));
    const loc = await store.create(
      ORG_A,
      null,
      input({
        name: "Loc",
        isOrgDefault: false,
        appliesToLocationId: locationA,
        psapPhone: "+15035550200",
      }),
    );
    const county = await store.create(
      ORG_A,
      null,
      input({ name: "County", isOrgDefault: false, polygon: COUNTY, psapPhone: "+15035550300" }),
    );
    const org = ORG_A as OrgId;

    const inside = await reader.forSosAlert({
      orgId: org,
      point: { latitude: 45.5, longitude: -122.5 },
      locationId: locationA as never,
    });
    expect(inside).toMatchObject({
      kind: "resolved",
      jurisdictionId: county.id,
      confidence: "point_in_polygon",
    });
    const outside = await reader.forSosAlert({
      orgId: org,
      point: { latitude: 10, longitude: 10 },
      locationId: locationA as never,
    });
    expect(outside).toMatchObject({ jurisdictionId: loc.id, confidence: "location_default" });
    const noPlace = await reader.forSosAlert({ orgId: org, point: null, locationId: null });
    expect(noPlace).toMatchObject({ jurisdictionId: orgDefault.id, confidence: "org_default" });

    const summary = await reader.byId(org, county.id);
    expect(summary).toMatchObject({
      phone: "+15035550300",
      psapName: "Multnomah PSAP",
      stale: false,
    });
    expect(await reader.byId(ORG_B as OrgId, county.id)).toBeNull(); // another tenant's id resolves to nothing

    // An org with no rows says `none`, truthfully.
    expect(
      await reader.forSosAlert({ orgId: ORG_B as OrgId, point: null, locationId: null }),
    ).toEqual({ kind: "none" });
  });

  it("rejects a malformed polygon before it reaches the database", async () => {
    const store = createPsapJurisdictionStore(app.db, now);
    await expect(
      store.create(
        ORG_A,
        null,
        input({
          name: "bad",
          isOrgDefault: false,
          polygon: [
            [
              [0, 0],
              [1, 1],
            ],
          ],
        }),
      ),
    ).rejects.toThrow();
  });

  it("a tenant sees only its own rows and cannot write into another tenant's catalog (RLS)", async () => {
    await admin.query("DELETE FROM emergency_service_jurisdiction");
    const store = createPsapJurisdictionStore(app.db, now);
    await store.create(ORG_A, null, input({ name: "A only" }));
    expect(await store.list(ORG_B)).toHaveLength(0);

    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
      expect((await c.query("SELECT 1 FROM emergency_service_jurisdiction")).rowCount).toBe(0);
      await expect(
        c.query(
          `INSERT INTO emergency_service_jurisdiction (organization_id, name, state, psap_name, psap_phone, verified_at, is_org_default)
           VALUES ($1,'x','OR','p','+15035550123',now(), true)`,
          [ORG_A],
        ),
      ).rejects.toThrow(/row-level security/);
      await c.query("ROLLBACK");
    } finally {
      await c.end();
    }
  });
});
