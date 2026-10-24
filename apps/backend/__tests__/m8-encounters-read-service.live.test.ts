/**
 * M8L-T01 — the Drizzle `createDbEncounterRouteService` READ paths, proven against real Postgres.
 *
 * M8's pure suites drive the draft→signed→cosigned state machine over in-memory Maps and never touch a DB,
 * so they cannot prove the PRODUCTION read service actually returns rows, that RLS scopes every read by
 * tenant, or that the still-owed write lifecycle fail-closes. This applies the real migrations to a real
 * Postgres, seeds the M8 encounter chain for org A + B as superuser, then drives the mounted read service
 * as the unprivileged `chartwarden_app` role (no BYPASSRLS) — the same role `withOrgContext` runs under in prod.
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m8:read:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSeam } from "../src/bootstrap/seams/registry";
import {
  createAdmissionStatusReader,
  createDrizzleAdmissionReaderStore,
} from "../src/modules/06-admission/index";
import { createDbEncounterRouteService } from "../src/modules/08-encounters/encounters-route-service-db";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
/** patient_id / admission_id are NOT NULL but carry NO FK — literals are fine (as M6/M7/M8-RLS do). */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

describe.skipIf(!DB_URL)("M8 Drizzle read service — LIVE Postgres (M8L-T01)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbEncounterRouteService>;
  const seeded: Record<string, { encounter: string; membership: string }> = {};

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
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
          "-- (vector extension stripped: CHARTWARDEN_TEST_NO_PGVECTOR set)",
        );
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped: no pgvector)");
      }
      await admin.query(sql);
    }
  }

  /** Seed the minimal readable M8 chain for `org` (membership → provider_entity → location → encounter). */
  async function seedOrg(org: string, n: number) {
    const membership = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, org],
      )
    ).rows[0].id as string;
    const providerEntity = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M8R${n}`, `M8R Provider ${n}`, `NPI-M8R${n}`],
      )
    ).rows[0].id as string;
    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M8R${n}`],
      )
    ).rows[0].id as string;
    const encounter = (
      await admin.query(
        `INSERT INTO encounter (organization_id, provider_entity_id, location_id, patient_id, admission_id,
           encounter_type, discipline, authored_by_membership_id, service_date, status)
         VALUES ($1,$2,$3,$4,$5,'routine_visit','rn',$6, now()::date, 'draft') RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, membership],
      )
    ).rows[0].id as string;
    seeded[org] = { encounter, membership };
    if (org === ORG_A) {
      // createDraft resolves the admission through M6's AdmissionStatusReader (§2.7: the patient must
      // match, the service date may not precede activation, the status must allow authoring, and the
      // encounter is sited from the admission) — so org A's ADMISSION literal gets a real, active row.
      await admin.query(
        `INSERT INTO admission (id, organization_id, provider_entity_id, location_id, patient_id,
           status, admission_at, activated_at)
         VALUES ($1,$2,$3,$4,$5,'active','2025-12-01','2025-12-01')`,
        [ADMISSION, org, providerEntity, location, PATIENT],
      );
    }
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m8r@x.test')`, [USER]);
    await seedOrg(ORG_A, 1);
    await seedOrg(ORG_B, 2);
    // Prod connects as the NOBYPASSRLS `chartwarden_app` role (a login role SET ROLEs to it); `withOrgContext`
    // deliberately does NOT SET ROLE. To exercise RLS faithfully here, connect the client AS chartwarden_app —
    // it is NOLOGIN in the migrations, so grant LOGIN for the throwaway run.
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    // Production boot registers M6's reader seams (src/index.ts → registerAdmissionSeams); bind the
    // same Drizzle-backed AdmissionStatusReader over this suite's NOBYPASSRLS app-role handle, as the
    // M8 write suite does.
    registerSeam(
      "AdmissionStatusReader",
      createAdmissionStatusReader(createDrizzleAdmissionReaderStore(handle.db)),
    );
    service = createDbEncounterRouteService(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("listEncounters returns the org's encounter (RLS-scoped), in the EncounterView shape", async () => {
    const { encounters } = await service.listEncounters(ORG_A);
    expect(encounters.length).toBe(1);
    const e = encounters[0];
    expect(e.id).toBe(seeded[ORG_A].encounter);
    expect(e.organizationId).toBe(ORG_A);
    expect(e.status).toBe("draft");
    expect(e.discipline).toBe("rn");
    expect(e.encounterType).toBe("routine_visit");
    // The DB projects the authoring membership id into the in-memory `authoredByUserId` slot.
    expect(e.authoredByUserId).toBe(seeded[ORG_A].membership);
  });

  it("getEncounter returns the EncounterView for a real encounter", async () => {
    const detail = await service.getEncounter(ORG_A, seeded[ORG_A].encounter);
    expect(detail.id).toBe(seeded[ORG_A].encounter);
    expect(detail.status).toBe("draft");
    expect(detail.isF2f).toBe(false);
    expect(detail.signedAt).toBeNull();
    expect(detail.cosignedAt).toBeNull();
  });

  it("RLS: org B cannot see org A's encounter through the read service", async () => {
    const { encounters } = await service.listEncounters(ORG_B);
    expect(encounters.every((e) => e.id !== seeded[ORG_A].encounter)).toBe(true);
    expect(encounters.length).toBe(1);
    expect(encounters[0].id).toBe(seeded[ORG_B].encounter);
    // A cross-tenant fetch is a non-leaking 404 (the row is invisible under RLS, so `loadRow` sees null).
    await expect(service.getEncounter(ORG_B, seeded[ORG_A].encounter)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("createDraft now persists a real draft (the M8L-T02 write lifecycle; full coverage in the write suite)", async () => {
    const draft = await service.createDraft(ORG_A, seeded[ORG_A].membership, {
      patientId: PATIENT,
      admissionId: ADMISSION,
      encounterType: "routine_visit",
      discipline: "rn",
      serviceDate: "2026-01-01",
    });
    expect(draft.status).toBe("draft");
    expect(draft.version).toBe(0);
    const detail = await service.getEncounter(ORG_A, draft.id);
    expect(detail.id).toBe(draft.id);
    expect(detail.authoredByUserId).toBe(seeded[ORG_A].membership);
  });
});
