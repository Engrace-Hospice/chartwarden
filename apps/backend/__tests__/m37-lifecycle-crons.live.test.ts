/**
 * Batch 11 (GAP-105 follow-up) — M37's five lifecycle crons, the IRC resumption carry-over, and the RN-coverage
 * alert payloads, proven against real Postgres as the NOBYPASSRLS `chartwarden_app` role: reservation-expiry-
 * watchdog, equipment-inspection-watchdog, nursing-note-shift-watchdog, transfer-completion-watchdog and
 * postclose-settlement-sweep.
 *
 * Rows are seeded as the superuser; every cron runs through the real `withOrgContext` on the app-role
 * connection with a CATALOG-VALIDATING outbox (the F-080 lesson: a no-op outbox skips the payload check that
 * fails in production). Org A and org B get the SAME shape of data, so an isolation failure is visible as a
 * count. The data deliberately holds TWO rows that differ in the fact a query joins on (two transfers with
 * different start times, two settled admissions of different ages): the Drizzle single-FROM trap — a
 * correlated subquery whose column refs render unqualified and bind to the INNER table — would return the
 * wrong row's value for one of them, and these assertions read each row's OWN value.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m37:lifecycle:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { createDbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/events-by-m37";
import { runRnCoverageWatchdogCron } from "../src/modules/37-ipu/jobs/cron-workers";
import {
  runEquipmentInspectionWatchdogCron,
  runNursingNoteShiftWatchdogCron,
  runPostCloseSettlementSweepCron,
  runReservationExpiryWatchdogCron,
  runTransferCompletionWatchdogCron,
} from "../src/modules/37-ipu/jobs/lifecycle-workers";
import { runIrcCapWatchdogCron } from "../src/modules/37-ipu/jobs/watchdog-workers";
import { openIrcEpisodeRow } from "../src/modules/37-ipu/routes/irc-episode-open";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const PE = "66666666-6666-4666-8666-666666666666";
const MEMBER = "44444444-4444-4444-8444-444444444444";
const ALICE = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BOB = "bbbbbbbb-0000-4000-8000-0000000000b1";
/** 2026-10-05T12:00Z = 08:00 EDT on 2026-10-05: tenant-local today is 2026-10-05. */
const NOW = new Date("2026-10-05T12:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const SCHEMAS = new Map<string, (typeof M37_OUTBOX_EVENTS)[number]["payloadSchema"]>(
  M37_OUTBOX_EVENTS.map((e) => [e.eventName, e.payloadSchema]),
);

interface Published {
  eventName: string;
  organizationId: string;
  payload: Record<string, unknown>;
}

describe.skipIf(!DB_URL)("M37 lifecycle crons — LIVE Postgres (batch 11)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const published: Published[] = [];
  const noteReads: { organizationId: string; patientId: string }[] = [];
  let seq = 0;

  const outbox = {
    publish: async (
      _tx: unknown,
      e: Published & { aggregateKind: string; aggregateId: string },
    ) => {
      const eventSchema = SCHEMAS.get(e.eventName);
      if (!eventSchema) throw new Error(`m37 event not in events-by-m37.ts: ${e.eventName}`);
      if (!Value.Check(eventSchema, e.payload)) {
        const details = [...Value.Errors(eventSchema, e.payload)].map(
          (x) => `${x.path}: ${x.message}`,
        );
        throw new Error(`payload_schema_violation ${e.eventName} — ${details.join("; ")}`);
      }
      published.push({
        eventName: e.eventName,
        organizationId: e.organizationId,
        payload: e.payload,
      });
    },
  };

  /** Patients that have a signed note by ALICE inside the seeded shift window (the others have none). */
  const notedPatients = new Set<string>();
  const signedEncounters = {
    signedEncountersForPatientSince: async (
      organizationId: string,
      patientId: string,
      _sinceIso: string,
    ) => {
      noteReads.push({ organizationId, patientId });
      return notedPatients.has(patientId)
        ? [{ signedAt: ago(6 * HOUR), signedByMembershipId: ALICE }]
        : [];
    },
  };

  const deps = (orgs: string[], now: Date = NOW) => ({
    connection: {} as never,
    db: handle.db,
    outbox,
    signedEncounters,
    activeOrgs: { listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })) },
    now: () => now,
  });
  const eventsOf = (name: string, org?: string) =>
    published.filter((p) => p.eventName === name && (org ? p.organizationId === org : true));

  const uuid = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const FACILITY = (org: string) =>
    org === ORG_A ? "77777777-7777-4777-8777-000000000001" : "77777777-7777-4777-8777-000000000002";

  async function seedUnit(org: string, facility: string = FACILITY(org)): Promise<string> {
    return (
      await admin.query(
        "INSERT INTO inpatient_unit (organization_id,facility_id,display_name,bed_count) VALUES ($1,$2,'U',8) RETURNING id",
        [org, facility],
      )
    ).rows[0].id;
  }

  async function seedAdmission(o: {
    org: string;
    unitId: string;
    kind?: "gip" | "irc";
    state: string;
    patient?: string;
    activatedAt?: string;
  }): Promise<{ id: string; patient: string }> {
    seq += 1;
    const patient = o.patient ?? uuid(1000 + seq);
    const id = (
      await admin.query(
        `INSERT INTO ipu_admission (organization_id,provider_entity_id,patient_id,admission_id,
           level_of_care_period_id,unit_id,kind,state,activated_at,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$2) RETURNING id`,
        [
          o.org,
          PE,
          patient,
          uuid(2000 + seq),
          uuid(3000 + seq),
          o.unitId,
          o.kind ?? "gip",
          o.state,
          o.activatedAt ?? null,
        ],
      )
    ).rows[0].id;
    return { id, patient };
  }

  async function seedBed(
    org: string,
    unitId: string,
    status: string,
    changedAt: string,
  ): Promise<string> {
    seq += 1;
    const room = (
      await admin.query(
        "INSERT INTO ipu_room (organization_id,unit_id,room_number,kind,bed_count) VALUES ($1,$2,$3,'private',1) RETURNING id",
        [org, unitId, `R${seq}`],
      )
    ).rows[0].id;
    return (
      await admin.query(
        `INSERT INTO ipu_bed (organization_id,room_id,unit_id,bed_label,cleaning_status,cleaning_status_changed_at)
         VALUES ($1,$2,$3,'A',$4,$5) RETURNING id`,
        [org, room, unitId, status, changedAt],
      )
    ).rows[0].id;
  }

  const assign = async (org: string, admissionId: string, bedId: string) =>
    (
      await admin.query(
        `INSERT INTO ipu_bed_assignment (organization_id,ipu_admission_id,bed_id,assigned_by)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [org, admissionId, bedId, MEMBER],
      )
    ).rows[0].id;

  const history = (org: string, admissionId: string, toState: string, at: string) =>
    admin.query(
      `INSERT INTO ipu_admission_state_history (organization_id,ipu_admission_id,to_state,at,by_membership_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [org, admissionId, toState, at, MEMBER],
    );

  const transition = (org: string, admissionId: string, initiatedAt: string) =>
    admin.query(
      `INSERT INTO ipu_admission_transition (organization_id,ipu_admission_id,kind,initiated_at,initiated_by)
       VALUES ($1,$2,'to_home',$3,$4)`,
      [org, admissionId, initiatedAt, MEMBER],
    );

  const equipment = (org: string, serial: string, dueDate: string, status = "active") =>
    admin
      .query(
        `INSERT INTO ipu_equipment (organization_id,serial_number,equipment_type,manufacturer,model_number,
           next_inspection_due_date,current_status)
         VALUES ($1,$2,'hospital_bed','Acme','M1',$3,$4) RETURNING id`,
        [org, serial, dueDate, status],
      )
      .then((r) => r.rows[0].id as string);

  const count = async (table: string, org: string) =>
    (await admin.query(`SELECT count(*)::int n FROM ${table} WHERE organization_id=$1`, [org]))
      .rows[0].n;

  const seeded: Record<string, string> = {};

  async function seedOrg(org: string, key: "A" | "B") {
    const unit = await seedUnit(org);
    seeded[`${key}.unit`] = unit;

    // ── reservations ──
    const waiting = await seedAdmission({ org, unitId: unit, state: "bed_assigned" });
    const bedExpired = await seedBed(org, unit, "reserved", ago(5 * HOUR));
    seeded[`${key}.assignExpired`] = await assign(org, waiting.id, bedExpired);
    seeded[`${key}.admWaiting`] = waiting.id;
    seeded[`${key}.bedExpired`] = bedExpired;
    const occupant = await seedAdmission({
      org,
      unitId: unit,
      state: "active",
      activatedAt: ago(30 * DAY),
    });
    const bedAnomaly = await seedBed(org, unit, "reserved", ago(9 * HOUR));
    await assign(org, occupant.id, bedAnomaly);
    seeded[`${key}.bedAnomaly`] = bedAnomaly;
    const fresh = await seedAdmission({ org, unitId: unit, state: "bed_assigned" });
    const bedFresh = await seedBed(org, unit, "reserved", ago(1 * HOUR));
    await assign(org, fresh.id, bedFresh);
    seeded[`${key}.bedFresh`] = bedFresh;
    seeded[`${key}.admFresh`] = fresh.id;
    seeded[`${key}.bedOrphan`] = await seedBed(org, unit, "reserved", ago(6 * HOUR));

    // ── equipment (today, tenant-local, is 2026-10-05) ──
    seeded[`${key}.eqDue14`] = await equipment(org, `${key}-due14`, "2026-10-19");
    await equipment(org, `${key}-quiet`, "2026-10-10"); // 5 days out: silent
    seeded[`${key}.eqOverdue1`] = await equipment(org, `${key}-over1`, "2026-10-04");
    seeded[`${key}.eqOverdue8`] = await equipment(org, `${key}-over8`, "2026-09-27");
    await equipment(org, `${key}-retired`, "2026-10-12", "retired"); // retired: never an alert subject

    // ── nursing notes: a shift that ended 40 minutes ago (grace ended 10 minutes ago), RN alice ──
    const shiftEnd = NOW.getTime() - 40 * MIN;
    // Its own unit, so only the patients seeded here are in scope of the shift.
    const nursingUnit = await seedUnit(
      org,
      org === ORG_A
        ? "77777777-7777-4777-8777-0000000000a2"
        : "77777777-7777-4777-8777-0000000000b2",
    );
    const shift = (
      await admin.query(
        `INSERT INTO ipu_shift (organization_id,unit_id,shift_start_at,shift_end_at,created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [
          org,
          nursingUnit,
          new Date(shiftEnd - 12 * HOUR).toISOString(),
          new Date(shiftEnd).toISOString(),
          MEMBER,
        ],
      )
    ).rows[0].id;
    seeded[`${key}.shift`] = shift;
    await admin.query(
      `INSERT INTO ipu_staff_assignment (organization_id,shift_id,membership_id,role,state)
       VALUES ($1,$2,$3,'rn','confirmed')`,
      [org, shift, ALICE],
    );
    const noted = await seedAdmission({
      org,
      unitId: nursingUnit,
      state: "active",
      activatedAt: ago(5 * DAY),
    });
    const unnoted = await seedAdmission({
      org,
      unitId: nursingUnit,
      state: "active",
      activatedAt: ago(5 * DAY),
    });
    notedPatients.add(noted.patient);
    seeded[`${key}.admUnnoted`] = unnoted.id;
    await seedAdmission({ org, unitId: nursingUnit, state: "active", activatedAt: ago(1 * HOUR) }); // mid-shift admit

    // ── transfers: two with DIFFERENT start times + one still inside its first hour ──
    const t1 = await seedAdmission({
      org,
      unitId: unit,
      state: "transferring",
      activatedAt: ago(9 * DAY),
    });
    const t2 = await seedAdmission({
      org,
      unitId: unit,
      state: "transferring",
      activatedAt: ago(9 * DAY),
    });
    const t3 = await seedAdmission({
      org,
      unitId: unit,
      state: "transferring",
      activatedAt: ago(9 * DAY),
    });
    seeded[`${key}.t1`] = t1.id;
    seeded[`${key}.t2`] = t2.id;
    seeded[`${key}.t3`] = t3.id;
    seeded[`${key}.t1At`] = ago(70 * MIN); // cycle 0
    seeded[`${key}.t2At`] = ago(60 * MIN + 6 * HOUR + 10 * MIN); // cycle 1
    await transition(org, t1.id, seeded[`${key}.t1At`]);
    await transition(org, t2.id, seeded[`${key}.t2At`]);
    await transition(org, t3.id, ago(30 * MIN)); // inside the hour: not flagged

    // ── post-close: ages 8d / 3d / ... so a mis-bound subquery changes the answer ──
    const d1 = await seedAdmission({ org, unitId: unit, state: "discharged" });
    await history(org, d1.id, "discharged", ago(8 * DAY));
    const d2 = await seedAdmission({ org, unitId: unit, state: "discharged" });
    await history(org, d2.id, "discharged", ago(3 * DAY));
    const d3 = await seedAdmission({ org, unitId: unit, state: "deceased" });
    await history(org, d3.id, "deceased", ago(9 * DAY));
    await bodyRelease(org, d3, "closed", ago(8 * DAY));
    const d4 = await seedAdmission({ org, unitId: unit, state: "deceased" });
    await history(org, d4.id, "deceased", ago(20 * DAY));
    await bodyRelease(org, d4, "released", null);
    const d5 = await seedAdmission({ org, unitId: unit, kind: "irc", state: "discharged" });
    await history(org, d5.id, "discharged", ago(9 * DAY));
    await admin.query(
      `INSERT INTO irc_episode (organization_id,ipu_admission_id,provider_entity_id,patient_id,started_at,expected_end_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [org, d5.id, PE, d5.patient, ago(20 * DAY), ago(15 * DAY)],
    );
    const d6 = await seedAdmission({ org, unitId: unit, state: "discharged" });
    await history(org, d6.id, "discharged", ago(9 * DAY));
    await admin.query(
      `INSERT INTO ipu_restraint_event (organization_id,ipu_admission_id,restraint_kind,restraint_justification_text,
         ordering_physician_id,ordering_order_id,applied_at,applied_by_membership_id,applied_step_up_assertion_id,
         reassessment_interval_minutes,state)
       VALUES ($1,$2,'soft_limb',$3,$4,$4,$5,$4,$4,15,'active')`,
      [org, d6.id, "x".repeat(120), MEMBER, ago(9 * DAY)],
    );
    const d7 = await seedAdmission({ org, unitId: unit, state: "transferred" });
    await history(org, d7.id, "transferred", ago(8 * DAY));
    Object.assign(seeded, {
      [`${key}.d1`]: d1.id,
      [`${key}.d2`]: d2.id,
      [`${key}.d3`]: d3.id,
      [`${key}.d4`]: d4.id,
      [`${key}.d5`]: d5.id,
      [`${key}.d6`]: d6.id,
      [`${key}.d7`]: d7.id,
    });
  }

  async function bodyRelease(
    org: string,
    adm: { id: string; patient: string },
    state: string,
    closedAt: string | null,
  ) {
    seq += 1;
    await admin.query(
      `INSERT INTO ipu_body_release (organization_id,ipu_admission_id,provider_entity_id,patient_id,death_event_id,
         pronouncing_physician_id,pronounced_at,state,closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [org, adm.id, PE, adm.patient, uuid(7000 + seq), MEMBER, ago(30 * DAY), state, closedAt],
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    for (const [id, slug] of [
      [ORG_A, "org-a"],
      [ORG_B, "org-b"],
    ]) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    }
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    await seedOrg(ORG_A, "A");
    await seedOrg(ORG_B, "B");
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  const status = async (id: string) =>
    (await admin.query("SELECT cleaning_status s FROM ipu_bed WHERE id=$1", [id])).rows[0].s;
  const admState = async (id: string) =>
    (await admin.query("SELECT state FROM ipu_admission WHERE id=$1", [id])).rows[0].state;

  it("reservation-expiry releases the lapsed hold and the orphan, steps the waiting admission back to bed_pending, and leaves the rest", async () => {
    await runReservationExpiryWatchdogCron(deps([ORG_A]));
    expect(await status(seeded["A.bedExpired"] as string)).toBe("ready");
    expect(await status(seeded["A.bedOrphan"] as string)).toBe("ready");
    expect(await admState(seeded["A.admWaiting"] as string)).toBe("bed_pending");
    const ended = (
      await admin.query("SELECT ended_at, unassign_reason FROM ipu_bed_assignment WHERE id=$1", [
        seeded["A.assignExpired"],
      ])
    ).rows[0];
    expect(ended.ended_at).not.toBeNull();
    expect(ended.unassign_reason).toBe("reservation_expired");
    const cleaning = await admin.query(
      "SELECT from_status, to_status FROM ipu_bed_cleaning_event WHERE bed_id=$1",
      [seeded["A.bedExpired"]],
    );
    expect(cleaning.rows).toEqual([{ from_status: "reserved", to_status: "ready" }]);
    const hist = await admin.query(
      "SELECT from_state, to_state FROM ipu_admission_state_history WHERE ipu_admission_id=$1",
      [seeded["A.admWaiting"]],
    );
    expect(hist.rows).toEqual([{ from_state: "bed_assigned", to_state: "bed_pending" }]);
    // untouched: a hold inside 4h, and a reserved bed whose assignment belongs to an ACTIVE admission
    expect(await status(seeded["A.bedFresh"] as string)).toBe("reserved");
    expect(await admState(seeded["A.admFresh"] as string)).toBe("bed_assigned");
    expect(await status(seeded["A.bedAnomaly"] as string)).toBe("reserved");

    const events = eventsOf("m37.bed.reservation_expired", ORG_A);
    expect(events.map((e) => e.payload.bedId).sort()).toEqual(
      [seeded["A.bedExpired"], seeded["A.bedOrphan"]].sort(),
    );
    // Re-run: a no-op (the beds are ready), no new event.
    await runReservationExpiryWatchdogCron(deps([ORG_A]));
    expect(eventsOf("m37.bed.reservation_expired", ORG_A)).toHaveLength(2);
  });

  it("equipment-inspection raises due at +14, overdue at +1 and +8 only; not 5 days out, not retired equipment", async () => {
    await runEquipmentInspectionWatchdogCron(deps([ORG_A]));
    const due = eventsOf("m37.equipment.inspection_due", ORG_A);
    expect(due).toHaveLength(1);
    expect(due[0]?.payload).toMatchObject({
      equipmentId: seeded["A.eqDue14"],
      daysUntilDue: 14,
      dueDate: "2026-10-19",
    });
    const overdue = eventsOf("m37.equipment.inspection_overdue", ORG_A);
    expect(overdue.map((e) => [e.payload.equipmentId, e.payload.daysOverdue]).sort()).toEqual(
      [
        [seeded["A.eqOverdue1"], 1],
        [seeded["A.eqOverdue8"], 8],
      ].sort(),
    );
    // A same-day re-run publishes the SAME keyed alerts (M36's correlation id dedupes) — never a new day count.
    await runEquipmentInspectionWatchdogCron(deps([ORG_A]));
    expect(
      eventsOf("m37.equipment.inspection_due", ORG_A).map((e) => e.payload.daysUntilDue),
    ).toEqual([14, 14]);
  });

  it("nursing-note-shift flags the patient with no note by the assigned RN — not the noted one, not the mid-shift admit", async () => {
    await runNursingNoteShiftWatchdogCron(deps([ORG_A]));
    const overdue = eventsOf("m37.nursing_note.shift_overdue", ORG_A);
    expect(overdue).toHaveLength(1);
    expect(overdue[0]?.payload).toMatchObject({
      ipuAdmissionId: seeded["A.admUnnoted"],
      shiftId: seeded["A.shift"],
    });
    // M8 was read through the seam, only for org A, once per candidate patient.
    expect(noteReads.length).toBeGreaterThan(0);
    expect(noteReads.every((r) => r.organizationId === ORG_A)).toBe(true);
  });

  it("nursing-note-shift fails LOUDLY when the M8 seam is unbound (never reads 'no notes')", async () => {
    await expect(
      runNursingNoteShiftWatchdogCron({ ...deps([ORG_A]), signedEncounters: undefined }),
    ).rejects.toThrow(/M37_WORKER_PORT_UNBOUND: signedEncounters/);
  });

  it("transfer-completion flags each unconfirmed transfer with ITS OWN start time and cycle (no inner-table null binding)", async () => {
    await runTransferCompletionWatchdogCron(deps([ORG_A]));
    const events = eventsOf("m37.ipu_admission.transfer_unconfirmed", ORG_A);
    const byAdmission = new Map(events.map((e) => [e.payload.ipuAdmissionId, e.payload]));
    expect([...byAdmission.keys()].sort()).toEqual([seeded["A.t1"], seeded["A.t2"]].sort());
    expect(new Date(byAdmission.get(seeded["A.t1"])?.initiatedAt as string).getTime()).toBe(
      new Date(seeded["A.t1At"] as string).getTime(),
    );
    expect(byAdmission.get(seeded["A.t1"])?.reminderCycle).toBe(0);
    expect(new Date(byAdmission.get(seeded["A.t2"])?.initiatedAt as string).getTime()).toBe(
      new Date(seeded["A.t2At"] as string).getTime(),
    );
    expect(byAdmission.get(seeded["A.t2"])?.reminderCycle).toBe(1);
    expect(byAdmission.has(seeded["A.t3"])).toBe(false); // inside its first hour
  });

  it("postclose-settlement closes exactly the T+7 admissions with no open child row, with a system history row", async () => {
    await runPostCloseSettlementSweepCron(deps([ORG_A]));
    expect(await admState(seeded["A.d1"] as string)).toBe("closed"); // discharged 8d ago
    expect(await admState(seeded["A.d7"] as string)).toBe("closed"); // transferred 8d ago
    expect(await admState(seeded["A.d3"] as string)).toBe("closed"); // deceased, body release closed 8d ago
    expect(await admState(seeded["A.d2"] as string)).toBe("discharged"); // only 3d
    expect(await admState(seeded["A.d4"] as string)).toBe("deceased"); // body release not closed
    expect(await admState(seeded["A.d5"] as string)).toBe("discharged"); // open IRC episode
    expect(await admState(seeded["A.d6"] as string)).toBe("discharged"); // active restraint
    const closed = (
      await admin.query("SELECT closed_at FROM ipu_admission WHERE id=$1", [seeded["A.d1"]])
    ).rows[0];
    expect(closed.closed_at).not.toBeNull();
    const events = eventsOf("m37.ipu_admission.closed", ORG_A);
    expect(events.map((e) => e.payload.ipuAdmissionId).sort()).toEqual(
      [seeded["A.d1"], seeded["A.d3"], seeded["A.d7"]].sort(),
    );
    const hist = await admin.query(
      "SELECT from_state,to_state,by_membership_id FROM ipu_admission_state_history WHERE ipu_admission_id=$1 AND to_state='closed'",
      [seeded["A.d1"]],
    );
    expect(hist.rows).toEqual([
      {
        from_state: "discharged",
        to_state: "closed",
        by_membership_id: "00000000-0000-0000-0000-000000000037",
      },
    ]);
    await runPostCloseSettlementSweepCron(deps([ORG_A]));
    expect(eventsOf("m37.ipu_admission.closed", ORG_A)).toHaveLength(3); // re-run: nothing new
  });

  it("CROSS-TENANT: sweeping org A touched nothing of org B's, as the app role", async () => {
    expect(published.every((p) => p.organizationId === ORG_A)).toBe(true);
    expect(await status(seeded["B.bedExpired"] as string)).toBe("reserved");
    expect(await admState(seeded["B.admWaiting"] as string)).toBe("bed_assigned");
    expect(await admState(seeded["B.d1"] as string)).toBe("discharged");
    expect(await count("ipu_admission_state_history", ORG_B)).toBe(7); // only its own seeded rows
    const visibleToB = await withOrgContext(
      handle.db,
      { organizationId: ORG_B, userId: "" },
      async (tx) => {
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.ipuBed)
          .where(sql`${schema.ipuBed.organizationId} = ${ORG_A}`);
        return row?.n ?? -1;
      },
    );
    expect(visibleToB).toBe(0);
  });

  it("org B then gets the same answers, and one org's failure does not stop the others", async () => {
    const before = published.length;
    await runReservationExpiryWatchdogCron(deps([ORG_B]));
    await runPostCloseSettlementSweepCron(deps([ORG_B]));
    expect(await status(seeded["B.bedExpired"] as string)).toBe("ready");
    expect(await admState(seeded["B.d1"] as string)).toBe("closed");
    expect(published.slice(before).every((p) => p.organizationId === ORG_B)).toBe(true);

    // Failure isolation: org A's publish throws; org B (enumerated after it) is still swept, and the tick
    // fails afterwards so BullMQ retries / dead-letters it.
    const failingForA = {
      ...deps([ORG_A, ORG_B]),
      outbox: {
        publish: async (
          tx: unknown,
          e: Published & { aggregateKind: string; aggregateId: string },
        ) => {
          if (e.organizationId === ORG_A) throw new Error("boom");
          await outbox.publish(tx, e);
        },
      },
    };
    const mid = eventsOf("m37.ipu_admission.transfer_unconfirmed", ORG_B).length;
    await expect(runTransferCompletionWatchdogCron(failingForA)).rejects.toThrow(/1 of 2 org/);
    expect(eventsOf("m37.ipu_admission.transfer_unconfirmed", ORG_B).length).toBe(mid + 2);
  });

  it("the rn-coverage watchdog's payloads pass the real catalog schemas (rn_uncovered + coverage_gap_projected)", async () => {
    // An empty unit: the current hour is uncovered AND a gap is projected. Both events go through the
    // catalog-validating outbox — with the old `hourAt` / `firstGapAt` schemas this tick threw.
    await runRnCoverageWatchdogCron(deps([ORG_A]));
    const uncovered = eventsOf("m37.shift.rn_uncovered", ORG_A);
    expect(uncovered.length).toBeGreaterThan(0);
    expect(uncovered[0]?.payload.hourStartAt).toBe("2026-10-05T12:00:00.000Z");
    expect(eventsOf("m37.shift.coverage_gap_projected", ORG_A).length).toBeGreaterThan(0);
  });

  describe("IRC resumption carry-over (§2.5), as the app role", () => {
    const open = (org: string, adm: { id: string; patient: string }, now: Date) =>
      withOrgContext(handle.db, { organizationId: org, userId: "" }, async (tx) =>
        openIrcEpisodeRow(tx as never, {
          organizationId: org,
          ipuAdmissionId: adm.id,
          providerEntityId: PE,
          patientId: adm.patient,
          now,
        }),
      );

    async function priorEpisode(
      org: string,
      patient: string,
      count: number,
      closedAgoDays: number,
    ): Promise<void> {
      const unit = seeded["A.unit"] as string;
      const prior = await seedAdmission({
        org,
        unitId: unit,
        kind: "irc",
        state: "discharged",
        patient,
      });
      await admin.query(
        `INSERT INTO irc_episode (organization_id,ipu_admission_id,provider_entity_id,patient_id,started_at,
           expected_end_at,consecutive_day_count,state,closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'closed',$8)`,
        [
          org,
          prior.id,
          PE,
          patient,
          ago((closedAgoDays + count) * DAY),
          ago(closedAgoDays * DAY),
          count,
          ago(closedAgoDays * DAY),
        ],
      );
    }

    it("a re-admission 5 days after a 3-day episode opens at day 4 (approaching), not day 1", async () => {
      const patient = uuid(8001);
      await priorEpisode(ORG_A, patient, 3, 5);
      const adm = await seedAdmission({
        org: ORG_A,
        unitId: seeded["A.unit"] as string,
        kind: "irc",
        state: "active",
        patient,
      });
      const opened = await open(ORG_A, adm, NOW);
      expect(opened).toMatchObject({
        consecutiveDayCount: 4,
        carriedOverDays: 3,
        state: "approaching_cap",
        event: "m37.irc_episode.cap_approaching",
      });
      const row = (
        await admin.query(
          "SELECT consecutive_day_count n, carried_over_days c, state FROM irc_episode WHERE id=$1",
          [opened.episodeId],
        )
      ).rows[0];
      expect(row).toEqual({ n: 4, c: 3, state: "approaching_cap" });
      seeded["irc.resumed"] = opened.episodeId;
    });

    it("the watchdog counts the inherited days: the NEXT local day breaches (day 5), not day 2", async () => {
      await runIrcCapWatchdogCron(deps([ORG_A], new Date(NOW.getTime() + DAY)));
      const row = (
        await admin.query("SELECT consecutive_day_count n, state FROM irc_episode WHERE id=$1", [
          seeded["irc.resumed"],
        ])
      ).rows[0];
      expect(row).toEqual({ n: 5, state: "breached" });
      expect(
        eventsOf("m37.irc_episode.cap_breached", ORG_A).some(
          (e) => e.payload.consecutiveDayCount === 5,
        ),
      ).toBe(true);
    });

    it("a prior episode closed MORE than 30 days ago does not carry over; one closed at day 4 opens breached", async () => {
      const stale = uuid(8002);
      await priorEpisode(ORG_A, stale, 4, 40);
      const a1 = await seedAdmission({
        org: ORG_A,
        unitId: seeded["A.unit"] as string,
        kind: "irc",
        state: "active",
        patient: stale,
      });
      expect(await open(ORG_A, a1, NOW)).toMatchObject({
        consecutiveDayCount: 1,
        carriedOverDays: 0,
        state: "active",
        event: null,
      });

      const near = uuid(8003);
      await priorEpisode(ORG_A, near, 4, 2);
      const a2 = await seedAdmission({
        org: ORG_A,
        unitId: seeded["A.unit"] as string,
        kind: "irc",
        state: "active",
        patient: near,
      });
      expect(await open(ORG_A, a2, NOW)).toMatchObject({
        consecutiveDayCount: 5,
        state: "breached",
        event: "m37.irc_episode.cap_breached",
      });
    });

    it("does not carry another PATIENT's or another ORG's episode history", async () => {
      const shared = uuid(8004);
      await priorEpisode(ORG_B, shared, 4, 2); // org B's closed episode for the same patient id
      const adm = await seedAdmission({
        org: ORG_A,
        unitId: seeded["A.unit"] as string,
        kind: "irc",
        state: "active",
        patient: shared,
      });
      expect(await open(ORG_A, adm, NOW)).toMatchObject({
        consecutiveDayCount: 1,
        carriedOverDays: 0,
      });
    });
  });
});
