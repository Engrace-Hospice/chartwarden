/**
 * M10L — the Drizzle `createDbHopeBackend` READ paths, proven against real Postgres.
 *
 * M10's pure suites exercise the timepoint/SFV/validation/submission machines in memory; this drives the
 * PRODUCTION read service (the object the composition root mounts as BOTH HopeRouteService and the §4.7
 * HopeAbacResolver) over the real M10-owned tables under `withOrgContext` — proving the timepoint-schedule
 * worklist and the (partitioned) HOPE-assessment reads return the right rows, RLS scopes every read by
 * tenant as the unprivileged `chartwarden_app` role, and every write fail-closes 501.
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m10-hope-read-service.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
// patient_id / admission_id are NOT NULL on every M10 table but carry NO FK — literals are fine. PATIENT is
// shared across both orgs so `listPatientAssessments(ORG_A, PATIENT)` is a real cross-tenant RLS probe.
const PATIENT = "44444444-4444-4444-4444-444444444444";
// Distinct per org: `uniq_hope_sched_admission_rfa_open` is UNIQUE(admission_id, rfa_kind) and does NOT
// include organization_id, so two orgs sharing one admission literal would collide.
const ADMISSION_A = "55555555-5555-5555-5555-555555555555";
const ADMISSION_B = "66666666-6666-6666-6666-666666666666";

type SeedIds = {
  membership: string;
  providerEntity: string;
  location: string;
  schedule: string;
  assessment: string;
};

describe.skipIf(!DB_URL)("M10 Drizzle read service — LIVE Postgres (M10L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbHopeBackend>;
  let a: SeedIds;
  let b: SeedIds;

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

  /** Seed one M10 HOPE chain for `org` as superuser (RLS + grants bypassed). Proven seed from
   *  packages/db/migrations/__tests__/m10-rls-isolation.live.test.ts — hope_assessment is RANGE-partitioned
   *  on target_date, so it is seeded with a valid (now()) target_date. */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const ADMISSION = n === 1 ? ADMISSION_A : ADMISSION_B;
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
        [org, `CCN-M10R${n}`, `M10R Provider ${n}`, `NPI-M10R${n}`],
      )
    ).rows[0].id as string;
    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M10R${n}`],
      )
    ).rows[0].id as string;
    const schedule = (
      await admin.query(
        `INSERT INTO hope_timepoint_schedule (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, rfa_kind, window_opens_at, window_closes_at, late_deadline_at, alert_cadence,
           generated_by)
         VALUES ($1,$2,$3,$4,$5,'01_admission', now(), now() + interval '5 days', now() + interval '10 days',
           '{}'::jsonb, 'auto_admission') RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION],
      )
    ).rows[0].id as string;
    const assessment = (
      await admin.query(
        `INSERT INTO hope_assessment (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, schedule_id, rfa_kind, data, target_date, created_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6,'01_admission', '{}'::jsonb, now(), $7) RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, schedule, membership],
      )
    ).rows[0].id as string;
    return { membership, providerEntity, location, schedule, assessment };
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m10r@x.test')`, [USER]);
    a = await seedOrg(ORG_A, 1);
    b = await seedOrg(ORG_B, 2);
    // Prod connects as the NOBYPASSRLS `chartwarden_app` role; `withOrgContext` does NOT SET ROLE. To exercise
    // RLS faithfully, connect the client AS chartwarden_app — it is NOLOGIN in the migrations, so grant LOGIN.
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    service = createDbHopeBackend(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("listSchedules returns the org's seeded timepoint schedule (RLS-scoped)", async () => {
    const { schedules } = await service.listSchedules(ORG_A, {});
    expect(schedules.length).toBe(1);
    expect(schedules[0].id).toBe(a.schedule);
    expect(schedules[0].patientId).toBe(PATIENT);
    expect(schedules[0].status).toBe("open");
  });

  it("listPatientAssessments / getAssessment return org A's partitioned HOPE assessment", async () => {
    const { assessments } = await service.listPatientAssessments(ORG_A, PATIENT);
    expect(assessments.length).toBe(1);
    expect(assessments[0].id).toBe(a.assessment);
    const detail = await service.getAssessment(ORG_A, a.assessment);
    expect(detail.id).toBe(a.assessment);
    expect(detail.rfaKind).toBe("01_admission");
  });

  it("RLS: org B cannot see org A's rows through the read service", async () => {
    // Org B sees only its own schedule, never org A's (both orgs share the PATIENT literal).
    const { schedules } = await service.listSchedules(ORG_B, {});
    expect(schedules.every((s) => s.id !== a.schedule)).toBe(true);
    expect(schedules.map((s) => s.id)).toEqual([b.schedule]);
    // The shared PATIENT returns only org B's assessment under org B's context.
    const { assessments } = await service.listPatientAssessments(ORG_B, PATIENT);
    expect(assessments.every((x) => x.id !== a.assessment)).toBe(true);
    // A cross-tenant fetch of org A's assessment id is not found under org B.
    await expect(service.getAssessment(ORG_B, a.assessment)).rejects.toThrow();
  });

  it("skipSchedule now persists (the M10L write lifecycle; full coverage in the write suite)", async () => {
    const skipped = await service.skipSchedule(ORG_A, a.schedule, "patient_declined");
    expect(skipped.status).toBe("skipped");
    const back = await service.getSchedule(ORG_A, a.schedule);
    expect(back.status).toBe("skipped");
  });
});
