/**
 * M14L — the Drizzle IDG write lifecycle, proven against real Postgres.
 *
 * Drives the writes as the NOBYPASSRLS `wardenx_app` role. Like M12/M13, M14 has NO state-transition triggers,
 * so the service does every transition itself (composing the pure `@wardenx/idg` machines): recurring-policy
 * create/update · the meeting machine (buildPackets · start · adjourn with the step-up gate + the
 * `idg.decision_recorded` ADJOURN burst · cancel · reschedule) · attendance record/update/remove · agenda
 * add/remove · decision record/supersede (+ the MEETING_NOT_LIVE / INCLUSION_CRITERIA_FAILED guards) · action
 * item create/update/remove · minutes amendment. Like the M7–M13 write suites it binds the REAL catalog-
 * validating transactional publisher (buildBootOutboxCatalog([M14_OUTBOX_EVENTS]) → the caller's tx) and
 * asserts the `m14.*` / `idg.decision_recorded` rows land in `outbox_event`. RLS is exercised end-to-end.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m14:write:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type IdgWriteOutboxPort,
  createDbIdgBackend,
} from "../src/modules/14-idg/idg-route-service-db";
import { M14_OUTBOX_EVENTS } from "../src/modules/14-idg/index";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const MEMBER = "33333333-3333-3333-3333-33333333aaaa"; // idg tables carry no membership FK — literal is fine
const PATIENT = "44444444-4444-4444-4444-444444444444";

describe.skipIf(!DB_URL)("M14 IDG write lifecycle — LIVE Postgres (M14L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbIdgBackend>;
  const locationOf: Record<string, string> = {};

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
  async function meetingStatus(id: string): Promise<string> {
    const { rows } = await admin.query("SELECT status FROM idg_meeting WHERE id=$1", [id]);
    return rows[0]?.status as string;
  }
  /** Seed a meeting at a chosen lifecycle status (the in-mem "seed status to drive lifecycle" pattern). */
  async function seedMeeting(org: string, status: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO idg_meeting (organization_id, location_id, scheduled_start, scheduled_end, status,
           coordinator_membership_id, tenant_quorum_snapshot)
         VALUES ($1,$2, now(), now() + interval '2 hours', $3, $4, '{}'::jsonb) RETURNING id`,
        [org, locationOf[org], status, MEMBER],
      )
    ).rows[0].id as string;
  }
  async function seedInProgressMinutes(org: string, meetingId: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO idg_minutes (organization_id, idg_meeting_id, status) VALUES ($1,$2,'in_progress') RETURNING id`,
        [org, meetingId],
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m14w@x.test')`, [USER]);
    for (const org of [ORG_A, ORG_B]) {
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [
            org,
            `CCN-M14W-${org.slice(0, 4)}`,
            `M14W ${org.slice(0, 4)}`,
            `NPI-M14W-${org.slice(0, 4)}`,
          ],
        )
      ).rows[0].id as string;
      locationOf[org] = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
    }
    await admin.query("ALTER ROLE wardenx_app LOGIN");
    handle = createDbClient({
      connectionString: (DB_URL as string).replace("://postgres@", "://wardenx_app@"),
    });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M14_OUTBOX_EVENTS]));
    const outbox: IdgWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m14" }),
    };
    svc = createDbIdgBackend(handle.db, outbox);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("recurring policy create/update persists + emits schedule.materialised", async () => {
    const created = await svc.createRecurringPolicy(ORG_A, MEMBER, {
      locationId: locationOf[ORG_A],
      cadenceDays: 14,
    });
    expect(created.cadenceDays).toBe(14);
    expect(await eventsFor(created.id)).toContain("m14.schedule.materialised");
    const updated = await svc.updateRecurringPolicy(ORG_A, MEMBER, created.id, {
      locationId: locationOf[ORG_A],
      cadenceDays: 7,
      active: false,
    });
    expect(updated.cadenceDays).toBe(7);
    expect(updated.active).toBe(false);
  });

  it("buildPackets (scheduled→packets_building) and startMeeting (packets_ready→live) drive the machine", async () => {
    const m1 = await seedMeeting(ORG_A, "scheduled");
    const built = await svc.buildPackets(ORG_A, MEMBER, m1);
    expect(built.status).toBe("packets_building");
    expect(await eventsFor(m1)).toContain("m14.packets.build_started");

    const m2 = await seedMeeting(ORG_A, "packets_ready");
    const live = await svc.startMeeting(ORG_A, MEMBER, m2);
    expect(live.status).toBe("live");
    expect(await eventsFor(m2)).toContain("m14.meeting.started");
  });

  it("attendance record/update/remove (remove soft-excuses; no DELETE grant)", async () => {
    const m = await seedMeeting(ORG_A, "live");
    const att = await svc.recordAttendance(ORG_A, MEMBER, m, {
      membershipId: MEMBER,
      discipline: "rn",
    });
    expect(att.status).toBe("present");
    expect(await eventsFor(m)).toContain("m14.attendance.checked_in");
    const upd = await svc.updateAttendance(ORG_A, MEMBER, att.id, "tardy");
    expect(upd.status).toBe("tardy");
    const removed = await svc.removeAttendance(ORG_A, MEMBER, att.id);
    expect(removed.removed).toBe(true);
    const { rows } = await admin.query("SELECT status FROM idg_attendance WHERE id=$1", [att.id]);
    expect(rows[0].status).toBe("excused");
  });

  it("agenda add/remove", async () => {
    const m = await seedMeeting(ORG_A, "live");
    const agenda = await svc.addAgendaItem(ORG_A, MEMBER, m, {
      kind: "patient_review",
      patientId: PATIENT,
    });
    expect(agenda.kind).toBe("patient_review");
    expect(agenda.patientId).toBe(PATIENT);
    const removed = await svc.removeAgendaItem(ORG_A, MEMBER, agenda.id);
    expect(removed.removed).toBe(true);
  });

  it("record decisions + ADJOURN bursts idg.decision_recorded (team_note excluded); minutes finalize", async () => {
    const m = await seedMeeting(ORG_A, "live");
    await svc.recordAttendance(ORG_A, MEMBER, m, { membershipId: MEMBER, discipline: "rn" });
    await svc.addAgendaItem(ORG_A, MEMBER, m, { kind: "patient_review", patientId: PATIENT });
    const actionable = await svc.recordDecision(ORG_A, MEMBER, m, {
      patientId: PATIENT,
      decisionKind: "care_plan_update",
    });
    expect(actionable.status).toBe("open");
    expect(await eventsFor(actionable.id)).toContain("m14.decision.recorded_open");
    // A patient-less team note is recorded but carries no recorded_open event (strict payload needs a patient).
    const note = await svc.recordDecision(ORG_A, MEMBER, m, {
      patientId: null,
      decisionKind: "team_note",
    });
    expect(await eventsFor(note.id)).not.toContain("m14.decision.recorded_open");

    const adjourned = await svc.adjournMeeting(ORG_A, MEMBER, m, true);
    expect(adjourned.status).toBe("adjourned");
    // Exactly the actionable, patient-scoped decision emits the cross-module seam; the team_note does not.
    expect(await eventsFor(actionable.id)).toContain("idg.decision_recorded");
    expect(await eventsFor(note.id)).not.toContain("idg.decision_recorded");
    expect(await eventsFor(m)).toContain("m14.meeting.adjourned");
    const minutes = await svc.getMinutes(ORG_A, m);
    expect(minutes.status).toBe("final");
    expect(await eventsFor(minutes.id)).toContain("m14.minutes.signed");

    // supersede: the now-`emitted` decision may be superseded (new open row; prior → superseded).
    const superseded = await svc.supersedeDecision(ORG_A, MEMBER, actionable.id);
    expect(superseded.status).toBe("superseded");
    expect(superseded.supersededByDecisionId).not.toBeNull();

    // amendment: the final minutes accept an amendment; emits minutes.amended.
    const amd = await svc.submitAmendment(
      ORG_A,
      MEMBER,
      minutes.id,
      "corrected the attendance record",
    );
    expect(amd.minutesId).toBe(minutes.id);
    expect(await eventsFor(minutes.id)).toContain("m14.minutes.amended");
  });

  it("adjourn without a fresh step-up → STEP_UP_REQUIRED (412)", async () => {
    const m = await seedMeeting(ORG_A, "live");
    await expect(svc.adjournMeeting(ORG_A, MEMBER, m, false)).rejects.toMatchObject({
      code: "STEP_UP_REQUIRED",
    });
  });

  it("recordDecision guards: MEETING_NOT_LIVE (scheduled) + INCLUSION_CRITERIA_FAILED (patient off caseload)", async () => {
    const scheduled = await seedMeeting(ORG_A, "scheduled");
    await expect(
      svc.recordDecision(ORG_A, MEMBER, scheduled, {
        patientId: PATIENT,
        decisionKind: "order_request",
      }),
    ).rejects.toMatchObject({ code: "MEETING_NOT_LIVE" });

    const live = await seedMeeting(ORG_A, "live");
    await expect(
      svc.recordDecision(ORG_A, MEMBER, live, {
        patientId: PATIENT,
        decisionKind: "order_request",
      }),
    ).rejects.toMatchObject({ code: "INCLUSION_CRITERIA_FAILED" });
  });

  it("amendment before the minutes are final → MINUTES_NOT_IN_PROGRESS (409)", async () => {
    const m = await seedMeeting(ORG_A, "live");
    const min = await seedInProgressMinutes(ORG_A, m);
    await expect(svc.submitAmendment(ORG_A, MEMBER, min, "too early")).rejects.toMatchObject({
      code: "MINUTES_NOT_IN_PROGRESS",
    });
  });

  it("action item create/update/remove + worklist", async () => {
    const m = await seedMeeting(ORG_A, "live");
    const item = await svc.createActionItem(ORG_A, MEMBER, m, {
      patientId: PATIENT,
      assignedToMembershipId: MEMBER,
      dueDate: new Date().toISOString(),
    });
    expect(item.status).toBe("open");
    expect(await eventsFor(item.id)).toContain("m14.action_item.created");
    const started = await svc.updateActionItem(ORG_A, MEMBER, item.id, "in_progress");
    expect(started.status).toBe("in_progress");
    expect(await eventsFor(item.id)).toContain("m14.action_item.status_changed");
    const worklist = await svc.listActionItems(ORG_A, MEMBER, { assignee: "me" });
    expect(worklist.some((i) => i.id === item.id)).toBe(true);
    const removed = await svc.removeActionItem(ORG_A, MEMBER, item.id);
    expect(removed.removed).toBe(true);
    const { rows } = await admin.query("SELECT status FROM idg_action_item WHERE id=$1", [item.id]);
    expect(rows[0].status).toBe("cancelled");
  });

  it("cancel + reschedule drive the terminal transitions and emit", async () => {
    const c = await seedMeeting(ORG_A, "scheduled");
    const cancelled = await svc.cancelMeeting(ORG_A, MEMBER, c, "location closed");
    expect(cancelled.status).toBe("cancelled");
    expect(await eventsFor(c)).toContain("m14.meeting.cancelled");

    const r = await seedMeeting(ORG_A, "scheduled");
    const rescheduled = await svc.rescheduleMeeting(ORG_A, MEMBER, r, {
      reason: "quorum unavailable",
      newScheduledStart: new Date(Date.now() + 86400000).toISOString(),
      newScheduledEnd: new Date(Date.now() + 90000000).toISOString(),
    });
    expect(rescheduled.status).toBe("rescheduled");
    expect(await eventsFor(r)).toContain("m14.meeting.rescheduled");
    expect(await meetingStatus(r)).toBe("rescheduled");
  });

  it("RLS: org B cannot start or read org A's meeting (404 under the wardenx_app policy)", async () => {
    const m = await seedMeeting(ORG_A, "packets_ready");
    await expect(svc.getMeeting(ORG_B, m)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.startMeeting(ORG_B, MEMBER, m)).rejects.toMatchObject({ statusCode: 404 });
  });
});
