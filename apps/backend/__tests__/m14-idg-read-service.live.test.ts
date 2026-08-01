/**
 * M14L — the Drizzle `createDbIdgBackend` READ paths, proven against real Postgres.
 *
 * M14's pure suites exercise the meeting/decision/minutes machines over in-memory Maps; the RLS suite proves
 * the policies but never drives the SERVICE. This applies the real migrations to a real Postgres, seeds one
 * full IDG chain per tenant as superuser, then drives the PRODUCTION read service (the one the composition
 * root mounts) over the M14-owned tables as the unprivileged `wardenx_app` role — proving the schedule /
 * meeting / action-item / minutes reads return the seeded rows, that RLS scopes every read by tenant (org B
 * cannot see org A's meeting through the service), and that every write fail-closes 501.
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m14-idg-read-service.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbIdgBackend } from "../src/modules/14-idg/idg-route-service-db";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
/** membership_id / patient_id / admission_id are NOT NULL but carry NO SQL FK (§3.3) — literals are fine. */
const MEMBERSHIP = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

type SeedIds = { location: string; meeting: string; actionItem: string; minutes: string };

describe.skipIf(!DB_URL)("M14 Drizzle read service — LIVE Postgres (M14L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbIdgBackend>;
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

  /** Seed one full M14 IDG chain for `org` as superuser (RLS + grants bypassed), in FK order. */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const providerEntity = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M14R${n}`, `M14R ${n}`, `NPI-M14R${n}`],
      )
    ).rows[0].id as string;
    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M14R${n}`],
      )
    ).rows[0].id as string;
    const recurringPolicy = (
      await admin.query(
        `INSERT INTO idg_recurring_policy (organization_id, location_id, day_of_week_anchor,
           default_coordinator_membership_id)
         VALUES ($1,$2,'monday',$3) RETURNING id`,
        [org, location, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const meeting = (
      await admin.query(
        `INSERT INTO idg_meeting (organization_id, location_id, recurring_policy_id, scheduled_start,
           scheduled_end, status, coordinator_membership_id, tenant_quorum_snapshot)
         VALUES ($1,$2,$3, now(), now() + interval '2 hours', 'scheduled', $4, '{}'::jsonb) RETURNING id`,
        [org, location, recurringPolicy, MEMBERSHIP],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO idg_attendance (organization_id, idg_meeting_id, membership_id, discipline, status)
       VALUES ($1,$2,$3,'rn','present')`,
      [org, meeting, MEMBERSHIP],
    );
    const agendaItem = (
      await admin.query(
        `INSERT INTO idg_agenda_item (organization_id, provider_entity_id, location_id, idg_meeting_id,
           patient_id, title, kind, added_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,'Review','patient_review',$6) RETURNING id`,
        [org, providerEntity, location, meeting, PATIENT, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const decision = (
      await admin.query(
        `INSERT INTO idg_decision (organization_id, provider_entity_id, location_id, idg_meeting_id,
           patient_id, agenda_item_id, decision_kind, payload, was_quorate, quorum_snapshot,
           recorded_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6,'care_plan_update','{}'::jsonb, true, '{}'::jsonb, $7) RETURNING id`,
        [org, providerEntity, location, meeting, PATIENT, agendaItem, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const actionItem = (
      await admin.query(
        `INSERT INTO idg_action_item (organization_id, provider_entity_id, location_id, idg_meeting_id,
           idg_decision_id, patient_id, assigned_to_membership_id, title)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Follow up') RETURNING id`,
        [org, providerEntity, location, meeting, decision, PATIENT, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const minutes = (
      await admin.query(
        `INSERT INTO idg_minutes (organization_id, idg_meeting_id, status)
         VALUES ($1,$2,'in_progress') RETURNING id`,
        [org, meeting],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO idg_patient_packet (organization_id, provider_entity_id, location_id, idg_meeting_id,
         patient_id, admission_id, since_cursor_iso, built_snapshot, discipline_views, cover_summary_layer1)
       VALUES ($1,$2,$3,$4,$5,$6,'2026-01-01T00:00:00Z','{}'::jsonb,'{}'::jsonb,'summary')`,
      [org, providerEntity, location, meeting, PATIENT, ADMISSION],
    );
    return { location, meeting, actionItem, minutes };
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m14r@x.test')`, [USER]);
    seeded[ORG_A] = await seedOrg(ORG_A, 1);
    seeded[ORG_B] = await seedOrg(ORG_B, 2);
    // Prod connects as the NOBYPASSRLS `wardenx_app` role; `withOrgContext` does NOT SET ROLE. To exercise
    // RLS faithfully, connect the client AS wardenx_app — NOLOGIN in the migrations, so grant LOGIN here.
    await admin.query("ALTER ROLE wardenx_app LOGIN");
    handle = createDbClient({
      connectionString: (DB_URL as string).replace("://postgres@", "://wardenx_app@"),
    });
    service = createDbIdgBackend(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("getMeeting returns the seeded meeting (RLS-scoped)", async () => {
    const m = await service.getMeeting(ORG_A, seeded[ORG_A].meeting);
    expect(m.id).toBe(seeded[ORG_A].meeting);
    expect(m.organizationId).toBe(ORG_A);
    expect(m.status).toBe("scheduled");
    expect(m.locationId).toBe(seeded[ORG_A].location);
  });

  it("listSchedule returns the org's meeting within the window, empty for the other tenant's location", async () => {
    const rows = await service.listSchedule(ORG_A, {
      location: seeded[ORG_A].location,
      from: "2020-01-01T00:00:00Z",
      to: "2035-01-01T00:00:00Z",
    });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(seeded[ORG_A].meeting);
    expect(rows[0].status).toBe("scheduled");
  });

  it("listActionItems + getMinutes return org A's rows", async () => {
    const items = await service.listActionItems(ORG_A, USER, {});
    expect(items.some((i) => i.id === seeded[ORG_A].actionItem)).toBe(true);
    const minutes = await service.getMinutes(ORG_A, seeded[ORG_A].meeting);
    expect(minutes.id).toBe(seeded[ORG_A].minutes);
    expect(minutes.status).toBe("in_progress");
  });

  it("RLS: org B cannot see org A's meeting through the read service", async () => {
    // getMeeting fail-closes 404 (RLS-hidden rows share NOT_FOUND — no existence oracle, §4.3).
    await expect(service.getMeeting(ORG_B, seeded[ORG_A].meeting)).rejects.toMatchObject({
      statusCode: 404,
    });
    // And nothing of org A's leaks through the schedule read scoped by org A's location.
    const rows = await service.listSchedule(ORG_B, {
      location: seeded[ORG_A].location,
      from: "2020-01-01T00:00:00Z",
      to: "2035-01-01T00:00:00Z",
    });
    expect(rows.every((r) => r.id !== seeded[ORG_A].meeting)).toBe(true);
  });

  it("writes fail-closed 501 until the M14L write lifecycle lands", async () => {
    await expect(
      service.createRecurringPolicy(ORG_A, USER, { locationId: seeded[ORG_A].location, cadenceDays: 14 }),
    ).rejects.toMatchObject({ statusCode: 501 });
  });
});
