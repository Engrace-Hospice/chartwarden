import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
/**
 * M17 — `VisitReader.nextScheduledVisitForPatient` (the M36 context-panel read seam) proven against real
 * Postgres as the NOBYPASSRLS `wardenx_app` role: earliest future published/en_route visit, the status and
 * `>= asOf` boundaries, patient and tenant isolation, and the DTO shape (no notes / cancellation / EVV ids).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m17:next-visit:live
 * (no pgvector locally: CHARTWARDEN_TEST_NO_PGVECTOR=1)
 */
import { createDrizzleSchedulingSeamStore } from "../src/modules/17-scheduling/seams/drizzle-store";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const OTHER_PATIENT = "44444444-4444-4444-4444-444444444445";
const EMPTY_PATIENT = "44444444-4444-4444-4444-444444444446";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const ASOF = "2031-03-15T12:00:00.000Z";
const HOUR = 3_600_000;
const at = (offsetHours: number) => new Date(Date.parse(ASOF) + offsetHours * HOUR);

type OrgFixture = { provider: string; location: string; membership: string };

describe.skipIf(!DB_URL)("M17 nextScheduledVisitForPatient — LIVE Postgres as wardenx_app", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let store: ReturnType<typeof createDrizzleSchedulingSeamStore>;
  const fixtures: Record<string, OrgFixture> = {};

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
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  async function seedOrg(org: string, n: number): Promise<OrgFixture> {
    const provider = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-NV${n}`, `NV Provider ${n}`, `NPI-NV${n}`],
      )
    ).rows[0].id as string;
    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [provider, `Loc-NV${n}`],
      )
    ).rows[0].id as string;
    const user = (
      await admin.query(`INSERT INTO "user" (email) VALUES ('nv-rn-${n}@x.test') RETURNING id`)
    ).rows[0].id as string;
    const membership = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [user, org],
      )
    ).rows[0].id as string;
    return { provider, location, membership };
  }

  /** Insert one visit as superuser. Visits are spaced >= 2h apart per clinician (D6 overlap EXCLUDE). */
  async function seedVisit(
    org: string,
    patient: string,
    start: Date,
    status: string,
    durationMs = HOUR,
  ): Promise<string> {
    const f = fixtures[org];
    return (
      await admin.query(
        `INSERT INTO visit (organization_id, provider_entity_id, location_id, patient_id, admission_id,
           assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, visit_setting,
           scheduled_started_at, scheduled_ended_at, service_date, status, scheduler_internal_notes)
         VALUES ($1,$2,$3,$4,$5,$6,'rn','routine_visit','patient_home',$7,$8,$9,$10,'SECRET-NOTE') RETURNING id`,
        [
          org,
          f.provider,
          f.location,
          patient,
          ADMISSION,
          f.membership,
          start,
          new Date(start.getTime() + durationMs),
          start.toISOString().slice(0, 10),
          status,
        ],
      )
    ).rows[0].id as string;
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
    fixtures[ORG_A] = await seedOrg(ORG_A, 1);
    fixtures[ORG_B] = await seedOrg(ORG_B, 2);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    store = createDrizzleSchedulingSeamStore(handle.db);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  async function clearVisits() {
    await admin.query("DELETE FROM visit");
  }

  it("proves the connection is the NOBYPASSRLS app role", async () => {
    const probe = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await probe.connect();
    const { rows } = await probe.query(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user",
    );
    await probe.end();
    expect(rows[0]).toMatchObject({
      current_user: "wardenx_app",
      rolsuper: false,
      rolbypassrls: false,
    });
  });

  it("returns null when the patient has no visits at all", async () => {
    await clearVisits();
    expect(await store.nextScheduledVisitForPatient(ORG_A, EMPTY_PATIENT, ASOF)).toBeNull();
  });

  it("picks the earliest future visit among several (inserted out of order)", async () => {
    await clearVisits();
    await seedVisit(ORG_A, PATIENT, at(48), "published");
    const earliest = await seedVisit(ORG_A, PATIENT, at(5), "published");
    await seedVisit(ORG_A, PATIENT, at(24), "en_route");
    const next = await store.nextScheduledVisitForPatient(ORG_A, PATIENT, ASOF);
    expect(next?.id).toBe(earliest);
    expect(next?.status).toBe("published");
    expect(next?.organizationId).toBe(ORG_A);
    expect(next?.patientId).toBe(PATIENT);
  });

  it("counts en_route as upcoming", async () => {
    await clearVisits();
    const id = await seedVisit(ORG_A, PATIENT, at(3), "en_route");
    expect((await store.nextScheduledVisitForPatient(ORG_A, PATIENT, ASOF))?.id).toBe(id);
  });

  it.each(["proposed", "in_visit", "completed", "no_show", "cancelled", "rescheduled"])(
    "ignores a future %s visit",
    async (status) => {
      await clearVisits();
      await seedVisit(ORG_A, PATIENT, at(3), status);
      expect(await store.nextScheduledVisitForPatient(ORG_A, PATIENT, ASOF)).toBeNull();
    },
  );

  it("skips non-upcoming statuses and returns the later upcoming visit", async () => {
    await clearVisits();
    await seedVisit(ORG_A, PATIENT, at(3), "cancelled");
    await seedVisit(ORG_A, PATIENT, at(6), "proposed");
    const later = await seedVisit(ORG_A, PATIENT, at(30), "published");
    expect((await store.nextScheduledVisitForPatient(ORG_A, PATIENT, ASOF))?.id).toBe(later);
  });

  it("ignores past visits, includes a visit exactly at asOf, excludes 1s before", async () => {
    await clearVisits();
    await seedVisit(ORG_A, PATIENT, at(-30), "published");
    await seedVisit(ORG_A, PATIENT, new Date(Date.parse(ASOF) - 1000), "published", 999);
    expect(await store.nextScheduledVisitForPatient(ORG_A, PATIENT, ASOF)).toBeNull();
    const exact = await seedVisit(ORG_A, PATIENT, at(0), "published");
    expect((await store.nextScheduledVisitForPatient(ORG_A, PATIENT, ASOF))?.id).toBe(exact);
  });

  it("finds a visit later the same day whose service_date is the asOf UTC date", async () => {
    await clearVisits();
    const id = await seedVisit(ORG_A, PATIENT, at(0.5), "published");
    expect((await store.nextScheduledVisitForPatient(ORG_A, PATIENT, ASOF))?.id).toBe(id);
  });

  it("ignores other patients' visits", async () => {
    await clearVisits();
    await seedVisit(ORG_A, OTHER_PATIENT, at(2), "published");
    const mine = await seedVisit(ORG_A, PATIENT, at(10), "published");
    expect((await store.nextScheduledVisitForPatient(ORG_A, PATIENT, ASOF))?.id).toBe(mine);
  });

  it("cross-tenant: org B's visit is never returned for org A, and the wrong org yields null", async () => {
    await clearVisits();
    const aVisit = await seedVisit(ORG_A, PATIENT, at(20), "published");
    const bVisit = await seedVisit(ORG_B, PATIENT, at(2), "published");
    const forA = await store.nextScheduledVisitForPatient(ORG_A, PATIENT, ASOF);
    expect(forA?.id).toBe(aVisit);
    const forB = await store.nextScheduledVisitForPatient(ORG_B, PATIENT, ASOF);
    expect(forB?.id).toBe(bVisit);
    await admin.query("DELETE FROM visit WHERE organization_id = $1", [ORG_A]);
    // org A has nothing now; org B's earlier visit must not bleed through
    expect(await store.nextScheduledVisitForPatient(ORG_A, PATIENT, ASOF)).toBeNull();
    // a patient only org A knows, asked under org B
    const aOnly = await seedVisit(ORG_A, EMPTY_PATIENT, at(4), "published");
    expect((await store.nextScheduledVisitForPatient(ORG_A, EMPTY_PATIENT, ASOF))?.id).toBe(aOnly);
    expect(await store.nextScheduledVisitForPatient(ORG_B, EMPTY_PATIENT, ASOF)).toBeNull();
  });

  it("returns exactly the VisitDto fields (no notes, cancellation or EVV-event columns)", async () => {
    await clearVisits();
    await seedVisit(ORG_A, PATIENT, at(3), "published");
    const next = await store.nextScheduledVisitForPatient(ORG_A, PATIENT, ASOF);
    expect(Object.keys(next ?? {}).sort()).toEqual(
      [
        "id",
        "organizationId",
        "providerEntityId",
        "locationId",
        "patientId",
        "admissionId",
        "patientAddressId",
        "externalFacilityId",
        "assignedMembershipId",
        "assignedDisciplineAtAssignment",
        "visitPurpose",
        "visitSetting",
        "scheduledStartedAt",
        "scheduledEndedAt",
        "serviceDate",
        "actualStartedAt",
        "actualEndedAt",
        "status",
        "evvBracketState",
        "encounterId",
      ].sort(),
    );
    expect(JSON.stringify(next)).not.toContain("SECRET-NOTE");
  });

  describe("linkSummary (M36 WP 3.2 clinical link)", () => {
    it("finds a visit: 4 keys only, scheduled start as occurredAt, no scheduler note leaked", async () => {
      await clearVisits();
      const id = await seedVisit(ORG_A, PATIENT, at(3), "published");
      const out = await store.linkSummary(ORG_A, id);
      expect(out).toEqual({
        id,
        patientId: PATIENT,
        status: "published",
        occurredAt: at(3).toISOString(),
      });
      expect(Object.keys(out ?? {}).sort()).toEqual(["id", "occurredAt", "patientId", "status"]);
      expect(JSON.stringify(out)).not.toContain("SECRET-NOTE");
    });

    it("resolves a past, terminal-status visit too (a link outlives the schedule)", async () => {
      await clearVisits();
      const id = await seedVisit(ORG_A, PATIENT, at(-72), "completed");
      expect((await store.linkSummary(ORG_A, id))?.status).toBe("completed");
    });

    it("returns null for an unknown id", async () => {
      await clearVisits();
      expect(await store.linkSummary(ORG_A, "99999999-9999-9999-9999-999999999999")).toBeNull();
    });

    it("cross-tenant: org B's visit id is null under org A, found under org B", async () => {
      await clearVisits();
      const bVisit = await seedVisit(ORG_B, PATIENT, at(2), "published");
      expect(await store.linkSummary(ORG_A, bVisit)).toBeNull();
      expect((await store.linkSummary(ORG_B, bVisit))?.id).toBe(bVisit);
    });
  });
});
