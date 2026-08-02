/**
 * M13L-T01 — the Drizzle `createDbEmarBackend` READ paths, proven against real Postgres.
 *
 * The pure/in-memory suites exercise the PRN/witness/comfort-kit/five-rights machinery but never touch a
 * database; this drives the PRODUCTION read service (the one the composition root mounts) over the real M13
 * `emar/*` tables under `withOrgContext` — proving the administration / scheduled-dose / comfort-kit reads
 * return the seeded rows, RLS scopes every read by tenant (`app.org_id` as the NOBYPASSRLS `wardenx_app`
 * role), and every write fail-closes 501 (`NOT_IMPLEMENTED`).
 *
 * `administration_record` is PARTITIONED BY RANGE(administered_at); seeds use now() so the row routes to the
 * current-month child (0041 creates current + 12 forward). The seed chain mirrors the proven M13 RLS suite.
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m13:read:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbEmarBackend } from "../src/modules/13-emar/emar-route-service-db";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
/** patient_id / admission_id / medication_order_id are NOT NULL but carry NO FK (cross-module refs, §3.3). */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const MED_ORDER = "66666666-6666-6666-6666-666666666666";

type SeedIds = { administrationRecord: string; scheduledDose: string; comfortKitDeployment: string };

describe.skipIf(!DB_URL)("M13 Drizzle read service — LIVE Postgres (M13L-T01)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbEmarBackend>;
  const seeded: Record<string, SeedIds> = {};

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations() {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  /** Seed one M13 administration chain for `org` as superuser (RLS + grants bypassed). */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const providerEntity = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M13R${n}`, `M13R Provider ${n}`, `NPI-M13R${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M13R${n}`],
      )
    ).rows[0].id as string;

    // administration_record — PARTITIONED; administered_at=now() routes to the current-month child.
    const administrationRecord = (
      await admin.query(
        `INSERT INTO administration_record (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, medication_order_id, mode, data, drug_name_snapshot, route_snapshot,
           administered_at, actor_kind)
         VALUES ($1,$2,$3,$4,$5,$6,'single_dose','{}'::jsonb,'Morphine','oral', now(), 'clinician')
         RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, MED_ORDER],
      )
    ).rows[0].id as string;

    const scheduledDose = (
      await admin.query(
        `INSERT INTO scheduled_dose (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, medication_order_id, due_at, grace_window_minutes, expected_dose_amount,
           expected_dose_unit, expected_route, materialization_sequence)
         VALUES ($1,$2,$3,$4,$5,$6, now(), 60, 5.0000, 'mg', 'oral', 1) RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, MED_ORDER],
      )
    ).rows[0].id as string;

    const comfortKitDeployment = (
      await admin.query(
        `INSERT INTO comfort_kit_deployment (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, deployed_at)
         VALUES ($1,$2,$3,$4,$5, now()) RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION],
      )
    ).rows[0].id as string;

    return { administrationRecord, scheduledDose, comfortKitDeployment };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m13r@x.test')`, [USER]);
    seeded[ORG_A] = await seedOrg(ORG_A, 1);
    seeded[ORG_B] = await seedOrg(ORG_B, 2);
    // Prod connects as the NOBYPASSRLS `wardenx_app` role; `withOrgContext` does NOT SET ROLE. To exercise
    // RLS faithfully, connect the client AS wardenx_app — it is NOLOGIN in the migrations, so grant LOGIN
    // for the throwaway run.
    await admin.query("ALTER ROLE wardenx_app LOGIN");
    handle = createDbClient({
      connectionString: (DB_URL as string).replace("://postgres@", "://wardenx_app@"),
    });
    service = createDbEmarBackend(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("listAdministrations returns the org's seeded administration (RLS-scoped)", async () => {
    const rows = await service.listAdministrations(ORG_A, { patient: PATIENT });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(seeded[ORG_A].administrationRecord);
    expect(rows[0].patientId).toBe(PATIENT);
    expect(rows[0].mode).toBe("single_dose");
  });

  it("listScheduledDoses and listDeployments return the org's seeded rows", async () => {
    const doses = await service.listScheduledDoses(ORG_A, { patient: PATIENT });
    expect(doses.map((d) => d.id)).toContain(seeded[ORG_A].scheduledDose);
    const deployments = await service.listDeployments(ORG_A, PATIENT);
    expect(deployments.map((d) => d.id)).toContain(seeded[ORG_A].comfortKitDeployment);
  });

  it("RLS: org B cannot see org A's administration through the read service", async () => {
    // Org B queries by org A's patient id — RLS scopes the read to org B's rows only, so nothing surfaces.
    const rows = await service.listAdministrations(ORG_B, { patient: PATIENT });
    expect(rows.every((r) => r.id !== seeded[ORG_A].administrationRecord)).toBe(true);
    // A direct getAdministration of org A's row from org B is filtered out → NotFoundError (404).
    await expect(
      service.getAdministration(ORG_B, seeded[ORG_A].administrationRecord),
    ).rejects.toMatchObject({ statusCode: 404 });
    // Symmetrically, org B DOES see its own comfort-kit deployment (isolation is not "deny everything").
    const own = await service.listDeployments(ORG_B, PATIENT);
    expect(own.map((d) => d.id)).toContain(seeded[ORG_B].comfortKitDeployment);
  });

  it("writes are live (M13L): putPolicy persists + round-trips through getPolicy", async () => {
    const put = await service.putPolicy(ORG_A, { graceWindowMinutes: 45 });
    expect(put.graceWindowMinutes).toBe(45);
    const back = await service.getPolicy(ORG_A);
    expect(back.graceWindowMinutes).toBe(45);
  });
});
