/**
 * M17L — the Drizzle `createDbSchedulingBackend` READ paths, proven against real Postgres.
 *
 * M17's pure suites drive the 8-state visit machine, the RRULE 90-day materializer and the four reader
 * seams, but they never touch a database, so they cannot catch a wrong RLS predicate or a base-table grant
 * that leaks across tenants through the PRODUCTION read service (the one the composition root mounts). This
 * drives that service over the real M17 tables under `withOrgContext` — proving the screen-driving reads
 * (visit list, availability, time-off) return the seeded rows, RLS scopes every read by tenant, and the
 * write / route-optimisation surface fail-closes 501 until the M17L write lifecycle lands.
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m17:read:live
 *
 * Live notes: `visit`/`visit_state_history` are RANGE-partitioned, so the throwaway superuser DB needs
 * `max_locks_per_transaction` raised (the DROP SCHEMA + partitioned corpus outrun the default 64). For a
 * local PG without pgvector, set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbSchedulingBackend } from "../src/modules/17-scheduling/scheduling-route-service-db";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** patient_id / admission_id are NOT NULL but carry NO FK (M5/M6 own those tables) — literals are fine. */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

type SeedIds = { visit: string; membership: string };

describe.skipIf(!DB_URL)("M17 Drizzle read service — LIVE Postgres (M17L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbSchedulingBackend>;
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
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
          "-- (vector extension stripped: WARDENX_TEST_NO_PGVECTOR set)",
        );
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped: no pgvector)");
      }
      await admin.query(sql);
    }
  }

  /** Seed one M17 schedule chain for `org` as superuser (RLS + grants bypassed). `n` distinguishes rows.
   * Mirrors the proven seed in packages/db/migrations/__tests__/m17-rls-isolation.live.test.ts. */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const providerEntity = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M17R${n}`, `M17R Provider ${n}`, `NPI-M17R${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M17R${n}`],
      )
    ).rows[0].id as string;

    // REAL membership: visit.assigned_membership_id, clinician_availability/time_off all carry SQL FKs to it.
    const user = (
      await admin.query(`INSERT INTO "user" (email) VALUES ('m17r-rn-${n}@x.test') RETURNING id`)
    ).rows[0].id as string;
    const membership = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [user, org],
      )
    ).rows[0].id as string;

    // `visit` is partitioned by service_date; now()::date lands in the current-month partition (a DEFAULT
    // catch-all exists regardless). Default status 'proposed' keeps it clear of the D6 overlap EXCLUDE.
    const visit = (
      await admin.query(
        `INSERT INTO visit (organization_id, provider_entity_id, location_id, patient_id, admission_id,
           assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, visit_setting,
           scheduled_started_at, scheduled_ended_at, service_date)
         VALUES ($1,$2,$3,$4,$5,$6,'rn','routine_visit','patient_home',
           now(), now() + interval '1 hour', now()::date) RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, membership],
      )
    ).rows[0].id as string;

    // Per-weekday availability slot the aggregate getAvailability read folds into one view.
    await admin.query(
      `INSERT INTO clinician_availability (organization_id, provider_entity_id, location_id, membership_id,
         day_of_week, start_time, end_time)
       VALUES ($1,$2,$3,$4,1,'08:00','17:00')`,
      [org, providerEntity, location, membership],
    );

    // Default approval_state 'requested' keeps this clear of the D7 PTO-overlap EXCLUDE (approved-only).
    await admin.query(
      `INSERT INTO time_off (organization_id, provider_entity_id, location_id, membership_id,
         starts_at, ends_at, kind)
       VALUES ($1,$2,$3,$4, now(), now() + interval '1 day','pto')`,
      [org, providerEntity, location, membership],
    );

    return { visit, membership };
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
    seeded[ORG_A] = await seedOrg(ORG_A, 1);
    seeded[ORG_B] = await seedOrg(ORG_B, 2);
    // Prod connects as the NOBYPASSRLS `wardenx_app` role; `withOrgContext` deliberately does NOT SET ROLE.
    // To exercise RLS faithfully, connect the client AS wardenx_app — it is NOLOGIN in the migrations, so
    // grant LOGIN for the throwaway run.
    await admin.query("ALTER ROLE wardenx_app LOGIN");
    handle = createDbClient({
      connectionString: (DB_URL as string).replace("://postgres@", "://wardenx_app@"),
    });
    service = createDbSchedulingBackend(handle.db);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("listVisits returns the org's seeded visit (RLS-scoped), newest-first over service_date", async () => {
    const visits = await service.listVisits(ORG_A, {});
    expect(visits.length).toBe(1);
    expect(visits[0].id).toBe(seeded[ORG_A].visit);
    expect(visits[0].status).toBe("proposed");
    expect(visits[0].assignedMembershipId).toBe(seeded[ORG_A].membership);
  });

  it("getAvailability folds the weekday slots into one view; listTimeOff returns the seeded PTO", async () => {
    const avail = await service.getAvailability(ORG_A, seeded[ORG_A].membership);
    expect(avail).not.toBeNull();
    expect(avail?.membershipId).toBe(seeded[ORG_A].membership);
    // The service projects availability times as HH:MM (not the DB's HH:MM:SS).
    expect(avail?.slots).toEqual([{ weekday: 1, startTime: "08:00", endTime: "17:00" }]);

    const off = await service.listTimeOff(ORG_A, { membership: seeded[ORG_A].membership });
    expect(off.length).toBe(1);
    expect(off[0].kind).toBe("pto");
    expect(off[0].state).toBe("requested");
  });

  it("RLS: org B cannot see org A's visit through the read service", async () => {
    const bVisits = await service.listVisits(ORG_B, {});
    expect(bVisits.every((v) => v.id !== seeded[ORG_A].visit)).toBe(true);
    // An RLS-hidden row is indistinguishable from a missing one (NotFoundError, no existence oracle).
    await expect(service.getVisit(ORG_B, seeded[ORG_A].visit)).rejects.toMatchObject({
      statusCode: 404,
    });
    // Org B's availability probe against org A's membership is scoped away → null.
    expect(await service.getAvailability(ORG_B, seeded[ORG_A].membership)).toBeNull();
  });

  it("writes fail-closed 501 until the M17L write lifecycle lands", async () => {
    expect(() =>
      service.createVisit(ORG_A, "", {
        patientId: PATIENT,
        admissionId: ADMISSION,
        patientAddressId: null,
        externalFacilityId: null,
        assignedMembershipId: seeded[ORG_A].membership,
        visitPurpose: "routine_visit",
        visitSetting: "patient_home",
        scheduledStartedAt: new Date().toISOString(),
        scheduledEndedAt: new Date(Date.now() + 3_600_000).toISOString(),
      } as never),
    ).toThrow(expect.objectContaining({ statusCode: 501 }));

    await expect(
      service.optimizeDay(ORG_A, "", {
        membershipId: seeded[ORG_A].membership,
        serviceDate: new Date().toISOString().slice(0, 10),
      }),
    ).rejects.toMatchObject({ statusCode: 501 });
  });
});
