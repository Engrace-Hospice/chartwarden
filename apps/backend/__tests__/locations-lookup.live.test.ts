import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { registerLocationLookupRoutes } from "../src/bootstrap/routes/locations";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const PE_A = "33333333-3333-4333-8333-333333333333";
const PE_B = "44444444-4444-4444-8444-444444444444";
const OTHER_ORG = "55555555-5555-4555-8555-555555555555";
const PE_OTHER = "66666666-6666-4666-8666-666666666666";

describe.skipIf(!DB_URL)("M1 location lookup route — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: ReturnType<typeof buildServer>;

  async function resetSchema(): Promise<void> {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
  }

  async function applyMigrations(): Promise<void> {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      if (stripVector) {
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
          "-- (vector extension stripped)",
        );
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped)");
      }
      await admin.query(sql);
    }
  }

  function headerAuth(request: FastifyRequest): void {
    request.context.userId = USER;
    request.context.organizationId = ORG;
    request.context.roles = ["intake_coordinator"];
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'location-lookup','Location Lookup Org','Location Lookup Org')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'locations-live@x.test')`, [USER]);
    await admin.query(
      `INSERT INTO provider_entity
         (id, organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES
         ($1, $3, '100001', 'Alpha Hospice', '1111111111', 'enc-tax-a', '1231'),
         ($2, $3, '100002', 'Beta Hospice', '2222222222', 'enc-tax-b', '1231')`,
      [PE_A, PE_B, ORG],
    );
    // A second tenant whose location must never appear in ORG's lookup (`location` has no RLS of
    // its own; the route walls it through provider_entity).
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'other-tenant','Other Tenant','Other Tenant')",
      [OTHER_ORG],
    );
    await admin.query(
      `INSERT INTO provider_entity
         (id, organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1, $2, '100003', 'Other Hospice', '3333333333', 'enc-tax-c', '1231')`,
      [PE_OTHER, OTHER_ORG],
    );
    await admin.query(
      `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
       VALUES ($1, 'Other Tenant Office', '40 Elm Lane', 'Denver', 'CO', '80203', 'America/Denver')`,
      [PE_OTHER],
    );
    await admin.query(
      `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
       VALUES
         ($1, 'Alpha North', '10 Pine Street', 'Denver', 'CO', '80202', 'America/Denver'),
         ($1, 'Alpha South', '20 Cedar Avenue', 'Boulder', 'CO', '80301', 'America/Denver'),
         ($2, 'Beta East', '30 Maple Road', 'Austin', 'TX', '73301', 'America/Chicago')`,
      [PE_A, PE_B],
    );
    await admin.query("ALTER ROLE chartwarden_app LOGIN PASSWORD 'chartwarden-location-test'");
    const appUrl = new URL(DB_URL as string);
    appUrl.username = "chartwarden_app";
    appUrl.password = "chartwarden-location-test";
    handle = createDbClient({ connectionString: appUrl.toString() });
    app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    registerLocationLookupRoutes(app, handle.db);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  it("filters locations by providerEntityId", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/locations?providerEntityId=${PE_A}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((item: { name: string }) => item.name)).toEqual([
      "Alpha North",
      "Alpha South",
    ]);
  });

  it("never lists another tenant's locations", async () => {
    const all = await app.inject({ method: "GET", url: "/api/v1/locations" });
    expect(all.statusCode).toBe(200);
    expect(all.json().items.map((item: { name: string }) => item.name)).toEqual([
      "Alpha North",
      "Alpha South",
      "Beta East",
    ]);

    // Naming the other tenant's provider entity or matching its address still returns nothing.
    const byId = await app.inject({
      method: "GET",
      url: `/api/v1/locations?providerEntityId=${PE_OTHER}`,
    });
    expect(byId.json().items).toEqual([]);
    const bySearch = await app.inject({ method: "GET", url: "/api/v1/locations?q=Elm" });
    expect(bySearch.json().items).toEqual([]);
  });

  it("searches locations by q across address fields", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/locations?providerEntityId=${PE_A}&q=Boulder`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toMatchObject([{ name: "Alpha South", city: "Boulder" }]);
  });
});
