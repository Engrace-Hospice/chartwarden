/**
 * M1 `FoundationSiteReader.allLocationsOpenInOrg` — the location check M2's user provisioning used to run
 * against M1's tables directly (scripts/check-table-ownership.ts moved it behind the owner's reader).
 *
 * Proven as the real NOBYPASSRLS `wardenx_app` role inside `withOrgContext`: an open location of the org
 * passes; a closed one, another tenant's, and an unknown id fail; an empty list and duplicate ids behave.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:foundation-site-reader:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFoundationSiteReader } from "../src/bootstrap/foundation-site-reader";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111fa51a001";
const ORG_B = "22222222-2222-4222-8222-2222fa51b002";
const UNKNOWN = "99999999-9999-4999-8999-999999999999";

describe.skipIf(!DB_URL)("FoundationSiteReader.allLocationsOpenInOrg — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const loc: Record<"aOpen" | "aOpen2" | "aClosed" | "bOpen", string> = {} as never;

  async function applyMigrations() {
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  async function seedLocation(org: string, name: string, status: string): Promise<string> {
    const pe = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') ON CONFLICT DO NOTHING RETURNING id`,
        [
          org,
          `CCN-FA51-${org.slice(0, 4)}`,
          `FA51 ${org.slice(0, 4)}`,
          `NPI-FA51-${org.slice(0, 4)}`,
        ],
      )
    ).rows[0]?.id as string | undefined;
    const providerEntityId =
      pe ??
      ((await admin.query("SELECT id FROM provider_entity WHERE organization_id=$1", [org])).rows[0]
        .id as string);
    const { rows } = await admin.query(
      `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone, status)
       VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles',$3) RETURNING id`,
      [providerEntityId, name, status],
    );
    return rows[0].id as string;
  }

  const check = (org: string, ids: readonly string[]) =>
    withOrgContext(handle.db, { organizationId: org, userId: "" }, (tx) =>
      buildFoundationSiteReader().allLocationsOpenInOrg(tx as never, org, ids),
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'fa51-a','A','A','active'),($2,'fa51-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    loc.aOpen = await seedLocation(ORG_A, "A open", "active");
    loc.aOpen2 = await seedLocation(ORG_A, "A created", "created");
    loc.aClosed = await seedLocation(ORG_A, "A closed", "closed");
    loc.bOpen = await seedLocation(ORG_B, "B open", "active");
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  });

  afterAll(async () => {
    await handle?.close?.();
    await admin?.end();
  });

  it("is true for open locations of the org, duplicates ignored", async () => {
    expect(await check(ORG_A, [loc.aOpen, loc.aOpen2, loc.aOpen])).toBe(true);
  });

  it("is true for an empty list", async () => {
    expect(await check(ORG_A, [])).toBe(true);
  });

  it("is false when any location is closed", async () => {
    expect(await check(ORG_A, [loc.aOpen, loc.aClosed])).toBe(false);
  });

  it("is false for another tenant's location", async () => {
    expect(await check(ORG_A, [loc.aOpen, loc.bOpen])).toBe(false);
  });

  it("is false for an unknown id", async () => {
    expect(await check(ORG_A, [UNKNOWN])).toBe(false);
  });
});
