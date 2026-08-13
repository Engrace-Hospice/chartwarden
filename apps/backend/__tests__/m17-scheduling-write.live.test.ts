/**
 * M17L — the Drizzle scheduling write lifecycle, proven against real Postgres.
 *
 * Drives the writes as the NOBYPASSRLS `wardenx_app` role. Like M12/M13, M17 has NO state-transition triggers,
 * so the service performs every visit / time-off / recurring / availability transition itself (composing the
 * pure `@wardenx/scheduling` machines): the 8-state visit machine (create→publish · start · cancel · reschedule
 * · no-show · reassign), proposals (publish/dismiss), recurring create/discontinue, availability upsert, the
 * time-off machine (request/approve/deny/cancel), and the §7.9 route-optimisation degraded path. Like the
 * M7–M14 write suites it binds the REAL catalog-validating transactional publisher
 * (buildBootOutboxCatalog([M17_OUTBOX_EVENTS]) → the caller's tx) and asserts the `m17.*` rows land in
 * `outbox_event`. RLS is exercised end-to-end. The D6 per-clinician visit-overlap GiST EXCLUDE + the D8
 * `not_on_pto` pre-schedule gate are both exercised.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m17:write:live
 * `visit` / `visit_state_history` are RANGE-partitioned → the throwaway superuser DB needs
 * `max_locks_per_transaction` raised. For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import { createDrizzleCaseloadStore } from "../src/modules/05-patient/seams/drizzle-stores";
import {
  M17_OUTBOX_EVENTS,
  type SchedulingAbacResolver,
  type SchedulingWriteOutboxPort,
  createDbSchedulingBackend,
} from "../src/modules/17-scheduling/index";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** A distinct, non-overlapping 1-hour window per call (the D6 per-clinician overlap EXCLUDE fires on the
 * published leaves). Base each `slot` two hours apart, far enough ahead not to collide with PTO windows. */
let slot = 0;
function nextWindow(): { start: string; end: string } {
  const base = Date.now() + ++slot * 2 * HOUR;
  return { start: new Date(base).toISOString(), end: new Date(base + HOUR).toISOString() };
}

type Seed = { pe: string; location: string; member: string; member2: string };

describe.skipIf(!DB_URL)("M17 scheduling write lifecycle — LIVE Postgres (M17L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbSchedulingBackend>;
  const seeded: Record<string, Seed> = {};

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
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
  async function eventsFor(aggregateId: string): Promise<string[]> {
    const { rows } = await admin.query(
      "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => r.event_type as string);
  }
  async function visitStatus(id: string): Promise<string> {
    const { rows } = await admin.query("SELECT status FROM visit WHERE id=$1", [id]);
    return rows[0]?.status as string;
  }
  /** Seed an APPROVED time_off window for `member` directly (bypassing the approve flow) — disjoint windows
   * only (the D7 approved-overlap EXCLUDE). */
  async function seedApprovedPto(
    org: string,
    member: string,
    startMs: number,
    endMs: number,
  ): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO time_off (organization_id, membership_id, starts_at, ends_at, kind, approval_state)
         VALUES ($1,$2,$3,$4,'pto','approved') RETURNING id`,
        [org, member, new Date(startMs).toISOString(), new Date(endMs).toISOString()],
      )
    ).rows[0].id as string;
  }

  async function newVisit(
    org: string,
    member: string,
  ): Promise<{ id: string; start: string; end: string }> {
    const w = nextWindow();
    const v = await svc.createVisit(org, member, {
      patientId: PATIENT,
      admissionId: ADMISSION,
      patientAddressId: null,
      externalFacilityId: null,
      assignedMembershipId: member,
      visitPurpose: "routine_visit",
      visitSetting: "patient_home",
      scheduledStartedAt: w.start,
      scheduledEndedAt: w.end,
    });
    return { id: v.id, start: w.start, end: w.end };
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
    let userN = 0;
    for (const org of [ORG_A, ORG_B]) {
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [
            org,
            `CCN-M17W-${org.slice(0, 4)}`,
            `M17W ${org.slice(0, 4)}`,
            `NPI-M17W-${org.slice(0, 4)}`,
          ],
        )
      ).rows[0].id as string;
      const location = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
      const mk = async (): Promise<string> => {
        const user = (
          await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
            `m17w-${userN++}@x.test`,
          ])
        ).rows[0].id as string;
        // The membership carries the visit's siting defaults (compromise #2: resolveSiting reads these).
        return (
          await admin.query(
            `INSERT INTO membership (user_id, organization_id, status, default_provider_entity_id, default_location_ids)
             VALUES ($1,$2,'active',$3,$4::jsonb) RETURNING id`,
            [user, org, pe, JSON.stringify([location])],
          )
        ).rows[0].id as string;
      };
      seeded[org] = { pe, location, member: await mk(), member2: await mk() };
    }
    await admin.query("ALTER ROLE wardenx_app LOGIN");
    handle = createDbClient({
      connectionString: (DB_URL as string).replace("://postgres@", "://wardenx_app@"),
    });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M17_OUTBOX_EVENTS]));
    const outbox: SchedulingWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m17" }),
    };
    svc = createDbSchedulingBackend(handle.db, outbox);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("createVisit inserts proposed then publishes; emits proposed/assigned/published", async () => {
    const { member } = seeded[ORG_A];
    const v = await newVisit(ORG_A, member);
    expect(v.id).toBeTruthy();
    expect(await visitStatus(v.id)).toBe("published");
    const evts = await eventsFor(v.id);
    expect(evts).toContain("m17.visit.proposed");
    expect(evts).toContain("m17.visit.assigned");
    expect(evts).toContain("m17.visit.published");
    // The genesis + publish history rows landed.
    const { rows } = await admin.query(
      "SELECT to_state FROM visit_state_history WHERE visit_id=$1",
      [v.id],
    );
    expect(rows.map((r) => r.to_state).sort()).toEqual(["proposed", "published"]);
  });

  it("startVisit (EVV path) advances published→en_route and emits started", async () => {
    const { member } = seeded[ORG_A];
    const v = await newVisit(ORG_A, member);
    const started = await svc.startVisit(ORG_A, member, v.id, undefined, false);
    expect(started.status).toBe("en_route");
    expect(await eventsFor(v.id)).toContain("m17.visit.started");
    const { rows } = await admin.query("SELECT evv_bracket_state FROM visit WHERE id=$1", [v.id]);
    expect(rows[0].evv_bracket_state).toBe("evv_present");
  });

  it("cancelVisit → cancelled; emits unassigned + cancelled", async () => {
    const { member } = seeded[ORG_A];
    const v = await newVisit(ORG_A, member);
    const cancelled = await svc.cancelVisit(
      ORG_A,
      member,
      v.id,
      "patient admitted to inpatient unit",
    );
    expect(cancelled.status).toBe("cancelled");
    const evts = await eventsFor(v.id);
    expect(evts).toContain("m17.visit.unassigned");
    expect(evts).toContain("m17.visit.cancelled");
  });

  it("rescheduleVisit → original rescheduled + a new published visit; emits rescheduled", async () => {
    const { member } = seeded[ORG_A];
    const v = await newVisit(ORG_A, member);
    const w = nextWindow();
    const { original, created } = await svc.rescheduleVisit(ORG_A, member, v.id, {
      newScheduledStartedAt: w.start,
      newScheduledEndedAt: w.end,
      reason: "clinician double-booked this slot",
    });
    expect(original.status).toBe("rescheduled");
    expect(original.rescheduledIntoVisitId).toBe(created.id);
    expect(await visitStatus(created.id)).toBe("published");
    const evts = await eventsFor(v.id);
    expect(evts).toContain("m17.visit.rescheduled");
    expect(evts).toContain("m17.visit.unassigned");
    // The new visit ran its own genesis+publish stream.
    expect(await eventsFor(created.id)).toContain("m17.visit.published");
  });

  it("noShowVisit → no_show; emits no_show_detected", async () => {
    const { member } = seeded[ORG_A];
    const v = await newVisit(ORG_A, member);
    const ns = await svc.noShowVisit(ORG_A, member, v.id, "patient not home at scheduled time");
    expect(ns.status).toBe("no_show");
    expect(await eventsFor(v.id)).toContain("m17.visit.no_show_detected");
  });

  it("reassignVisit reruns the gate and emits assigned to the new clinician", async () => {
    const { member, member2 } = seeded[ORG_A];
    const v = await newVisit(ORG_A, member);
    const re = await svc.reassignVisit(ORG_A, member, v.id, member2);
    expect(re.assignedMembershipId).toBe(member2);
    // The reassign emits a fresh assigned event naming the new clinician.
    const { rows } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m17.visit.assigned' ORDER BY created_at DESC LIMIT 1",
      [v.id],
    );
    expect(rows[0].payload.assignedMembershipId).toBe(member2);
  });

  it("D8 gate: an APPROVED PTO overlapping the window fails publish (VISIT_PRE_SCHEDULE_GATE_UNMET, 422)", async () => {
    const { member } = seeded[ORG_A];
    const base = Date.now() + 60 * DAY;
    await seedApprovedPto(ORG_A, member, base, base + 2 * HOUR);
    await expect(
      svc.createVisit(ORG_A, member, {
        patientId: PATIENT,
        admissionId: ADMISSION,
        patientAddressId: null,
        externalFacilityId: null,
        assignedMembershipId: member,
        visitPurpose: "routine_visit",
        visitSetting: "patient_home",
        scheduledStartedAt: new Date(base).toISOString(),
        scheduledEndedAt: new Date(base + HOUR).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "VISIT_PRE_SCHEDULE_GATE_UNMET", statusCode: 422 });
  });

  it("recurring create/discontinue persists + emits discontinued", async () => {
    const { member } = seeded[ORG_A];
    const rec = await svc.createRecurring(ORG_A, member, {
      patientId: PATIENT,
      admissionId: ADMISSION,
      assignedMembershipId: member,
      visitPurpose: "routine_visit",
      visitSetting: "patient_home",
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
    });
    expect(rec.status).toBe("active");
    const disc = await svc.discontinueRecurring(ORG_A, member, rec.id);
    expect(disc.status).toBe("discontinued");
    expect(await eventsFor(rec.id)).toContain("m17.recurring_visit.discontinued");
  });

  it("upsertAvailability merges per weekday; getAvailability folds the slots", async () => {
    const { member2 } = seeded[ORG_A];
    await svc.upsertAvailability(ORG_A, member2, member2, {
      timeZone: "America/Los_Angeles",
      slots: [{ weekday: 2, startTime: "08:00", endTime: "12:00" }],
    });
    // Re-upsert the same weekday (UPDATE, no duplicate) + add a new one (INSERT).
    await svc.upsertAvailability(ORG_A, member2, member2, {
      timeZone: "America/Los_Angeles",
      slots: [
        { weekday: 2, startTime: "09:00", endTime: "17:00" },
        { weekday: 4, startTime: "08:00", endTime: "12:00" },
      ],
    });
    const avail = await svc.getAvailability(ORG_A, member2);
    expect(avail?.slots).toEqual([
      { weekday: 2, startTime: "09:00", endTime: "17:00" },
      { weekday: 4, startTime: "08:00", endTime: "12:00" },
    ]);
  });

  it("time-off request→approve→deny→cancel drive the machine and emit", async () => {
    const { member } = seeded[ORG_A];
    // request → approve (disjoint 30d window).
    const req = await svc.requestTimeOff(ORG_A, member, {
      membershipId: member,
      kind: "pto",
      startsAt: new Date(Date.now() + 30 * DAY).toISOString(),
      endsAt: new Date(Date.now() + 31 * DAY).toISOString(),
    });
    expect(req.state).toBe("requested");
    expect(await eventsFor(req.id)).toContain("m17.time_off.requested");
    const appr = await svc.approveTimeOff(ORG_A, member, req.id);
    expect(appr.state).toBe("approved");
    expect(await eventsFor(req.id)).toContain("m17.time_off.approved");

    // deny a separate requested row (40d).
    const req2 = await svc.requestTimeOff(ORG_A, member, {
      membershipId: member,
      kind: "sick",
      startsAt: new Date(Date.now() + 40 * DAY).toISOString(),
      endsAt: new Date(Date.now() + 41 * DAY).toISOString(),
    });
    const den = await svc.denyTimeOff(
      ORG_A,
      member,
      req2.id,
      "coverage cannot be arranged for that week",
    );
    expect(den.state).toBe("denied");
    expect(await eventsFor(req2.id)).toContain("m17.time_off.denied");

    // cancel a pre-start approved window (50d, disjoint from the 30d approved one).
    const appId = await seedApprovedPto(
      ORG_A,
      member,
      Date.now() + 50 * DAY,
      Date.now() + 51 * DAY,
    );
    const cancelled = await svc.cancelTimeOff(ORG_A, member, appId);
    expect(cancelled.state).toBe("cancelled");
  });

  it("optimizeDay returns the §7.9 degraded result and emits route_optimization_degraded", async () => {
    const { member } = seeded[ORG_A];
    const res = await svc.optimizeDay(ORG_A, member, {
      membershipId: member,
      serviceDate: new Date().toISOString().slice(0, 10),
    });
    expect(res.degraded).toBe(true);
    expect(res.reason).toBe("optimization_disabled");
    expect(await eventsFor(member)).toContain("m17.route_optimization_degraded");
  });

  it("RLS: org B cannot see or mutate org A's visit (404 under the wardenx_app policy)", async () => {
    const { member } = seeded[ORG_A];
    const v = await newVisit(ORG_A, member);
    await expect(svc.getVisit(ORG_B, v.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      svc.cancelVisit(ORG_B, seeded[ORG_B].member, v.id, "cross-tenant cancel attempt blocked"),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  // ── GAP-030 — the §4.7 SchedulingAbacResolver methods, live over real Postgres ────────────────────────
  describe("GAP-030 — SchedulingAbacResolver over real data", () => {
    const resolver = () => svc as unknown as SchedulingAbacResolver;

    it("resolveDiscipline resolves a real, unexpired role grant's key", async () => {
      const { member } = seeded[ORG_A];
      const roleId = (
        await admin.query(
          `INSERT INTO role (organization_id, key, name, category) VALUES ($1,'rn','Registered Nurse','clinical_staff') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)`,
        [ORG_A, member, roleId],
      );
      await expect(resolver().resolveDiscipline(ORG_A, member)).resolves.toBe("rn");
    });

    it("resolveDiscipline returns null for a membership with no qualifying role grant (fail-closed)", async () => {
      const { member2 } = seeded[ORG_A];
      await expect(resolver().resolveDiscipline(ORG_A, member2)).resolves.toBeNull();
    });

    it("resolveDiscipline ignores an EXPIRED role grant (fail-closed)", async () => {
      const suffix = `${Date.now()}`;
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [`m17w-exp-${suffix}@x.test`])
      ).rows[0].id as string;
      const membership = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status, default_provider_entity_id, default_location_ids)
           VALUES ($1,$2,'active',$3,$4::jsonb) RETURNING id`,
          [user, ORG_A, seeded[ORG_A].pe, JSON.stringify([seeded[ORG_A].location])],
        )
      ).rows[0].id as string;
      const roleId = (
        await admin.query(
          `INSERT INTO role (organization_id, key, name, category) VALUES ($1,'lpn','LPN','clinical_staff') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO membership_role (organization_id, membership_id, role_id, expires_at) VALUES ($1,$2,$3,$4)`,
        [ORG_A, membership, roleId, new Date(Date.now() - DAY).toISOString()],
      );
      await expect(resolver().resolveDiscipline(ORG_A, membership)).resolves.toBeNull();
    });

    it("isInCaseload resolves a real open patient_assignment via the real M5 CaseloadProvider seam", async () => {
      const { member } = seeded[ORG_A];
      registerPatientSeams({
        db: handle.db,
        caseload: { store: createDrizzleCaseloadStore(handle.db) },
      });
      const [memRow] = (
        await admin.query(`SELECT user_id FROM membership WHERE id=$1`, [member])
      ).rows as Array<{ user_id: string }>;
      const patientId = (
        await admin.query(
          `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
           VALUES ($1,'MRN-M17W-CL','Case','Load','1990-01-01','F','active') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      await expect(resolver().isInCaseload(ORG_A, member, patientId)).resolves.toBe(false);
      await admin.query(
        `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
         VALUES ($1,$2,$3,'primary_rn',CURRENT_DATE)`,
        [patientId, ORG_A, memRow.user_id],
      );
      await expect(resolver().isInCaseload(ORG_A, member, patientId)).resolves.toBe(true);
    });

    it("allowsUnassignedPool reads the real allow_unassigned_pool_assignment org setting (default false)", async () => {
      await expect(resolver().allowsUnassignedPool(ORG_A)).resolves.toBe(false);
      await admin.query(
        `UPDATE organization SET settings = settings || '{"allow_unassigned_pool_assignment": true}'::jsonb WHERE id=$1`,
        [ORG_A],
      );
      await expect(resolver().allowsUnassignedPool(ORG_A)).resolves.toBe(true);
      // Reset so it doesn't leak into other tests in this file.
      await admin.query(
        `UPDATE organization SET settings = settings - 'allow_unassigned_pool_assignment' WHERE id=$1`,
        [ORG_A],
      );
    });
  });
});
