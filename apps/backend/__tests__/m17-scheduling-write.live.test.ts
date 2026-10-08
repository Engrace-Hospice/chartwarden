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
  registerSchedulingSeams,
} from "../src/modules/17-scheduling/index";
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
import { type CallerAuthority, NO_AUTHORITY } from "../src/modules/17-scheduling/routes/own-vs-any";
import { createDrizzleCredentialStore } from "../src/modules/17-scheduling/seams/credentials-drizzle-store";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

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
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M17_OUTBOX_EVENTS]));
    const outbox: SchedulingWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m17" }),
    };
    svc = createDbSchedulingBackend(handle.db, outbox);

    // GAP-031 — the service-layer D8 gate now resolves discipline/pool/caseload for real (not just PTO),
    // so `newVisit`'s clinicians need a real qualifying role, and the CaseloadProvider seam must be
    // registered before ANY gate check runs (`getSeam` throws if requested before registration). `member`
    // AND `member2` both get 'rn' (routine_visit's accepted disciplines are rn/lpn) since `reassignVisit`
    // targets member2. ORG_A's unassigned-pool policy is opened rather than seeding a real caseload row
    // for the fixture's non-existent `PATIENT` constant (no `patient` row backs that id in this file).
    // GAP-093 — the gate also checks a real, active membership_credential row now (not just the role);
    // the CredentialReader seam must be registered before ANY gate check runs, same reason as CaseloadProvider.
    registerPatientSeams({
      db: handle.db,
      caseload: { store: createDrizzleCaseloadStore(handle.db) },
    });
    registerSchedulingSeams({ credentials: { store: createDrizzleCredentialStore(handle.db) } });
    const rnRoleId = (
      await admin.query(
        `INSERT INTO role (organization_id, key, name, category) VALUES ($1,'rn','Registered Nurse','clinical_staff') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    for (const membershipId of [seeded[ORG_A].member, seeded[ORG_A].member2]) {
      await admin.query(
        `INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)`,
        [ORG_A, membershipId, rnRoleId],
      );
      await admin.query(
        `INSERT INTO membership_credential (organization_id, membership_id, credential_type, effective_at, granted_by_membership_id)
         VALUES ($1,$2,'rn','2020-01-01',$2)`,
        [ORG_A, membershipId],
      );
    }
    await admin.query(
      `UPDATE organization SET settings = settings || '{"allow_unassigned_pool_assignment": true}'::jsonb WHERE id=$1`,
      [ORG_A],
    );
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

  it("startVisit (self-attest path, GAP-050) advances published→en_route and documents the missing EVV", async () => {
    const { member } = seeded[ORG_A];
    const v = await newVisit(ORG_A, member);
    const reason = "Cell signal failure at the patient home; patient signed the tablet at start.";
    const started = await svc.startVisit(ORG_A, member, v.id, reason, true);
    expect(started.status).toBe("en_route");
    expect(await eventsFor(v.id)).toContain("m17.visit.started");
    const { rows } = await admin.query(
      "SELECT evv_bracket_state, evv_missing_reason FROM visit WHERE id=$1",
      [v.id],
    );
    expect(rows[0].evv_bracket_state).toBe("evv_missing_documented");
    expect(rows[0].evv_missing_reason).toBe(reason);
  });

  it("startVisit / arriveVisit refuse a membership that is not the assigned clinician (GAP-050)", async () => {
    const { member } = seeded[ORG_A];
    const v = await newVisit(ORG_A, member);
    const reason = "Cell signal failure at the patient home; patient signed the tablet at start.";
    const other = "99999999-9999-4999-8999-999999999999";
    await expect(svc.startVisit(ORG_A, other, v.id, reason, true)).rejects.toThrow(
      /ASSIGNED_CLINICIAN_REQUIRED/,
    );
    await expect(svc.arriveVisit(ORG_A, other, v.id, reason, true)).rejects.toThrow(
      /ASSIGNED_CLINICIAN_REQUIRED/,
    );
    expect(await visitStatus(v.id)).toBe("published");
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
      timeOfDayStart: "10:00",
      timeOfDayEnd: "11:00",
      timeZone: "America/Los_Angeles",
      startDate: "2026-07-01",
    });
    expect(rec.status).toBe("active");
    // GAP-026 — the policy the client sent round-trips; nothing is defaulted to 09:00-10:00 UTC.
    const stored = (
      await admin.query(
        `SELECT time_of_day_start, time_of_day_end, time_zone, start_date::text AS start_date,
                end_date, count, byday FROM recurring_visit WHERE id = $1`,
        [rec.id],
      )
    ).rows[0];
    expect(stored).toMatchObject({
      time_of_day_start: "10:00",
      time_of_day_end: "11:00",
      time_zone: "America/Los_Angeles",
      start_date: "2026-07-01",
      end_date: null,
      count: null,
    });
    await expect(
      svc.createRecurring(ORG_A, member, {
        patientId: PATIENT,
        admissionId: ADMISSION,
        assignedMembershipId: member,
        visitPurpose: "routine_visit",
        visitSetting: "patient_home",
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        timeOfDayStart: "10:00",
        timeOfDayEnd: "11:00",
        timeZone: "America/Los_Angeles",
        startDate: "2026-07-01",
        endDate: "2026-12-01",
        count: 4,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const disc = await svc.discontinueRecurring(ORG_A, member, rec.id);
    expect(disc.status).toBe("discontinued");
    expect(await eventsFor(rec.id)).toContain("m17.recurring_visit.discontinued");
  });

  it("upsertAvailability merges per weekday; getAvailability folds the slots", async () => {
    const { member2 } = seeded[ORG_A];
    await svc.upsertAvailability(
      ORG_A,
      member2,
      member2,
      {
        timeZone: "America/Los_Angeles",
        slots: [{ weekday: 2, startTime: "08:00", endTime: "12:00" }],
      },
      NO_AUTHORITY,
    );
    // Re-upsert the same weekday (UPDATE, no duplicate) + add a new one (INSERT).
    await svc.upsertAvailability(
      ORG_A,
      member2,
      member2,
      {
        timeZone: "America/Los_Angeles",
        slots: [
          { weekday: 2, startTime: "09:00", endTime: "17:00" },
          { weekday: 4, startTime: "08:00", endTime: "12:00" },
        ],
      },
      NO_AUTHORITY,
    );
    const avail = await svc.getAvailability(ORG_A, member2);
    expect(avail?.slots).toEqual([
      { weekday: 2, startTime: "09:00", endTime: "17:00" },
      { weekday: 4, startTime: "08:00", endTime: "12:00" },
    ]);
  });

  it("time-off request→approve→deny→cancel drive the machine and emit", async () => {
    const { member, member2 } = seeded[ORG_A];
    const approver = { ...NO_AUTHORITY, timeOffApprove: true };
    // request → approve (disjoint 30d window). GAP-051: a DIFFERENT approver decides (self-approval is a 409).
    const req = await svc.requestTimeOff(
      ORG_A,
      member,
      {
        membershipId: member,
        kind: "pto",
        startsAt: new Date(Date.now() + 30 * DAY).toISOString(),
        endsAt: new Date(Date.now() + 31 * DAY).toISOString(),
      },
      NO_AUTHORITY,
    );
    expect(req.state).toBe("requested");
    expect(await eventsFor(req.id)).toContain("m17.time_off.requested");
    const appr = await svc.approveTimeOff(ORG_A, member2, req.id, approver);
    expect(appr.state).toBe("approved");
    expect(await eventsFor(req.id)).toContain("m17.time_off.approved");

    // deny a separate requested row (40d).
    const req2 = await svc.requestTimeOff(
      ORG_A,
      member,
      {
        membershipId: member,
        kind: "sick",
        startsAt: new Date(Date.now() + 40 * DAY).toISOString(),
        endsAt: new Date(Date.now() + 41 * DAY).toISOString(),
      },
      NO_AUTHORITY,
    );
    const den = await svc.denyTimeOff(
      ORG_A,
      member2,
      req2.id,
      "coverage cannot be arranged for that week",
      approver,
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
    // GAP-051: another clinician cannot cancel it; the owner can.
    await expect(svc.cancelTimeOff(ORG_A, member2, appId, NO_AUTHORITY)).rejects.toMatchObject({
      statusCode: 403,
    });
    const cancelled = await svc.cancelTimeOff(ORG_A, member, appId, NO_AUTHORITY);
    expect(cancelled.state).toBe("cancelled");
  });

  it("GAP-051: cross-membership availability edit is 403 and self-approval is 409 on the DB service", async () => {
    const { member, member2 } = seeded[ORG_A];
    await expect(
      svc.upsertAvailability(
        ORG_A,
        member2,
        member,
        { timeZone: "UTC", slots: [{ weekday: 3, startTime: "08:00", endTime: "12:00" }] },
        NO_AUTHORITY,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const own = await svc.requestTimeOff(
      ORG_A,
      member,
      {
        membershipId: member,
        kind: "pto",
        startsAt: new Date(Date.now() + 60 * DAY).toISOString(),
        endsAt: new Date(Date.now() + 61 * DAY).toISOString(),
      },
      NO_AUTHORITY,
    );
    await expect(
      svc.approveTimeOff(ORG_A, member, own.id, { ...NO_AUTHORITY, timeOffApprove: true }),
    ).rejects.toMatchObject({ statusCode: 409 });
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

  // ── GAP-031 — the SERVICE-layer D8 gate (reassign/edit/reschedule/publish) now threads discipline +
  // caseload/pool into `preScheduleGatePassed`, not just `not_on_pto` — proves the write is actually
  // BLOCKED end-to-end (not just that the resolver methods return the right booleans in isolation, which
  // the GAP-030 describe block below already covers for the route-layer predicates).
  describe("GAP-031 — preScheduleGatePassed resolves discipline + caseload/pool for real", () => {
    let wrongDisciplineMember: string;

    beforeAll(async () => {
      // A membership whose only role ('chaplain') is NOT in routine_visit's accepted set (rn/lpn).
      const suffix = `${Date.now()}-wrongdisc`;
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `m17w-${suffix}@x.test`,
        ])
      ).rows[0].id as string;
      wrongDisciplineMember = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status, default_provider_entity_id, default_location_ids)
           VALUES ($1,$2,'active',$3,$4::jsonb) RETURNING id`,
          [user, ORG_A, seeded[ORG_A].pe, JSON.stringify([seeded[ORG_A].location])],
        )
      ).rows[0].id as string;
      const chaplainRoleId = (
        await admin.query(
          `INSERT INTO role (organization_id, key, name, category) VALUES ($1,'chaplain','Chaplain','clinical_staff') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)`,
        [ORG_A, wrongDisciplineMember, chaplainRoleId],
      );
    });

    it("reassignVisit is rejected when the target's discipline doesn't match the visit purpose", async () => {
      const { member } = seeded[ORG_A];
      const v = await newVisit(ORG_A, member);
      await expect(
        svc.reassignVisit(ORG_A, member, v.id, wrongDisciplineMember),
      ).rejects.toMatchObject({ message: "PRE_SCHEDULE_GATE_FAILED", statusCode: 403 });
      // The assignment must NOT have changed.
      const { rows } = await admin.query("SELECT assigned_membership_id FROM visit WHERE id=$1", [
        v.id,
      ]);
      expect(rows[0].assigned_membership_id).toBe(member);
    });

    it("editVisit reassignment is rejected on the same discipline mismatch", async () => {
      const { member } = seeded[ORG_A];
      const v = await newVisit(ORG_A, member);
      await expect(
        svc.editVisit(ORG_A, member, v.id, { assignedMembershipId: wrongDisciplineMember }),
      ).rejects.toMatchObject({ message: "PRE_SCHEDULE_GATE_FAILED", statusCode: 403 });
    });

    it("reassignVisit is rejected when the target is outside caseload and the pool is closed", async () => {
      const { member, member2 } = seeded[ORG_A];
      const v = await newVisit(ORG_A, member);
      await admin.query(
        `UPDATE organization SET settings = settings - 'allow_unassigned_pool_assignment' WHERE id=$1`,
        [ORG_A],
      );
      try {
        // member2 has the right discipline (rn) but no caseload row for PATIENT, and the pool is now closed.
        await expect(svc.reassignVisit(ORG_A, member, v.id, member2)).rejects.toMatchObject({
          message: "PRE_SCHEDULE_GATE_FAILED",
          statusCode: 403,
        });
      } finally {
        // Every other test in this file (including the ones above) relies on the pool staying open.
        await admin.query(
          `UPDATE organization SET settings = settings || '{"allow_unassigned_pool_assignment": true}'::jsonb WHERE id=$1`,
          [ORG_A],
        );
      }
    });
  });

  // ── GAP-030 — the §4.7 SchedulingAbacResolver methods, live over real Postgres ────────────────────────
  describe("GAP-030 — SchedulingAbacResolver over real data", () => {
    const resolver = () => svc as unknown as SchedulingAbacResolver;

    it("resolveDisciplines resolves a real, unexpired role grant's key", async () => {
      // The top-level beforeAll already links `member` to the shared ORG_A 'rn' role (GAP-031's
      // fixture requirement — the service-layer gate needs a real qualifying discipline now too).
      const { member } = seeded[ORG_A];
      await expect(resolver().resolveDisciplines(ORG_A, member)).resolves.toEqual(["rn"]);
    });

    it("resolveDisciplines returns [] for a membership with no qualifying role grant (fail-closed)", async () => {
      const suffix = `${Date.now()}-norole`;
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `m17w-${suffix}@x.test`,
        ])
      ).rows[0].id as string;
      const membership = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status, default_provider_entity_id, default_location_ids)
           VALUES ($1,$2,'active',$3,$4::jsonb) RETURNING id`,
          [user, ORG_A, seeded[ORG_A].pe, JSON.stringify([seeded[ORG_A].location])],
        )
      ).rows[0].id as string;
      await expect(resolver().resolveDisciplines(ORG_A, membership)).resolves.toEqual([]);
    });

    // Code review 2026-08-14 — this used to be `roleRows.find(...)` over an UNORDERED query, so which
    // discipline a multi-discipline membership resolved to (and therefore whether the D8 gate passed, and
    // which credential kind was looked for) depended on Postgres row order.
    it("resolveDisciplines returns EVERY held discipline, deterministically ordered", async () => {
      const suffix = `${Date.now()}-multi`;
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `m17w-${suffix}@x.test`,
        ])
      ).rows[0].id as string;
      const membership = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status, default_provider_entity_id, default_location_ids)
           VALUES ($1,$2,'active',$3,$4::jsonb) RETURNING id`,
          [user, ORG_A, seeded[ORG_A].pe, JSON.stringify([seeded[ORG_A].location])],
        )
      ).rows[0].id as string;
      // Insert `rn` LAST so a naive `find()` over insertion order would answer "msw".
      for (const key of ["msw", "rn"]) {
        // ORG_A already carries an 'rn' role from the top-level seed — reuse it rather than colliding on
        // the (organization_id, key) unique index.
        const roleId = (
          await admin.query(
            `INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,'clinical_staff')
             ON CONFLICT (organization_id, key) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
            [ORG_A, key],
          )
        ).rows[0].id as string;
        await admin.query(
          `INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)`,
          [ORG_A, membership, roleId],
        );
      }
      await expect(resolver().resolveDisciplines(ORG_A, membership)).resolves.toEqual([
        "msw",
        "rn",
      ]);
    });

    it("resolveDisciplines ignores an EXPIRED role grant (fail-closed)", async () => {
      const suffix = `${Date.now()}`;
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `m17w-exp-${suffix}@x.test`,
        ])
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
      await expect(resolver().resolveDisciplines(ORG_A, membership)).resolves.toEqual([]);
    });

    it("isInCaseload resolves a real open patient_assignment via the real M5 CaseloadProvider seam", async () => {
      // CaseloadProvider is already registered in the top-level beforeAll (GAP-031 needs it live before
      // the very first gate check runs), so no need to re-register here.
      const { member } = seeded[ORG_A];
      const [memRow] = (await admin.query(`SELECT user_id FROM membership WHERE id=$1`, [member]))
        .rows as Array<{ user_id: string }>;
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

    it("allowsUnassignedPool reads the real allow_unassigned_pool_assignment org setting (default false when unset)", async () => {
      // The top-level beforeAll already opened ORG_A's pool (GAP-031's fixture requirement — `newVisit`'s
      // constant PATIENT isn't backed by a real caseload row) — clear it first to prove the unset default.
      await admin.query(
        `UPDATE organization SET settings = settings - 'allow_unassigned_pool_assignment' WHERE id=$1`,
        [ORG_A],
      );
      await expect(resolver().allowsUnassignedPool(ORG_A)).resolves.toBe(false);
      await admin.query(
        `UPDATE organization SET settings = settings || '{"allow_unassigned_pool_assignment": true}'::jsonb WHERE id=$1`,
        [ORG_A],
      );
      await expect(resolver().allowsUnassignedPool(ORG_A)).resolves.toBe(true);
      // Restore the fixture baseline (true) — this is the last test in the file, but keep state honest.
    });
  });
});
