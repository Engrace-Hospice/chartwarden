/**
 * GAP-173 / GAP-158 follow-up - M40 `mdm_license_record` (manual license entry + expiry scan) and
 * `external_grief_resource` RLS, LIVE Postgres, as the RLS-enforced `wardenx_app` role. Proves the upsert
 * (re-entering a renewed expiry updates in place, one row per org/entity/state), the 2-letter state CHECK, the
 * scan's read (org-scoped, horizon-bounded) and that a tenant sees neither another tenant's licenses nor grief
 * resources. Gated on a live DB:
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:gap-173:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runLicenseExpirationScanForOrg } from "../src/modules/40-mdm/jobs/license-scan";
import { createDbMdmRouteService } from "../src/modules/40-mdm/mdm-store-db";
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
const ORG_A = "11111111-1111-4111-8111-111111117301";
const ORG_B = "22222222-2222-4222-8222-222222227302";
const USER = "a0000000-0000-4000-8000-000000007301";
const PHYSICIAN = "c0000000-0000-4000-8000-000000007301";

const isoDaysFromNow = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!DB_URL)("GAP-173 M40 license record + grief resource RLS, LIVE Postgres", () => {
  let admin: Client;
  let app: ReturnType<typeof createDbClient>;
  let appUrl = "";

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
      [ORG_A, "g173a"],
      [ORG_B, "g173b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [org, slug],
      );
    }
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'u@g173.test')`, [USER]);
    appUrl = await appRoleConnectionString(admin, DB_URL as string);
    app = createDbClient({ connectionString: appUrl });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  const licensesFor = async (org: string) =>
    (
      await admin.query(
        "SELECT license_state, expires_on::text AS expires_on FROM mdm_license_record WHERE organization_id = $1 ORDER BY license_state",
        [org],
      )
    ).rows;

  it("records a license, updates the SAME row on re-entry, and keeps one row per (org, entity, state)", async () => {
    const svc = createDbMdmRouteService(app.db);
    const input = (state: string, expiresOn: string) =>
      ({ kind: "physician", canonicalId: PHYSICIAN, licenseState: state, expiresOn }) as never;
    await svc.recordLicense(ORG_A, input("ca", "2027-01-01"), USER);
    await svc.recordLicense(ORG_A, input("CA", "2028-02-02"), USER);
    await svc.recordLicense(ORG_A, input("NY", "2027-03-03"), USER);
    expect(await licensesFor(ORG_A)).toEqual([
      { license_state: "CA", expires_on: "2028-02-02" },
      { license_state: "NY", expires_on: "2027-03-03" },
    ]);
    await expect(svc.recordLicense(ORG_A, input("CAL", "2027-01-01"), USER)).rejects.toThrow();
  });

  it("the scan reads only this org's licenses inside the horizon and plans an alert per due window", async () => {
    await admin.query(
      "INSERT INTO mdm_license_record (organization_id, entity_kind, canonical_id, license_state, expires_on) VALUES ($1,'physician',$2,'TX',$3)",
      [ORG_A, PHYSICIAN, isoDaysFromNow(25)],
    );
    await admin.query(
      "INSERT INTO mdm_license_record (organization_id, entity_kind, canonical_id, license_state, expires_on) VALUES ($1,'physician',$2,'FL',$3)",
      [ORG_B, PHYSICIAN, isoDaysFromNow(10)],
    );
    const emitted: Array<{ orgId: string; payload: Record<string, unknown> }> = [];
    const count = await runLicenseExpirationScanForOrg(
      {
        db: app.db,
        orgs: { listActiveOrgs: async () => [] } as never,
        alerts: {
          emit: async (orgId: string, a: { payload: Record<string, unknown> }) => {
            emitted.push({ orgId, payload: a.payload });
          },
        } as never,
      },
      ORG_A,
    );
    expect(count).toBe(emitted.length);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(emitted.every((e) => e.orgId === ORG_A)).toBe(true);
    expect(emitted.map((e) => e.payload.state)).toContain("TX");
    expect(emitted.map((e) => e.payload.state)).not.toContain("FL");
  });

  const asOrg = async (org: string, query: string, params: unknown[] = []) => {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.org_id', $1, true)", [org]);
      const r = await c.query(query, params);
      await c.query("ROLLBACK");
      return r;
    } finally {
      await c.end();
    }
  };

  it("RLS: a tenant sees only its own license rows and grief resources, and cannot write another's", async () => {
    await admin.query(
      "INSERT INTO external_grief_resource (organization_id, name, resource_kind) VALUES ($1,'A Circle','community_group'),($2,'B Camp','child_camp')",
      [ORG_A, ORG_B],
    );
    expect((await asOrg(ORG_A, "SELECT name FROM external_grief_resource")).rows).toEqual([
      { name: "A Circle" },
    ]);
    expect((await asOrg(ORG_B, "SELECT license_state FROM mdm_license_record")).rows).toEqual([
      { license_state: "FL" },
    ]);
    await expect(
      asOrg(
        ORG_A,
        "INSERT INTO external_grief_resource (organization_id, name, resource_kind) VALUES ($1,'x','community_group')",
        [ORG_B],
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
