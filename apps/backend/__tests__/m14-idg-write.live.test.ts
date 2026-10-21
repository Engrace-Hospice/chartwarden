/**
 * M14L — the Drizzle IDG write lifecycle, proven against real Postgres.
 *
 * Drives the writes as the NOBYPASSRLS `wardenx_app` role. Like M12/M13, M14 has NO state-transition triggers,
 * so the service does every transition itself (composing the pure `@chartwarden/idg` machines): recurring-policy
 * create/update · the meeting machine (buildPackets · start · adjourn with the step-up gate + the
 * `idg.decision_recorded` ADJOURN burst · cancel · reschedule) · attendance record/update/remove · agenda
 * add/remove · decision record/supersede (+ the MEETING_NOT_LIVE / INCLUSION_CRITERIA_FAILED guards) · action
 * item create/update/remove · minutes amendment. Like the M7–M13 write suites it binds the REAL catalog-
 * validating transactional publisher (buildBootOutboxCatalog([M14_OUTBOX_EVENTS]) → the caller's tx) and
 * asserts the `m14.*` / `idg.decision_recorded` rows land in `outbox_event`. RLS is exercised end-to-end.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m14:write:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { siteDisplayForOrg } from "../src/bootstrap/site-display-for-org";
import { membershipRoleKeysForOrg } from "../src/modules/03-authorization/membership-role-keys-for-org";
import {
  type IdgWriteOutboxPort,
  createDbIdgBackend,
} from "../src/modules/14-idg/idg-route-service-db";
import {
  M14_OUTBOX_EVENTS,
  buildM14WorkerDeps,
  runReviewClockSweepCron,
} from "../src/modules/14-idg/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const MEMBER = "33333333-3333-3333-3333-33333333aaaa"; // idg tables carry no membership FK — literal is fine
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555"; // idg_patient_packet's admission_id is app-validated (no FK)

describe.skipIf(!DB_URL)("M14 IDG write lifecycle — LIVE Postgres (M14L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbIdgBackend>;
  let outbox: IdgWriteOutboxPort;
  const locationOf: Record<string, string> = {};
  const peOf: Record<string, string> = {};

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
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
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
  async function seedMeeting(org: string, status: string, startOffset = "0 days"): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO idg_meeting (organization_id, location_id, scheduled_start, scheduled_end, status,
           coordinator_membership_id, tenant_quorum_snapshot)
         VALUES ($1,$2, now() + $5::interval, now() + $5::interval + interval '2 hours', $3, $4, '{}'::jsonb)
         RETURNING id`,
        [org, locationOf[org], status, MEMBER, startOffset],
      )
    ).rows[0].id as string;
  }
  /** Seed a user + a membership of the given status in `org`; returns the membership id. */
  async function seedMembership(org: string, status: string): Promise<string> {
    const userId = randomUUID();
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [
      userId,
      `m14-${userId}@x.test`,
    ]);
    return (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,$3) RETURNING id`,
        [userId, org, status],
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
  /** GAP-020 — seed a packet with a chosen `since_cursor_iso` (the "last review or admission activation"
   * cursor the §2.4 packet worker resolves); the review-floor breach math floors it at cursor + 15 days. */
  async function seedPacket(
    org: string,
    meetingId: string,
    patientId: string,
    sinceCursorIso: string,
    admissionId: string = ADMISSION,
  ): Promise<void> {
    await admin.query(
      `INSERT INTO idg_patient_packet
         (organization_id, provider_entity_id, location_id, idg_meeting_id, patient_id, admission_id,
          since_cursor_iso, built_snapshot, discipline_views, cover_summary_layer1)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,'{}'::jsonb,'seed')`,
      [org, peOf[org], locationOf[org], meetingId, patientId, admissionId, sinceCursorIso],
    );
  }
  /** The M6 `idgActiveAdmissionsForOrg` seam's shape, for the review-clock sweep (the real seam is proven in
   * m14-review-clock-sweep.live.test.ts) — one ACTIVE admission at ORG_A's location, activated `days` ago. */
  const activeAdmissionsStub = (
    admissionId: string,
    patientId: string,
    activatedDaysAgo: number,
  ) => ({
    activeAdmissionsForOrg: async () => [
      {
        admissionId,
        patientId,
        locationId: locationOf[ORG_A],
        activatedAtIso: new Date(Date.now() - activatedDaysAgo * 86400000).toISOString(),
      },
    ],
  });
  async function packetReviewedAt(meetingId: string, patientId: string): Promise<string | null> {
    const { rows } = await admin.query(
      "SELECT last_idg_reviewed_at FROM idg_patient_packet WHERE idg_meeting_id=$1 AND patient_id=$2",
      [meetingId, patientId],
    );
    return rows[0]?.last_idg_reviewed_at
      ? new Date(rows[0].last_idg_reviewed_at).toISOString()
      : null;
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
      peOf[org] = pe;
      locationOf[org] = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M14_OUTBOX_EVENTS]));
    outbox = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m14" }),
    };
    svc = createDbIdgBackend(
      handle.db,
      outbox,
      {
        // Deterministic stand-in for M2's batched name-only display seam (the addenda appendix's `authorName`).
        displayForMemberships: async (_org, ids) =>
          new Map(ids.map((i) => [i, { displayName: `Name-${i.slice(0, 8)}` }])),
      },
      // The REAL M1 site-display seam over the real wardenx_app connection (org + location NAMES for the PDF header).
      { displayForSite: (o, ids) => siteDisplayForOrg(handle.db, o, ids) },
    );
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

  it("two concurrent starts produce one transition and one started event", async () => {
    const m = await seedMeeting(ORG_A, "packets_ready");
    const settled = await Promise.allSettled([
      svc.startMeeting(ORG_A, MEMBER, m),
      svc.startMeeting(ORG_A, MEMBER, m),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      settled.find((result): result is PromiseRejectedResult => result.status === "rejected")
        ?.reason,
    ).toMatchObject({ code: "ILLEGAL_MEETING_TRANSITION" });
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM outbox_event WHERE aggregate_id=$1 AND event_type='m14.meeting.started'",
      [m],
    );
    expect(rows[0].n).toBe(1);
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
    // GAP-086 — `payload` is REQUIRED (`idg_decision.payload` is NOT NULL and the route contract carries a
    // kind-bearing union). Omitting it, as this suite did, made Drizzle fall through to the column default
    // and the insert die on a 23502 — the whole reason this case failed the moment it ran anywhere.
    const actionable = await svc.recordDecision(ORG_A, MEMBER, m, {
      patientId: PATIENT,
      decisionKind: "care_plan_update",
      payload: {
        kind: "care_plan_update",
        mutations: [
          {
            op: "problem_add",
            icd10Code: null,
            snomedCode: null,
            description: "Increased dyspnea at rest",
            problemKind: "terminal",
          },
        ],
      },
    });
    expect(actionable.status).toBe("open");
    expect(await eventsFor(actionable.id)).toContain("m14.decision.recorded_open");
    // The M36 non-quorate notice's inputs ride the event only when the decision was recorded without quorum
    // (no attendance is seeded for `m`, so this one was): the meeting's coordinator + the unmet quorum slots.
    {
      const { rows: ro } = await admin.query(
        "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m14.decision.recorded_open'",
        [actionable.id],
      );
      expect(ro[0].payload).toMatchObject({ wasQuorate: false, coordinatorMembershipId: MEMBER });
      expect(Array.isArray(ro[0].payload.missingDisciplines)).toBe(true);
      expect(ro[0].payload.missingDisciplines.length).toBeGreaterThan(0);
    }
    // A patient-less team note is recorded but carries no recorded_open event (strict payload needs a patient).
    const note = await svc.recordDecision(ORG_A, MEMBER, m, {
      patientId: null,
      decisionKind: "team_note",
      payload: {
        kind: "team_note",
        noteText: "Team reviewed the caseload; no patient-scoped action.",
      },
    });
    expect(await eventsFor(note.id)).not.toContain("m14.decision.recorded_open");

    // Optimistic concurrency: a fresh decision is version 0; an edit carrying it bumps the row to 1, and a
    // second editor still holding 0 loses with 412 STALE_VERSION (the compare-and-set UPDATE, not just the read).
    expect(note.version).toBe(0);
    const edited = await svc.updateDecision(
      ORG_A,
      MEMBER,
      note.id,
      { kind: "team_note", noteText: "Team reviewed the caseload (edited)." },
      0,
    );
    expect(edited.version).toBe(1);
    await expect(
      svc.updateDecision(
        ORG_A,
        MEMBER,
        note.id,
        { kind: "team_note", noteText: "stale overwrite" },
        0,
      ),
    ).rejects.toMatchObject({ statusCode: 412, code: "STALE_VERSION" });
    expect(
      (await admin.query("SELECT version FROM idg_decision WHERE id=$1", [note.id])).rows[0]
        .version,
    ).toBe(1);

    const adjourned = await svc.adjournMeeting(ORG_A, MEMBER, m, true);
    expect(adjourned.status).toBe("adjourned");
    // Exactly the actionable, patient-scoped decision emits the cross-module seam; the team_note does not.
    expect(await eventsFor(actionable.id)).toContain("idg.decision_recorded");
    expect(await eventsFor(note.id)).not.toContain("idg.decision_recorded");
    expect(await eventsFor(m)).toContain("m14.meeting.adjourned");
    const minutes = await svc.getMinutes(ORG_A, m);
    expect(minutes.status).toBe("final");
    expect(await eventsFor(minutes.id)).toContain("m14.minutes.signed");
    // F-062 — adjournment FREEZES the minutes. It used to stamp status/finalized_at/finalized_by and
    // leave `attendance_snapshot`, `decision_list_snapshot` and `action_item_list_snapshot` NULL on
    // every meeting ever adjourned, so the finalized §418.56(d) record said a review happened and
    // nothing about what it reviewed. One attendee, two decisions (the care-plan update AND the team
    // note — a snapshot of what the meeting DID includes the note), no action items.
    expect(minutes.finalizedAt).not.toBeNull();
    expect(minutes.finalizedByMembershipId).toBe(MEMBER);
    expect(minutes.attendanceCount).toBe(1);
    expect(minutes.decisionCount).toBe(2);
    expect(minutes.actionItemCount).toBe(0);

    // GAP-043 — an emitted decision is immutable: PATCH is refused 409 and the row is untouched.
    await expect(
      svc.updateDecision(
        ORG_A,
        MEMBER,
        actionable.id,
        {
          kind: "team_note",
          noteText: "rewrite after adjournment",
        },
        0,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "DECISION_NOT_OPEN" });
    expect(
      (await admin.query("SELECT decision_kind FROM idg_decision WHERE id=$1", [actionable.id]))
        .rows[0].decision_kind,
    ).toBe("care_plan_update");

    // GAP-043 — supersede needs a LATER, LIVE, QUORATE meeting; the quorum is computed from ITS attendance.
    const later = await seedMeeting(ORG_A, "live", "7 days");
    await svc.addAgendaItem(ORG_A, MEMBER, later, { kind: "patient_review", patientId: PATIENT });
    await expect(
      svc.supersedeDecision(ORG_A, MEMBER, actionable.id, { meetingId: later }),
    ).rejects.toMatchObject({ statusCode: 422, code: "QUORUM_NOT_MET" }); // no attendance yet
    for (const discipline of ["hospice_physician", "rn_case_manager", "msw", "chaplain"]) {
      await svc.recordAttendance(ORG_A, MEMBER, later, {
        membershipId: await seedMembership(ORG_A, "active"),
        discipline,
      });
    }
    const superseded = await svc.supersedeDecision(ORG_A, MEMBER, actionable.id, {
      meetingId: later,
    });
    expect(superseded.status).toBe("superseded");
    expect(superseded.supersededByDecisionId).not.toBeNull();
    const successor = (
      await admin.query(
        "SELECT idg_meeting_id, was_quorate, status FROM idg_decision WHERE id=$1",
        [superseded.supersededByDecisionId],
      )
    ).rows[0];
    expect(successor).toMatchObject({ idg_meeting_id: later, was_quorate: true, status: "open" });
    await expect(
      svc.updateDecision(
        ORG_A,
        MEMBER,
        actionable.id,
        {
          kind: "team_note",
          noteText: "rewrite superseded",
        },
        0,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "DECISION_SUPERSEDED" });

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

  it("attendance / agenda / decisions read back the rows their writes create (F-062)", async () => {
    // Six write routes filed rows into three tables that NO route in the module returned: the roster
    // the `quorate_decision` predicate evaluates, the meeting's running order, and the decision ledger
    // an adjournment commits. The patient-scoped history tab was the only decision reader anywhere, and
    // it answers a different question ("what was decided about this patient", across meetings).
    const m = await seedMeeting(ORG_A, "live");
    await svc.recordAttendance(ORG_A, MEMBER, m, { membershipId: MEMBER, discipline: "rn" });
    const agendaItem = await svc.addAgendaItem(ORG_A, MEMBER, m, {
      kind: "patient_review",
      patientId: PATIENT,
    });
    const decision = await svc.recordDecision(ORG_A, MEMBER, m, {
      patientId: PATIENT,
      agendaItemId: agendaItem.id,
      decisionKind: "team_note",
      payload: { kind: "team_note", noteText: "Reviewed; continue the current plan." },
    });

    const roster = await svc.listAttendance(ORG_A, m);
    expect(roster.map((a) => a.discipline)).toEqual(["rn"]);
    expect(roster[0]?.status).toBe("present");

    const agenda = await svc.listAgenda(ORG_A, m);
    expect(agenda.map((a) => a.id)).toEqual([agendaItem.id]);
    expect(agenda[0]?.patientId).toBe(PATIENT);

    const ledger = await svc.listDecisions(ORG_A, m);
    expect(ledger.map((d) => d.id)).toEqual([decision.id]);
    expect(ledger[0]?.agendaItemId).toBe(agendaItem.id);
    expect(ledger[0]?.recordedByMembershipId).toBe(MEMBER);
    // The D4 payload is the §3.3 denylisted narrative — a property of this read, not an accident.
    expect(ledger[0]).not.toHaveProperty("payload");
    expect(ledger[0]).not.toHaveProperty("quorumSnapshot");
  });

  it("the three conduct reads are tenant-scoped: org B sees org A's meeting as 404", async () => {
    const m = await seedMeeting(ORG_A, "live");
    await svc.recordAttendance(ORG_A, MEMBER, m, { membershipId: MEMBER, discipline: "rn" });
    await expect(svc.listAttendance(ORG_B, m)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(svc.listAgenda(ORG_B, m)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(svc.listDecisions(ORG_B, m)).rejects.toMatchObject({ code: "NOT_FOUND" });
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
        payload: { kind: "order_request", requestedOrders: [] },
      }),
    ).rejects.toMatchObject({ code: "MEETING_NOT_LIVE" });

    const live = await seedMeeting(ORG_A, "live");
    await expect(
      svc.recordDecision(ORG_A, MEMBER, live, {
        patientId: PATIENT,
        decisionKind: "order_request",
        payload: { kind: "order_request", requestedOrders: [] },
      }),
    ).rejects.toMatchObject({ code: "INCLUSION_CRITERIA_FAILED" });
  });

  /** A LIVE meeting with the patient on its caseload and the four quorum disciplines present. */
  async function seedQuorateLiveMeeting(startOffset: string): Promise<string> {
    const m = await seedMeeting(ORG_A, "live", startOffset);
    await svc.addAgendaItem(ORG_A, MEMBER, m, { kind: "patient_review", patientId: PATIENT });
    for (const discipline of ["hospice_physician", "rn_case_manager", "msw", "chaplain"]) {
      await svc.recordAttendance(ORG_A, MEMBER, m, {
        membershipId: await seedMembership(ORG_A, "active"),
        discipline,
      });
    }
    return m;
  }
  const OPEN_REFERRAL = {
    kind: "referral",
    referralKind: "social_services",
    referralTargetMdmId: null,
    rationaleText: "IDG requested a social-services referral.",
  } as const;
  async function openDecisionsIn(meetingId: string): Promise<number> {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM idg_decision WHERE idg_meeting_id=$1 AND status='open'",
      [meetingId],
    );
    return rows[0].n as number;
  }

  it("two concurrent supersedes of the same emitted decision: exactly one wins, the loser is 409, one successor row", async () => {
    const m = await seedQuorateLiveMeeting("0 days");
    const prior = await svc.recordDecision(ORG_A, MEMBER, m, {
      patientId: PATIENT,
      decisionKind: "referral",
      payload: OPEN_REFERRAL,
    });
    await svc.adjournMeeting(ORG_A, MEMBER, m, true);
    const t1 = await seedQuorateLiveMeeting("7 days");
    const t2 = await seedQuorateLiveMeeting("8 days");

    const settled = await Promise.allSettled([
      svc.supersedeDecision(ORG_A, MEMBER, prior.id, { meetingId: t1 }),
      svc.supersedeDecision(ORG_A, MEMBER, prior.id, { meetingId: t2 }),
    ]);

    const won = settled.filter((r) => r.status === "fulfilled");
    const lost = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ statusCode: 409, code: "DECISION_SUPERSEDED" });
    const { rows: successors } = await admin.query(
      "SELECT id, idg_meeting_id FROM idg_decision WHERE idg_meeting_id = ANY($1::uuid[])",
      [[t1, t2]],
    );
    expect(successors).toHaveLength(1);
    const priorRow = (
      await admin.query("SELECT status, superseded_by_decision_id FROM idg_decision WHERE id=$1", [
        prior.id,
      ])
    ).rows[0];
    expect(priorRow.status).toBe("superseded");
    expect(priorRow.superseded_by_decision_id).toBe(successors[0].id);
  });

  it("supersede racing an adjournment of the TARGET never leaves an open successor in an adjourned meeting", async () => {
    const m = await seedQuorateLiveMeeting("0 days");
    const prior = await svc.recordDecision(ORG_A, MEMBER, m, {
      patientId: PATIENT,
      decisionKind: "referral",
      payload: OPEN_REFERRAL,
    });
    await svc.adjournMeeting(ORG_A, MEMBER, m, true);
    const target = await seedQuorateLiveMeeting("7 days");

    const settled = await Promise.allSettled([
      svc.supersedeDecision(ORG_A, MEMBER, prior.id, { meetingId: target }),
      svc.adjournMeeting(ORG_A, MEMBER, target, true),
    ]);

    expect(settled[1]!.status).toBe("fulfilled");
    expect(await meetingStatus(target)).toBe("adjourned");
    expect(await openDecisionsIn(target)).toBe(0);
    if (settled[0]!.status === "rejected") {
      // The adjournment won the lock: the supersede was refused and wrote nothing (prior stays emitted).
      expect(settled[0].reason).toMatchObject({ statusCode: 422, code: "MEETING_NOT_LIVE" });
      expect(
        (await admin.query("SELECT status FROM idg_decision WHERE id=$1", [prior.id])).rows[0]
          .status,
      ).toBe("emitted");
    } else {
      // The supersede committed first: its successor was emitted by the adjournment, not stranded open.
      const succ = (
        await admin.query("SELECT status FROM idg_decision WHERE idg_meeting_id=$1", [target])
      ).rows;
      expect(succ.map((r) => r.status)).toEqual(["emitted"]);
    }
  });

  it("an edit racing an adjournment: no open row survives, and the emitted event carries the row's final kind", async () => {
    const m = await seedMeeting(ORG_A, "live");
    await svc.addAgendaItem(ORG_A, MEMBER, m, { kind: "patient_review", patientId: PATIENT });
    const open = await svc.recordDecision(ORG_A, MEMBER, m, {
      patientId: PATIENT,
      decisionKind: "referral",
      payload: OPEN_REFERRAL,
    });

    const settled = await Promise.allSettled([
      svc.updateDecision(
        ORG_A,
        MEMBER,
        open.id,
        { kind: "team_note", noteText: "Edited while the meeting adjourns." },
        open.version,
      ),
      svc.adjournMeeting(ORG_A, MEMBER, m, true),
    ]);

    expect(settled[1]!.status).toBe("fulfilled");
    expect(await meetingStatus(m)).toBe("adjourned");
    expect(await openDecisionsIn(m)).toBe(0);
    const row = (
      await admin.query("SELECT status, decision_kind FROM idg_decision WHERE id=$1", [open.id])
    ).rows[0];
    expect(row.status).toBe("emitted");
    if (settled[0]!.status === "rejected") {
      expect(settled[0].reason).toMatchObject({ statusCode: expect.any(Number) });
      expect(row.decision_kind).toBe("referral");
    } else {
      expect(row.decision_kind).toBe("team_note");
    }
    // Whatever the interleaving, the cross-module event must describe the row as stored (no stale payload).
    const { rows: ev } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='idg.decision_recorded'",
      [open.id],
    );
    for (const e of ev) expect(e.payload.decisionKind).toBe(row.decision_kind);
  });

  it("a decision recorded while the meeting adjourns is either emitted or refused, never stranded open", async () => {
    const m = await seedMeeting(ORG_A, "live");
    await svc.addAgendaItem(ORG_A, MEMBER, m, { kind: "patient_review", patientId: PATIENT });

    const settled = await Promise.allSettled([
      svc.recordDecision(ORG_A, MEMBER, m, {
        patientId: PATIENT,
        decisionKind: "referral",
        payload: OPEN_REFERRAL,
      }),
      svc.adjournMeeting(ORG_A, MEMBER, m, true),
    ]);

    expect(settled[1]!.status).toBe("fulfilled");
    expect(await openDecisionsIn(m)).toBe(0);
    if (settled[0]!.status === "rejected") {
      expect(settled[0].reason).toMatchObject({ code: "MEETING_NOT_LIVE" });
    }
  });

  it("two concurrent adjournments finalize and emit exactly once", async () => {
    const m = await seedMeeting(ORG_A, "live");
    const settled = await Promise.allSettled([
      svc.adjournMeeting(ORG_A, MEMBER, m, true),
      svc.adjournMeeting(ORG_A, MEMBER, m, true),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(loser?.reason).toMatchObject({ code: "ILLEGAL_MEETING_TRANSITION", statusCode: 409 });
    const { rows } = await admin.query(
      `SELECT event_type, count(*)::int AS n
         FROM outbox_event
        WHERE payload->>'meetingId' = $1
          AND event_type IN ('m14.meeting.adjourned', 'm14.minutes.signed')
        GROUP BY event_type`,
      [m],
    );
    expect(rows.find((row) => row.event_type === "m14.meeting.adjourned")?.n).toBe(1);
    expect(rows.find((row) => row.event_type === "m14.minutes.signed")?.n).toBe(1);
    expect(
      (await admin.query("SELECT count(*)::int AS n FROM idg_minutes WHERE idg_meeting_id=$1", [m]))
        .rows[0].n,
    ).toBe(1);
  });

  it("attendance racing adjournment is either frozen into minutes or refused", async () => {
    const m = await seedMeeting(ORG_A, "live");
    const settled = await Promise.allSettled([
      svc.recordAttendance(ORG_A, MEMBER, m, { membershipId: MEMBER, discipline: "rn" }),
      svc.adjournMeeting(ORG_A, MEMBER, m, true),
    ]);
    expect(settled[1]?.status).toBe("fulfilled");
    const attendance = settled[0];
    const snapshot = (
      await admin.query("SELECT attendance_snapshot FROM idg_minutes WHERE idg_meeting_id=$1", [m])
    ).rows[0].attendance_snapshot as Array<{ attendanceId: string }>;
    if (attendance?.status === "fulfilled") {
      expect(snapshot.map((row) => row.attendanceId)).toContain(attendance.value.id);
    } else {
      expect(attendance?.reason).toMatchObject({ code: "ILLEGAL_MEETING_TRANSITION" });
    }
  });

  it("action-item creation racing adjournment is either frozen into minutes or refused", async () => {
    const m = await seedMeeting(ORG_A, "live");
    const settled = await Promise.allSettled([
      svc.createActionItem(ORG_A, MEMBER, m, {
        patientId: PATIENT,
        assignedToMembershipId: MEMBER,
        dueDate: new Date().toISOString(),
      }),
      svc.adjournMeeting(ORG_A, MEMBER, m, true),
    ]);
    expect(settled[1]?.status).toBe("fulfilled");
    const creation = settled[0];
    const snapshot = (
      await admin.query(
        "SELECT action_item_list_snapshot FROM idg_minutes WHERE idg_meeting_id=$1",
        [m],
      )
    ).rows[0].action_item_list_snapshot as Array<{ actionItemId: string }>;
    if (creation?.status === "fulfilled") {
      expect(snapshot.map((row) => row.actionItemId)).toContain(creation.value.id);
    } else {
      expect(creation?.reason).toMatchObject({ code: "MEETING_NOT_LIVE" });
    }
  });

  it("action-item execution remains legal after adjournment while creation/removal are frozen", async () => {
    const m = await seedMeeting(ORG_A, "live");
    const item = await svc.createActionItem(ORG_A, MEMBER, m, {
      patientId: PATIENT,
      assignedToMembershipId: MEMBER,
      dueDate: new Date().toISOString(),
    });
    await svc.adjournMeeting(ORG_A, MEMBER, m, true);
    await expect(
      svc.createActionItem(ORG_A, MEMBER, m, {
        patientId: PATIENT,
        assignedToMembershipId: MEMBER,
        dueDate: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: "MEETING_NOT_LIVE" });
    await expect(svc.removeActionItem(ORG_A, MEMBER, item.id)).rejects.toMatchObject({
      code: "MEETING_ADJOURNED",
    });
    expect((await svc.updateActionItem(ORG_A, MEMBER, item.id, "in_progress")).status).toBe(
      "in_progress",
    );
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
    const worklist = await svc.listActionItems(
      ORG_A,
      {},
      { assigneeMembershipId: MEMBER, locationIds: null, patientIds: null },
    );
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

  it("cancellation freezes prepared attendance and agenda history", async () => {
    const m = await seedMeeting(ORG_A, "scheduled");
    const attendance = await svc.recordAttendance(ORG_A, MEMBER, m, {
      membershipId: MEMBER,
      discipline: "rn",
    });
    const agenda = await svc.addAgendaItem(ORG_A, MEMBER, m, {
      kind: "patient_review",
      patientId: PATIENT,
    });
    await svc.cancelMeeting(ORG_A, MEMBER, m, "meeting cancelled");
    await expect(
      svc.updateAttendance(ORG_A, MEMBER, attendance.id, "excused"),
    ).rejects.toMatchObject({
      code: "ILLEGAL_MEETING_TRANSITION",
    });
    await expect(svc.removeAgendaItem(ORG_A, MEMBER, agenda.id)).rejects.toMatchObject({
      code: "ILLEGAL_MEETING_TRANSITION",
    });
    await expect(svc.addAgendaItem(ORG_A, MEMBER, m, { kind: "other" })).rejects.toMatchObject({
      code: "ILLEGAL_MEETING_TRANSITION",
    });
  });

  it("cancel / reschedule re-derive meeting_carry_forward_count in the same tx (a cancelled meeting is not counted — D8)", async () => {
    const origin = await seedMeeting(ORG_A, "adjourned");
    const item = (
      await admin.query(
        `INSERT INTO idg_action_item (organization_id, provider_entity_id, location_id, idg_meeting_id,
            assigned_to_membership_id, title, due_date, status, meeting_carry_forward_count)
         VALUES ($1,$2,$3,$4,$5,'t', now() - interval '3 days','open',3) RETURNING id`,
        [ORG_A, peOf[ORG_A], locationOf[ORG_A], origin, MEMBER],
      )
    ).rows[0].id as string;
    const carried = async (meetingId: string) =>
      admin.query(
        `INSERT INTO idg_agenda_item (organization_id, location_id, idg_meeting_id, title, kind,
            carried_from_action_item_id, added_by_membership_id)
         VALUES ($1,$2,$3,'Carried-forward action item','carry_forward',$4,$5)`,
        [ORG_A, locationOf[ORG_A], meetingId, item, MEMBER],
      );
    const adj = await seedMeeting(ORG_A, "adjourned");
    const toCancel = await seedMeeting(ORG_A, "scheduled");
    const toMove = await seedMeeting(ORG_A, "scheduled");
    for (const m of [adj, toCancel, toMove]) await carried(m);
    const countOf = async () =>
      (
        await admin.query(
          "SELECT meeting_carry_forward_count AS n FROM idg_action_item WHERE id=$1",
          [item],
        )
      ).rows[0].n as number;
    expect(await countOf()).toBe(3); // seeded stored count agrees with the 3 carry rows

    await svc.cancelMeeting(ORG_A, MEMBER, toCancel, "location closed");
    expect(await countOf()).toBe(2);
    await svc.rescheduleMeeting(ORG_A, MEMBER, toMove, {
      reason: "quorum unavailable",
      newScheduledStart: new Date(Date.now() + 86400000).toISOString(),
      newScheduledEnd: new Date(Date.now() + 90000000).toISOString(),
    });
    expect(await countOf()).toBe(1);
  });

  it("adjourn stamps last_idg_reviewed_at on each included patient's packet (GAP-020)", async () => {
    const m = await seedMeeting(ORG_A, "live");
    const patientId = randomUUID();
    await seedPacket(ORG_A, m, patientId, new Date(Date.now() - 20 * 86400000).toISOString());
    expect(await packetReviewedAt(m, patientId)).toBeNull();
    const adjourned = await svc.adjournMeeting(ORG_A, MEMBER, m, true);
    expect(await packetReviewedAt(m, patientId)).toBe(adjourned.adjournedAt);
  });

  it("cancel refuses a packet-included patient's 15-day review-floor breach with no covering meeting (GAP-020)", async () => {
    const m = await seedMeeting(ORG_A, "scheduled");
    const patientId = randomUUID();
    // since_cursor 20 days ago → floor 5 days ago (already lapsed); no other meeting covers this patient.
    await seedPacket(ORG_A, m, patientId, new Date(Date.now() - 20 * 86400000).toISOString());

    const breaches = await svc.loadReviewFloorBreaches(ORG_A, m, "cancel", null);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.patientId).toBe(patientId);

    await expect(svc.cancelMeeting(ORG_A, MEMBER, m, "no longer needed")).rejects.toMatchObject({
      code: "PER_PATIENT_REVIEW_FLOOR_BREACH",
    });
    // The rejected transition rolled back — the meeting is still scheduled, not cancelled.
    expect(await meetingStatus(m)).toBe("scheduled");
  });

  it("cancel succeeds when another non-cancelled meeting covers the patient's floor (GAP-020)", async () => {
    const patientId = randomUUID();
    const cursor = new Date(Date.now() - 10 * 86400000).toISOString(); // floor = +5 days from now
    const covering = await seedMeeting(ORG_A, "scheduled"); // scheduled_start = now(), on/before the floor
    const m = await seedMeeting(ORG_A, "scheduled");
    await seedPacket(ORG_A, covering, patientId, cursor);
    await seedPacket(ORG_A, m, patientId, cursor);

    expect(await svc.loadReviewFloorBreaches(ORG_A, m, "cancel", null)).toHaveLength(0);
    const cancelled = await svc.cancelMeeting(ORG_A, MEMBER, m, "duplicate booking");
    expect(cancelled.status).toBe("cancelled");
  });

  // Code review 2026-08-14 — the covering-meeting query excluded only `cancelled`/`rescheduled`, so an
  // ADJOURNED meeting counted as cover. That is always satisfiable: a patient's `since_cursor_iso` is set BY
  // their last adjourned meeting, so that meeting always sits on/before cursor + 15d. The guard therefore
  // returned an EMPTY breach set for every patient with any review history, and only ever bit for a patient
  // whose sole packet was on the meeting being cancelled.
  it("an ADJOURNED meeting does NOT cover the floor — it is what the floor is measured FROM (GAP-020)", async () => {
    const patientId = randomUUID();
    const cursor = new Date(Date.now() - 10 * 86400000).toISOString(); // floor = +5 days from now
    // scheduled_start = now(), i.e. on/before the floor — the ONLY thing disqualifying it is that it has
    // already adjourned. This is exactly the shape a real prior review leaves behind.
    const priorReview = await seedMeeting(ORG_A, "adjourned");
    const m = await seedMeeting(ORG_A, "scheduled");
    await seedPacket(ORG_A, priorReview, patientId, cursor);
    await seedPacket(ORG_A, m, patientId, cursor);

    const breaches = await svc.loadReviewFloorBreaches(ORG_A, m, "cancel", null);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.patientId).toBe(patientId);
    await expect(svc.cancelMeeting(ORG_A, MEMBER, m, "no longer needed")).rejects.toMatchObject({
      code: "PER_PATIENT_REVIEW_FLOOR_BREACH",
    });
    expect(await meetingStatus(m)).toBe("scheduled");
  });

  it("a still-PENDING meeting in any pre-adjourn status covers the floor (the allowlist is not over-tight)", async () => {
    for (const status of ["scheduled", "packets_building", "packets_ready", "live"] as const) {
      const patientId = randomUUID();
      const cursor = new Date(Date.now() - 10 * 86400000).toISOString();
      const covering = await seedMeeting(ORG_A, status);
      const m = await seedMeeting(ORG_A, "scheduled");
      await seedPacket(ORG_A, covering, patientId, cursor);
      await seedPacket(ORG_A, m, patientId, cursor);
      expect(await svc.loadReviewFloorBreaches(ORG_A, m, "cancel", null)).toHaveLength(0);
    }
  });

  it("reschedule refuses when the new start pushes the patient past their review floor (GAP-020)", async () => {
    const m = await seedMeeting(ORG_A, "scheduled");
    const patientId = randomUUID();
    await seedPacket(ORG_A, m, patientId, new Date(Date.now() - 10 * 86400000).toISOString()); // floor +5d
    await expect(
      svc.rescheduleMeeting(ORG_A, MEMBER, m, {
        reason: "conflict",
        newScheduledStart: new Date(Date.now() + 20 * 86400000).toISOString(), // past the floor
        newScheduledEnd: new Date(Date.now() + 20 * 86400000 + 3_600_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "PER_PATIENT_REVIEW_FLOOR_BREACH" });
  });

  it("reschedule succeeds when the new start still covers the patient's review floor (GAP-020)", async () => {
    const m = await seedMeeting(ORG_A, "scheduled");
    const patientId = randomUUID();
    await seedPacket(ORG_A, m, patientId, new Date(Date.now() - 10 * 86400000).toISOString()); // floor +5d
    const rescheduled = await svc.rescheduleMeeting(ORG_A, MEMBER, m, {
      reason: "conflict",
      newScheduledStart: new Date(Date.now() + 2 * 86400000).toISOString(), // within the floor
      newScheduledEnd: new Date(Date.now() + 2 * 86400000 + 3_600_000).toISOString(),
    });
    expect(rescheduled.status).toBe("rescheduled");
  });

  it("cancel with overrideAuthorized proceeds past a real breach and records the audited override (GAP-091)", async () => {
    const m = await seedMeeting(ORG_A, "scheduled");
    const patientId = randomUUID();
    await seedPacket(ORG_A, m, patientId, new Date(Date.now() - 20 * 86400000).toISOString()); // floor -5d

    const cancelled = await svc.cancelMeeting(ORG_A, MEMBER, m, "clinically necessary", true);
    expect(cancelled.status).toBe("cancelled");
    expect(await meetingStatus(m)).toBe("cancelled");

    const { rows } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2",
      [m, "m14.review_floor.override_recorded"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      meetingId: m,
      actorMembershipId: MEMBER,
      reason: "clinically necessary",
      breachingPatients: [{ patientId }],
    });
  });

  it("cancel WITHOUT overrideAuthorized still refuses a real breach (the default stays false)", async () => {
    const m = await seedMeeting(ORG_A, "scheduled");
    const patientId = randomUUID();
    await seedPacket(ORG_A, m, patientId, new Date(Date.now() - 20 * 86400000).toISOString());
    await expect(svc.cancelMeeting(ORG_A, MEMBER, m, "no longer needed")).rejects.toMatchObject({
      code: "PER_PATIENT_REVIEW_FLOOR_BREACH",
    });
    const { rows } = await admin.query(
      "SELECT 1 FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2",
      [m, "m14.review_floor.override_recorded"],
    );
    expect(rows).toHaveLength(0);
  });

  it("reschedule with overrideAuthorized proceeds past a floor breach and records the audited override (GAP-091)", async () => {
    const m = await seedMeeting(ORG_A, "scheduled");
    const patientId = randomUUID();
    await seedPacket(ORG_A, m, patientId, new Date(Date.now() - 10 * 86400000).toISOString()); // floor +5d
    const rescheduled = await svc.rescheduleMeeting(ORG_A, MEMBER, m, {
      reason: "provider unavailable",
      newScheduledStart: new Date(Date.now() + 20 * 86400000).toISOString(), // past the floor
      newScheduledEnd: new Date(Date.now() + 20 * 86400000 + 3_600_000).toISOString(),
      overrideAuthorized: true,
    });
    expect(rescheduled.status).toBe("rescheduled");

    const { rows } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2",
      [m, "m14.review_floor.override_recorded"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      meetingId: m,
      actorMembershipId: MEMBER,
      reason: "provider unavailable",
      breachingPatients: [{ patientId }],
    });
  });

  it("overrideAuthorized on a NON-breaching cancel is a no-op — no override event is recorded", async () => {
    const m = await seedMeeting(ORG_A, "scheduled");
    const cancelled = await svc.cancelMeeting(ORG_A, MEMBER, m, "location closed", true);
    expect(cancelled.status).toBe("cancelled");
    const { rows } = await admin.query(
      "SELECT 1 FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2",
      [m, "m14.review_floor.override_recorded"],
    );
    expect(rows).toHaveLength(0);
  });

  it("idg.review-clock-sweep escalates a patient at T-0, aggregating last_idg_reviewed_at across multiple packets (GAP-092)", async () => {
    const patientId = randomUUID();
    const admissionId = randomUUID();
    const reviewed = await seedMeeting(ORG_A, "adjourned");
    const laterUnreviewed = await seedMeeting(ORG_A, "scheduled");
    // `reviewed`'s packet already has a real last_idg_reviewed_at (15 days ago → floor is today, T-0);
    // `laterUnreviewed` is a NEWER, not-yet-adjourned packet for the SAME patient whose own
    // last_idg_reviewed_at is still null — the store must not let this newer-but-unreviewed row shadow
    // the older packet's real reviewed date (the exact bug `reviewClockPatientsForOrg`'s per-patient
    // aggregation, not a naive "latest packet" read, exists to avoid).
    await seedPacket(
      ORG_A,
      reviewed,
      patientId,
      new Date(Date.now() - 40 * 86400000).toISOString(),
      admissionId,
    );
    await admin.query(
      "UPDATE idg_patient_packet SET last_idg_reviewed_at=$1 WHERE idg_meeting_id=$2 AND patient_id=$3",
      [new Date(Date.now() - 15 * 86400000), reviewed, patientId],
    );
    await seedPacket(
      ORG_A,
      laterUnreviewed,
      patientId,
      new Date(Date.now() - 3 * 86400000).toISOString(),
      admissionId,
    );

    const deps = buildM14WorkerDeps({
      connection: {} as never, // runReviewClockSweepCron never touches BullMQ — no Redis needed
      db: handle.db,
      outbox,
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      activeAdmissions: activeAdmissionsStub(admissionId, patientId, 40),
    });
    await runReviewClockSweepCron(deps);

    const { rows } = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type=$1 AND payload->>'patientId'=$2",
      ["m14.review_clock.escalated", patientId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      patientId,
      stage: "t_zero",
      severity: "critical",
      // the M36 alert's coordinator tier: the location's upcoming meeting's coordinator (`laterUnreviewed`)
      coordinatorMembershipId: MEMBER,
    });
  });

  it("idg.review-clock-sweep does not escalate a patient whose floor is not at T-3/T-0/T+1 today", async () => {
    const patientId = randomUUID();
    const admissionId = randomUUID();
    const m = await seedMeeting(ORG_A, "scheduled");
    // since_cursor 5 days ago → floor 10 days from now — nowhere near any escalation stage.
    await seedPacket(
      ORG_A,
      m,
      patientId,
      new Date(Date.now() - 5 * 86400000).toISOString(),
      admissionId,
    );

    const deps = buildM14WorkerDeps({
      connection: {} as never,
      db: handle.db,
      outbox,
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      activeAdmissions: activeAdmissionsStub(admissionId, patientId, 5),
    });
    await runReviewClockSweepCron(deps);

    const { rows } = await admin.query(
      "SELECT 1 FROM outbox_event WHERE event_type=$1 AND payload->>'patientId'=$2",
      ["m14.review_clock.escalated", patientId],
    );
    expect(rows).toHaveLength(0);
  });

  it("scheduleMeeting persists a 'scheduled' ad-hoc meeting, defaults + honours the coordinator, emits m14.meeting.scheduled, rejects overlap", async () => {
    const start = new Date("2031-03-04T15:00:00.000Z");
    const end = new Date("2031-03-04T17:00:00.000Z");
    const args = {
      locationId: locationOf[ORG_A],
      scheduledStart: start.toISOString(),
      scheduledEnd: end.toISOString(),
    };
    const created = await svc.scheduleMeeting(ORG_A, MEMBER, args);
    expect(created).toMatchObject({
      status: "scheduled",
      locationId: locationOf[ORG_A],
      coordinatorMembershipId: MEMBER, // defaults to the acting membership
      adjournedAt: null,
    });
    expect(await eventsFor(created.id)).toContain("m14.meeting.scheduled");
    const { rows } = await admin.query(
      "SELECT recurring_policy_id, organization_id, status FROM idg_meeting WHERE id=$1",
      [created.id],
    );
    expect(rows[0]).toMatchObject({
      recurring_policy_id: null,
      organization_id: ORG_A,
      status: "scheduled",
    });

    // the coordinator reaches the read model (detail + schedule list)
    expect((await svc.getMeeting(ORG_A, created.id)).coordinatorMembershipId).toBe(MEMBER);
    const listed = await svc.listSchedule(ORG_A, {
      location: locationOf[ORG_A],
      from: "2031-03-01T00:00:00.000Z",
      to: "2031-03-31T00:00:00.000Z",
    });
    expect(listed.find((m) => m.id === created.id)?.coordinatorMembershipId).toBe(MEMBER);

    // overlap → 409 IDG_MEETING_OVERLAP; back-to-back + explicit coordinator OK
    await expect(
      svc.scheduleMeeting(ORG_A, MEMBER, {
        ...args,
        scheduledStart: new Date(start.getTime() + 3_600_000).toISOString(),
        scheduledEnd: new Date(end.getTime() + 3_600_000).toISOString(),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "IDG_MEETING_OVERLAP" });
    const other = await seedMembership(ORG_A, "active"); // an explicit coordinator must be a real active member
    const adjacent = await svc.scheduleMeeting(ORG_A, MEMBER, {
      ...args,
      scheduledStart: end.toISOString(),
      scheduledEnd: new Date(end.getTime() + 3_600_000).toISOString(),
      coordinatorMembershipId: other,
    });
    expect(adjacent.coordinatorMembershipId).toBe(other);

    // a cancelled meeting frees its slot
    await svc.cancelMeeting(ORG_A, MEMBER, adjacent.id, "test");
    await expect(
      svc.scheduleMeeting(ORG_A, MEMBER, {
        ...args,
        scheduledStart: end.toISOString(),
        scheduledEnd: new Date(end.getTime() + 3_600_000).toISOString(),
      }),
    ).resolves.toMatchObject({ status: "scheduled" });
  });

  it("scheduleMeeting: org B cannot see org A's ad-hoc meeting (RLS, wardenx_app)", async () => {
    const m = await svc.scheduleMeeting(ORG_A, MEMBER, {
      locationId: locationOf[ORG_A],
      scheduledStart: "2032-03-04T15:00:00.000Z",
      scheduledEnd: "2032-03-04T16:00:00.000Z",
    });
    await expect(svc.getMeeting(ORG_B, m.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("RLS: org B cannot start or read org A's meeting (404 under the wardenx_app policy)", async () => {
    const m = await seedMeeting(ORG_A, "packets_ready");
    await expect(svc.getMeeting(ORG_B, m)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.startMeeting(ORG_B, MEMBER, m)).rejects.toMatchObject({ statusCode: 404 });
  });
  it("scheduleMeeting: coordinatorMembershipId must be an ACTIVE membership of the caller's org (422, uniform, wardenx_app)", async () => {
    const active = await seedMembership(ORG_A, "active");
    const pending = await seedMembership(ORG_A, "pending");
    const revoked = await seedMembership(ORG_A, "revoked");
    const foreignOrg = await seedMembership(ORG_B, "active");
    const window = (day: number) => ({
      locationId: locationOf[ORG_A],
      scheduledStart: `2033-05-${String(day).padStart(2, "0")}T15:00:00.000Z`,
      scheduledEnd: `2033-05-${String(day).padStart(2, "0")}T16:00:00.000Z`,
    });
    const messages: string[] = [];
    for (const bad of [foreignOrg, pending, revoked, randomUUID()]) {
      const err = await svc
        .scheduleMeeting(ORG_A, MEMBER, { ...window(2), coordinatorMembershipId: bad })
        .then(
          () => null,
          (e: { statusCode?: number; code?: string; message?: string }) => e,
        );
      expect(err).toMatchObject({ statusCode: 422, code: "VALIDATION_FAILED" });
      messages.push(JSON.stringify(err));
    }
    // foreign-org id is indistinguishable from a made-up id (no cross-tenant existence oracle)
    expect(messages[0]).toBe(messages[3]);
    // nothing was persisted for the rejected attempts
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM idg_meeting WHERE organization_id=$1 AND scheduled_start=$2",
      [ORG_A, "2033-05-02T15:00:00.000Z"],
    );
    expect(rows[0].n).toBe(0);
    const ok = await svc.scheduleMeeting(ORG_A, MEMBER, {
      ...window(3),
      coordinatorMembershipId: active,
    });
    expect(ok.coordinatorMembershipId).toBe(active);
  });
  it("per-discipline notes: live-only, discipline-authorised, If-Match, Part 2 elision, minutes freeze, RLS, no DELETE", async () => {
    const PATIENT_FLAGGED = "66666666-6666-6666-6666-666666666666";
    const PATIENT_CLEAR = "77777777-7777-7777-7777-777777777777";
    const PATIENT_OFF_AGENDA = "88888888-8888-8888-8888-888888888888";
    const RN = "33333333-3333-3333-3333-3333333333a1";
    const MSW = "33333333-3333-3333-3333-3333333333a2";
    const COORD = { membershipId: MEMBER, isCoordinator: true };
    const rn = { membershipId: RN, isCoordinator: false };
    const msw = { membershipId: MSW, isCoordinator: false };
    const err = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: { statusCode?: number; code?: string }) => e,
      );

    // Not live -> refused (packets_ready is a real pre-start status).
    const early = await seedMeeting(ORG_A, "packets_ready");
    expect(
      await err(svc.createDisciplineNote(ORG_A, COORD, early, { discipline: "rn", bodyText: "x" })),
    ).toMatchObject({ statusCode: 422, code: "MEETING_NOT_LIVE" });

    const m = await seedMeeting(ORG_A, "live");
    await svc.recordAttendance(ORG_A, RN, m, { membershipId: RN, discipline: "rn" });
    await svc.recordAttendance(ORG_A, MSW, m, {
      membershipId: MSW,
      discipline: "msw",
      status: "absent",
    });
    // Two agenda patients whose packets vouch (or not) for the SUD flag; a third is undeterminable (no packet).
    for (const [pid, flag] of [
      [PATIENT_FLAGGED, true],
      [PATIENT_CLEAR, false],
    ] as const) {
      await svc.addAgendaItem(ORG_A, MEMBER, m, { kind: "patient_review", patientId: pid });
      await admin.query(
        `INSERT INTO idg_patient_packet
           (organization_id, provider_entity_id, location_id, idg_meeting_id, patient_id, admission_id,
            since_cursor_iso, built_snapshot, discipline_views, cover_summary_layer1)
         VALUES ($1,$2,$3,$4,$5,$6, now(), $7::jsonb,'{}'::jsonb,'seed')`,
        [
          ORG_A,
          peOf[ORG_A],
          locationOf[ORG_A],
          m,
          pid,
          ADMISSION,
          JSON.stringify({ patientCover: { activeSudFlag: flag } }),
        ],
      );
    }

    // Authorisation: the RN writes rn; an ABSENT msw may not; a coordinator may write any discipline.
    const clear = await svc.createDisciplineNote(ORG_A, rn, m, {
      patientId: PATIENT_CLEAR,
      discipline: "rn",
      bodyText: "RN: pain controlled on current regimen",
      reason: "  RN-CLEAR-REASON  ", // optional context on a LIVE note: trimmed
    });
    expect(clear).toMatchObject({
      discipline: "rn",
      authorMembershipId: RN,
      version: 0,
      isAddendum: false,
      reason: "RN-CLEAR-REASON",
    });
    expect(
      await err(svc.createDisciplineNote(ORG_A, rn, m, { discipline: "msw", bodyText: "x" })),
    ).toMatchObject({
      statusCode: 403,
    });
    expect(
      await err(svc.createDisciplineNote(ORG_A, msw, m, { discipline: "msw", bodyText: "x" })),
    ).toMatchObject({
      statusCode: 403,
    });
    const flagged = await svc.createDisciplineNote(ORG_A, COORD, m, {
      patientId: PATIENT_FLAGGED,
      discipline: "msw",
      bodyText: "MSW: SUD history discussed with family",
      reason: "FLAGGED-LIVE-REASON-SECRET",
    });
    const meetingLevel = await svc.createDisciplineNote(ORG_A, rn, m, {
      discipline: "rn",
      bodyText: "RN: census reviewed",
      reason: "   ", // blank => absent
    });
    expect(meetingLevel.reason).toBeNull();
    expect(meetingLevel.patientId).toBeNull();
    // patient not on the agenda -> 422 (URL-tamper defence)
    expect(
      await err(
        svc.createDisciplineNote(ORG_A, COORD, m, {
          patientId: PATIENT_OFF_AGENDA,
          discipline: "rn",
          bodyText: "x",
        }),
      ),
    ).toMatchObject({ statusCode: 422, code: "INCLUSION_CRITERIA_FAILED" });

    // Edit: If-Match. Stale -> 412; right version bumps; another discipline's non-coordinator -> 403.
    expect(
      await err(svc.updateDisciplineNote(ORG_A, rn, clear.id, { bodyText: "edit" }, 5)),
    ).toMatchObject({
      statusCode: 412,
      code: "STALE_VERSION",
    });
    const edited = await svc.updateDisciplineNote(
      ORG_A,
      rn,
      clear.id,
      { bodyText: "RN: pain now 2/10" },
      0,
    );
    expect(edited).toMatchObject({
      version: 1,
      bodyText: "RN: pain now 2/10",
      reason: "RN-CLEAR-REASON",
    });
    // PATCH may edit the reason alone (text untouched); blank clears it; then restore for the snapshot checks below.
    const reasonOnly = await svc.updateDisciplineNote(
      ORG_A,
      rn,
      clear.id,
      { reason: "RN-EDITED-REASON" },
      1,
    );
    expect(reasonOnly).toMatchObject({
      version: 2,
      bodyText: "RN: pain now 2/10",
      reason: "RN-EDITED-REASON",
    });
    const cleared = await svc.updateDisciplineNote(ORG_A, rn, clear.id, { reason: "  " }, 2);
    expect(cleared).toMatchObject({ version: 3, reason: null });
    const restored = await svc.updateDisciplineNote(
      ORG_A,
      rn,
      clear.id,
      { reason: "RN-CLEAR-REASON" },
      3,
    );
    expect(restored.version).toBe(4);
    expect(
      await err(svc.updateDisciplineNote(ORG_A, msw, clear.id, { bodyText: "hijack" }, 4)),
    ).toMatchObject({
      statusCode: 403,
    });
    expect(await svc.disciplineNoteMeetingId(ORG_A, clear.id)).toBe(m);
    expect(await svc.disciplineNoteMeetingId(ORG_B, clear.id)).toBeNull();
    expect(
      await err(svc.updateDisciplineNote(ORG_B, COORD, clear.id, { bodyText: "x" }, 4)),
    ).toMatchObject({
      statusCode: 404,
    });
    expect(await err(svc.listDisciplineNotes(ORG_B, m, {}))).toMatchObject({ statusCode: 404 });

    // Part 2: the flagged patient's text is WITHHELD with no viewer (fail-closed) or a denying one; visible
    // only when the viewer proves a release. The packet-vouched-clear patient + the meeting-level note always show.
    const denied = await svc.listDisciplineNotes(ORG_A, m, {});
    expect(denied.map((n) => [n.id, n.bodyWithheld, n.bodyText === null])).toEqual([
      [clear.id, false, false],
      [flagged.id, true, true],
      [meetingLevel.id, false, false],
    ]);
    // the original note's reason is withheld with its body (Part 2), shown otherwise
    expect(denied.find((n) => n.id === flagged.id)?.reason).toBeNull();
    expect(JSON.stringify(denied)).not.toContain("FLAGGED-LIVE-REASON-SECRET");
    expect(denied.find((n) => n.id === clear.id)?.reason).toBe("RN-CLEAR-REASON");
    const allowed = await svc.listDisciplineNotes(
      ORG_A,
      m,
      { patientId: PATIENT_FLAGGED },
      { sudDisclosureAllowed: async () => true },
    );
    expect(allowed).toHaveLength(1);
    expect(allowed[0]?.bodyText).toBe("MSW: SUD history discussed with family");
    expect(allowed[0]?.reason).toBe("FLAGGED-LIVE-REASON-SECRET");
    const throwing = await svc.listDisciplineNotes(
      ORG_A,
      m,
      { patientId: PATIENT_FLAGGED },
      {
        sudDisclosureAllowed: async () => {
          throw new Error("M39 down");
        },
      },
    );
    expect(throwing[0]?.bodyWithheld).toBe(true);

    // Audit trigger: the write is audited and body_text never lands in audit_event.
    const { rows: audits } = await admin.query(
      "SELECT after::text AS after FROM audit_event WHERE resource_kind='idg_discipline_note' AND resource_id=$1",
      [clear.id],
    );
    expect(audits.length).toBeGreaterThanOrEqual(2); // insert + update
    for (const a of audits) {
      expect(a.after).not.toContain("pain");
      expect(a.after).not.toContain("RN-CLEAR-REASON"); // the (now general) reason column is scrubbed too
      expect(a.after).not.toContain("RN-EDITED-REASON");
    }
    const { rows: audFlagged } = await admin.query(
      "SELECT after::text AS after FROM audit_event WHERE resource_kind='idg_discipline_note' AND resource_id=$1",
      [flagged.id],
    );
    for (const a of audFlagged) expect(a.after).not.toContain("FLAGGED-LIVE-REASON-SECRET");

    // The app role has NO delete grant (append/edit-only).
    const app = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.org_id',$1,true)", [ORG_A]);
      await expect(
        app.query("DELETE FROM idg_discipline_note WHERE id=$1", [clear.id]),
      ).rejects.toThrow(/permission denied/i);
      await app.query("ROLLBACK");
      // cross-tenant: another org's context sees no rows at all (FORCE RLS as the real NOBYPASSRLS role)
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.org_id',$1,true)", [ORG_B]);
      const cross = await app.query("SELECT count(*)::int AS n FROM idg_discipline_note");
      expect(cross.rows[0].n).toBe(0);
      await app.query("ROLLBACK");
    } finally {
      await app.end();
    }

    // Decisions for the minutes render's DECISION CONTENT: a clear patient (text shown), a SUD-flagged patient
    // (Part 2: metadata only), and a meeting-level team note (no patient: never withheld).
    const decClear = await svc.recordDecision(ORG_A, MEMBER, m, {
      patientId: PATIENT_CLEAR,
      decisionKind: "care_plan_update",
      payload: {
        kind: "care_plan_update",
        mutations: [
          {
            op: "problem_add",
            icd10Code: null,
            snomedCode: null,
            description: "CLEAR-DECISION-TEXT dyspnea",
            problemKind: "related",
          },
        ],
      },
    });
    const decFlagged = await svc.recordDecision(ORG_A, MEMBER, m, {
      patientId: PATIENT_FLAGGED,
      decisionKind: "level_of_care_consideration",
      payload: {
        kind: "level_of_care_consideration",
        consideredLevel: "general_inpatient",
        rationaleText: "FLAGGED-DECISION-SECRET",
      },
    });
    const decTeam = await svc.recordDecision(ORG_A, MEMBER, m, {
      patientId: null,
      decisionKind: "team_note",
      payload: { kind: "team_note", noteText: "MEETING-LEVEL-DECISION-TEXT" },
    });

    // Adjournment freezes the notes into the minutes; SUD-flagged text is elided in the snapshot.
    const adjourned = await svc.adjournMeeting(ORG_A, MEMBER, m, true);
    expect(adjourned.status).toBe("adjourned");
    const minutes = await svc.getMinutes(ORG_A, m);
    expect(minutes.disciplineNoteCount).toBe(3);
    const { rows: snap } = await admin.query(
      "SELECT discipline_note_snapshot AS s FROM idg_minutes WHERE id=$1",
      [minutes.id],
    );
    const byId = new Map(
      (
        snap[0].s as Array<{
          noteId: string;
          bodyText: string | null;
          reason: string | null;
          bodyWithheld: boolean;
        }>
      ).map((n) => [n.noteId, n]),
    );
    expect(byId.get(clear.id)).toMatchObject({
      bodyText: "RN: pain now 2/10",
      reason: "RN-CLEAR-REASON",
      bodyWithheld: false,
    });
    expect(byId.get(meetingLevel.id)?.bodyText).toBe("RN: census reviewed");
    expect(byId.get(flagged.id)).toMatchObject({
      bodyText: null,
      reason: null,
      bodyWithheld: true,
    });
    expect(byId.get(meetingLevel.id)?.reason).toBeNull();
    const { rows: ev } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m14.minutes.signed'",
      [minutes.id],
    );
    expect(ev[0].payload.renderPayload.disciplineNoteSnapshot).toHaveLength(3);
    expect(JSON.stringify(ev[0].payload)).not.toContain("SUD history");
    expect(JSON.stringify(ev[0].payload)).not.toContain("FLAGGED-LIVE-REASON-SECRET");
    expect(ev[0].payload.renderPayload.disciplineNoteSnapshot).toEqual(snap[0].s); // reason rides in the render payload

    // PDF header names (real M1 seam, as wardenx_app) + live DECISION CONTENT, re-derived at emit.
    const signedRp = ev[0].payload.renderPayload;
    expect(signedRp.meeting).toMatchObject({
      organizationName: "A",
      locationName: "Loc",
      locationId: locationOf[ORG_A],
    });
    const content = new Map(
      (
        signedRp.decisionContent as Array<{
          decisionId: string;
          withheld: boolean;
          patientId: string | null;
          summary: string[];
          status: string;
        }>
      ).map((d) => [d.decisionId, d]),
    );
    expect(content.size).toBe(3);
    expect(content.get(decClear.id)).toMatchObject({
      withheld: false,
      patientId: PATIENT_CLEAR,
      status: "emitted",
      summary: ["Add problem (Related) | CLEAR-DECISION-TEXT dyspnea"],
    });
    // 42 CFR Part 2 (fail-closed, same set as the note snapshot): metadata only, patient NOT labelled.
    expect(content.get(decFlagged.id)).toMatchObject({
      withheld: true,
      patientId: null,
      summary: [],
    });
    expect(JSON.stringify(ev[0].payload)).not.toContain("FLAGGED-DECISION-SECRET");
    expect(content.get(decTeam.id)).toMatchObject({
      withheld: false,
      patientId: null,
      summary: ["MEETING-LEVEL-DECISION-TEXT"],
    });
    // The frozen decision_list_snapshot is NOT mutated by any of this: kind + metadata only, no content.
    const { rows: dsnap } = await admin.query(
      "SELECT decision_list_snapshot::text AS s FROM idg_minutes WHERE id=$1",
      [minutes.id],
    );
    expect(dsnap[0].s).not.toContain("CLEAR-DECISION-TEXT");
    expect(dsnap[0].s).not.toContain("MEETING-LEVEL-DECISION-TEXT");
    expect(JSON.parse(dsnap[0].s)).toHaveLength(3);

    // Final minutes are frozen for ORIGINAL notes: no edit once the meeting is no longer live...
    expect(
      await err(svc.updateDisciplineNote(ORG_A, COORD, clear.id, { bodyText: "late" }, 4)),
    ).toMatchObject({
      statusCode: 422,
      code: "MEETING_NOT_LIVE",
    });
    // ...but a note may still be added as a LATE ADDENDUM (new row, reason required), never touching the snapshot.
    expect(minutes.disciplineAddendumCount).toBe(0);
    expect(
      await err(svc.createDisciplineNote(ORG_A, COORD, m, { discipline: "rn", bodyText: "late" })),
    ).toMatchObject({ statusCode: 422, code: "ADDENDUM_REASON_REQUIRED" });
    expect(
      await err(
        svc.createDisciplineNote(ORG_A, COORD, m, {
          discipline: "rn",
          bodyText: "late",
          reason: "   ",
        }),
      ),
    ).toMatchObject({ statusCode: 422, code: "ADDENDUM_REASON_REQUIRED" });
    // attendance persists after adjournment: the RN (present) may add an rn addendum; the absent msw may not.
    const addendum = await svc.createDisciplineNote(ORG_A, rn, m, {
      patientId: PATIENT_FLAGGED,
      discipline: "rn",
      bodyText: "ADDENDUM-BODY-SECRET",
      reason: "ADDENDUM-REASON-SECRET missed vitals",
    });
    expect(addendum).toMatchObject({ isAddendum: true, version: 0, discipline: "rn" });
    expect(addendum.addendumRecordedAt).toBe(addendum.createdAt);
    expect(
      await err(
        svc.createDisciplineNote(ORG_A, msw, m, { discipline: "msw", bodyText: "x", reason: "r" }),
      ),
    ).toMatchObject({ statusCode: 403 });
    // append-only: PATCH of an addendum is refused; PATCH of an original stays MEETING_NOT_LIVE
    expect(
      await err(svc.updateDisciplineNote(ORG_A, COORD, addendum.id, { reason: "x" }, 0)),
    ).toMatchObject({
      statusCode: 422,
      code: "ADDENDUM_IMMUTABLE",
    });
    // The frozen snapshot + count are untouched; the addendum count is LIVE; Part 2 elides body AND reason.
    const after = await svc.getMinutes(ORG_A, m);
    expect(after.disciplineNoteCount).toBe(3);
    expect(after.disciplineAddendumCount).toBe(1);
    const { rows: snap2 } = await admin.query(
      "SELECT discipline_note_snapshot AS s FROM idg_minutes WHERE id=$1",
      [minutes.id],
    );
    expect(snap2[0].s).toEqual(snap[0].s);
    expect(JSON.stringify(snap2[0].s)).not.toContain("ADDENDUM-");
    const listed = await svc.listDisciplineNotes(ORG_A, m, {});
    expect(listed).toHaveLength(4);
    const hidden = listed.find((n) => n.id === addendum.id);
    expect(hidden).toMatchObject({
      isAddendum: true,
      bodyText: null,
      reason: null,
      bodyWithheld: true,
    });
    const shown = await svc.listDisciplineNotes(
      ORG_A,
      m,
      { patientId: PATIENT_FLAGGED },
      { sudDisclosureAllowed: async () => true },
    );
    expect(shown.find((n) => n.id === addendum.id)).toMatchObject({
      bodyText: "ADDENDUM-BODY-SECRET",
      reason: "ADDENDUM-REASON-SECRET missed vitals",
    });
    // The addendum emitted `m14.discipline_note.addendum_recorded` in ITS transaction (M22 appends a minutes
    // version): live rows -> `disciplineAddenda`, Part 2 elision identical to the frozen snapshot, name only.
    const { rows: aev } = await admin.query(
      `SELECT payload FROM outbox_event
        WHERE aggregate_id=$1 AND event_type='m14.discipline_note.addendum_recorded' ORDER BY created_at`,
      [minutes.id],
    );
    expect(aev).toHaveLength(1);
    expect(aev[0].payload).toMatchObject({
      minutesId: minutes.id,
      meetingId: m,
      addendumId: addendum.id,
      addendumCount: 1,
      recordedByMembershipId: rn.membershipId,
    });
    const rp = aev[0].payload.renderPayload;
    expect(rp.disciplineNoteSnapshot).toEqual(snap[0].s); // frozen snapshot rides along, untouched
    expect(rp.disciplineAddenda).toEqual([
      {
        noteId: addendum.id,
        patientId: PATIENT_FLAGGED,
        discipline: "rn",
        authorMembershipId: rn.membershipId,
        authorName: `Name-${rn.membershipId.slice(0, 8)}`,
        recordedAt: addendum.addendumRecordedAt,
        reason: null,
        bodyText: null,
        bodyWithheld: true,
      },
    ]);
    // The render CONTEXT the M22 PDF needs rides the payload (dates, names, status) — never stored.
    expect(rp.minutesStatus).toBe("final");
    expect(rp.amendmentCount).toBe(0);
    expect(rp.meeting).toMatchObject({ meetingId: m, organizationName: "A", locationName: "Loc" });
    expect(rp.meeting.actualEnd).toEqual(expect.any(String));
    // decision content is re-derived at the addendum emit too (same Part 2 verdicts)
    expect(rp.decisionContent).toEqual(signedRp.decisionContent);
    expect(rp.memberNames[rn.membershipId]).toBe(`Name-${rn.membershipId.slice(0, 8)}`);
    expect(JSON.stringify(aev[0].payload)).not.toContain("ADDENDUM-");
    // audit: the INSERT is audited, and neither body_text nor reason lands in audit_event
    const { rows: aaud } = await admin.query(
      "SELECT after::text AS after FROM audit_event WHERE resource_kind='idg_discipline_note' AND resource_id=$1",
      [addendum.id],
    );
    expect(aaud.length).toBeGreaterThanOrEqual(1);
    for (const a of aaud) expect(a.after).not.toContain("ADDENDUM-");
    // reason on a LIVE meeting is refused elsewhere; out of window: adjournment 15 days ago => window closed
    await admin.query(
      "UPDATE idg_meeting SET actual_end = now() - interval '15 days' WHERE id=$1",
      [m],
    );
    expect(
      await err(
        svc.createDisciplineNote(ORG_A, COORD, m, { discipline: "rn", bodyText: "x", reason: "r" }),
      ),
    ).toMatchObject({ statusCode: 422, code: "ADDENDUM_WINDOW_CLOSED" });
    await admin.query(
      "UPDATE idg_meeting SET actual_end = now() - interval '13 days' WHERE id=$1",
      [m],
    );
    expect(
      (
        await svc.createDisciplineNote(ORG_A, COORD, m, {
          discipline: "rn",
          bodyText: "in window",
          reason: "r",
        })
      ).isAddendum,
    ).toBe(true);
    // A second addendum re-emits with the FULL live set (count 2, oldest first) — the newest event always
    // carries every addendum, so the last appended document version is complete.
    const { rows: aev2 } = await admin.query(
      `SELECT payload FROM outbox_event
        WHERE aggregate_id=$1 AND event_type='m14.discipline_note.addendum_recorded' ORDER BY created_at`,
      [minutes.id],
    );
    expect(aev2).toHaveLength(2);
    expect(aev2[1].payload.addendumCount).toBe(2);
    expect(aev2[1].payload.renderPayload.disciplineAddenda).toHaveLength(2);
    expect(aev2[1].payload.renderPayload.disciplineAddenda[1]).toMatchObject({
      bodyText: "in window",
      reason: "r",
      bodyWithheld: false,
      patientId: null,
    });
    // DB CHECK as the real NOBYPASSRLS app role: an addendum without a reason / a non-addendum with one is refused.
    const app2 = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await app2.connect();
    try {
      for (const [flag, reason] of [
        [true, null],
        [true, "  "],
        [false, "  "],
        [false, "x".repeat(501)],
        [true, "x".repeat(501)],
      ] as const) {
        await app2.query("BEGIN");
        await app2.query("SELECT set_config('app.org_id',$1,true)", [ORG_A]);
        await expect(
          app2.query(
            `INSERT INTO idg_discipline_note (organization_id, idg_meeting_id, discipline, body_text,
               author_membership_id, is_addendum, addendum_recorded_at, reason)
             VALUES ($1,$2,'rn','x',$3,$4,$5,$6)`,
            [ORG_A, m, COORD.membershipId, flag, flag ? new Date() : null, reason],
          ),
        ).rejects.toThrow(/idg_discipline_note_addendum_chk/);
        await app2.query("ROLLBACK");
      }
      // an ORIGINAL note may now carry a (non-blank) reason...
      await app2.query("BEGIN");
      await app2.query("SELECT set_config('app.org_id',$1,true)", [ORG_A]);
      await app2.query(
        `INSERT INTO idg_discipline_note (organization_id, idg_meeting_id, discipline, body_text,
           author_membership_id, is_addendum, addendum_recorded_at, reason)
         VALUES ($1,$2,'rn','x',$3,false,NULL,'context')`,
        [ORG_A, m, COORD.membershipId],
      );
      await app2.query("ROLLBACK");
      // still no DELETE on an addendum
      await app2.query("BEGIN");
      await app2.query("SELECT set_config('app.org_id',$1,true)", [ORG_A]);
      await expect(
        app2.query("DELETE FROM idg_discipline_note WHERE id=$1", [addendum.id]),
      ).rejects.toThrow(/permission denied/i);
      await app2.query("ROLLBACK");
    } finally {
      await app2.end();
    }
    // ...and the amendment below re-renders the frozen notes (addenda are not IN the snapshot) PLUS the live
    // 'Addenda' appendix, so the newest document version never drops addenda an earlier version showed.
    await svc.submitAmendment(ORG_A, MEMBER, minutes.id, "typo");
    const { rows: amended } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m14.minutes.amended'",
      [minutes.id],
    );
    expect(amended[0].payload.renderPayload.disciplineNoteSnapshot).toHaveLength(3);
    expect(amended[0].payload.renderPayload.disciplineAddenda).toHaveLength(2);
    expect(JSON.stringify(amended[0].payload)).not.toContain("ADDENDUM-");

    // WINDOW B — supersession by a NEWER ADJOURNED IDG. `m` was adjourned 13 days ago (actual_end set above).
    const newer = await seedMeeting(ORG_A, "live");
    await svc.addAgendaItem(ORG_A, MEMBER, newer, {
      kind: "patient_review",
      patientId: PATIENT_CLEAR,
    });
    // a LIVE newer meeting supersedes nothing
    expect((await svc.getMinutes(ORG_A, m)).addendumState).toMatchObject({
      open: true,
      closedReason: null,
      supersededPatientIds: [],
    });
    await admin.query(
      "UPDATE idg_meeting SET status='adjourned', actual_end = now() - interval '1 day' WHERE id=$1",
      [newer],
    );
    // patient reached through a patient-scoped AGENDA item of the newer adjourned meeting
    expect(
      await err(
        svc.createDisciplineNote(ORG_A, COORD, m, {
          patientId: PATIENT_CLEAR,
          discipline: "rn",
          bodyText: "too late for this patient",
          reason: "r",
        }),
      ),
    ).toMatchObject({ statusCode: 422, code: "ADDENDUM_SUPERSEDED_BY_NEWER_IDG" });
    // ...and through a stored PACKET of the newer adjourned meeting
    await seedPacket(ORG_A, newer, PATIENT_FLAGGED, new Date().toISOString());
    expect(
      await err(
        svc.createDisciplineNote(ORG_A, COORD, m, {
          patientId: PATIENT_FLAGGED,
          discipline: "msw",
          bodyText: "too late",
          reason: "r",
        }),
      ),
    ).toMatchObject({ statusCode: 422, code: "ADDENDUM_SUPERSEDED_BY_NEWER_IDG" });
    // ORG isolation of the lookup: org B's meetings are never consulted (RLS under wardenx_app); the read model:
    const st = (await svc.getMinutes(ORG_A, m)).addendumState;
    expect(st).toMatchObject({ open: true, closedReason: null });
    expect([...st.supersededPatientIds].sort()).toEqual([PATIENT_CLEAR, PATIENT_FLAGGED].sort());
    expect(st.closesAt).not.toBeNull();
    // a meeting-level addendum keeps the 14-day rule only
    expect(
      (
        await svc.createDisciplineNote(ORG_A, COORD, m, {
          discipline: "rn",
          bodyText: "meeting-level still ok",
          reason: "r",
        })
      ).isAddendum,
    ).toBe(true);
    // the newer meeting does not supersede ITSELF nor an EARLIER one: `m` is not newer than `newer`
    expect(
      (await svc.getMinutes(ORG_A, newer).catch(() => null))?.addendumState?.supersededPatientIds ??
        [],
    ).toEqual([]);
  });
  it("minutes header names degrade: a throwing / unbound site-display port never blocks adjourn and omits the names", async () => {
    const degraded = createDbIdgBackend(handle.db, outbox, undefined, {
      displayForSite: async () => {
        throw new Error("site port down");
      },
    });
    const m = await seedMeeting(ORG_A, "live");
    await degraded.recordAttendance(ORG_A, MEMBER, m, { membershipId: MEMBER, discipline: "rn" });
    expect((await degraded.adjournMeeting(ORG_A, MEMBER, m, true)).status).toBe("adjourned");
    const minutes = await degraded.getMinutes(ORG_A, m);
    const { rows } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m14.minutes.signed'",
      [minutes.id],
    );
    const meeting = rows[0].payload.renderPayload.meeting;
    expect(meeting.meetingId).toBe(m);
    expect(meeting.organizationName).toBeUndefined();
    expect(meeting.locationName).toBeUndefined();
    expect(rows[0].payload.renderPayload.decisionContent).toEqual([]);
  });

  it("attendance trust (0286): the recorder + attestation flag persist; a legacy write defaults to null/false and still counts toward quorum", async () => {
    const m = await seedMeeting(ORG_A, "live");
    const coordinator = await seedMembership(ORG_A, "active");
    const chaplain = await seedMembership(ORG_A, "active");
    const attested = await svc.recordAttendance(ORG_A, coordinator, m, {
      membershipId: chaplain,
      discipline: "chaplain",
      recordedByMembershipId: coordinator,
      disciplineAttested: true,
    });
    expect(attested).toMatchObject({
      recordedByMembershipId: coordinator,
      disciplineAttested: true,
    });
    const legacy = await svc.recordAttendance(ORG_A, coordinator, m, {
      membershipId: coordinator,
      discipline: "msw",
    });
    expect(legacy).toMatchObject({ recordedByMembershipId: null, disciplineAttested: false });
    const { rows } = await admin.query(
      "SELECT discipline, recorded_by_membership_id, discipline_attested FROM idg_attendance WHERE idg_meeting_id=$1 ORDER BY discipline",
      [m],
    );
    expect(rows).toEqual([
      {
        discipline: "chaplain",
        recorded_by_membership_id: coordinator,
        discipline_attested: true,
      },
      { discipline: "msw", recorded_by_membership_id: null, discipline_attested: false },
    ]);
    // The roster read surfaces the flag; the quorum present-set is unchanged (attested + legacy rows both count).
    const roster = await svc.listAttendance(ORG_A, m);
    expect(roster.map((r) => [r.discipline, r.disciplineAttested])).toEqual([
      ["chaplain", true],
      ["msw", false],
    ]);
    expect((await svc.loadPresentDisciplines(ORG_A, m))?.slice().sort()).toEqual([
      "chaplain",
      "msw",
    ]);
  });

  it("membershipRoleKeysForOrg (M3 seam, as wardenx_app): live enabled+unexpired role keys only; unknown / revoked / cross-tenant are ABSENT", async () => {
    const mk = async (org: string, key: string, enabled = true): Promise<string> =>
      (
        await admin.query(
          `INSERT INTO role (organization_id, key, name, category, scope_level, enabled)
           VALUES ($1,$2,$2,'clinical_staff','organization',$3) RETURNING id`,
          [org, key, enabled],
        )
      ).rows[0].id as string;
    const grant = (org: string, membership: string, role: string, expires: string | null) =>
      admin.query(
        `INSERT INTO membership_role (organization_id, membership_id, role_id, expires_at) VALUES ($1,$2,$3,$4)`,
        [org, membership, role, expires],
      );
    const rn = await mk(ORG_A, "rn_seam");
    const chaplain = await mk(ORG_A, "chaplain_seam");
    const disabled = await mk(ORG_A, "msw_seam", false);
    const expired = await mk(ORG_A, "np_seam");
    const otherOrgRole = await mk(ORG_B, "rn_seam");
    const staff = await seedMembership(ORG_A, "active");
    const bare = await seedMembership(ORG_A, "active");
    const revoked = await seedMembership(ORG_A, "revoked");
    const foreign = await seedMembership(ORG_B, "active");
    await grant(ORG_A, staff, rn, null);
    await grant(ORG_A, staff, chaplain, "2999-01-01T00:00:00Z");
    await grant(ORG_A, staff, disabled, null);
    await grant(ORG_A, staff, expired, "2000-01-01T00:00:00Z");
    await grant(ORG_A, revoked, rn, null);
    await grant(ORG_B, foreign, otherOrgRole, null);

    const got = await membershipRoleKeysForOrg(handle.db, ORG_A, [
      staff,
      bare,
      revoked,
      foreign,
      randomUUID(),
    ]);
    expect(got.get(staff)).toEqual(["chaplain_seam", "rn_seam"]);
    expect(got.get(bare)).toEqual([]);
    expect(got.has(revoked)).toBe(false);
    expect(got.has(foreign)).toBe(false);
    expect(got.size).toBe(2);
    expect((await membershipRoleKeysForOrg(handle.db, ORG_A, [])).size).toBe(0);
  });
});
