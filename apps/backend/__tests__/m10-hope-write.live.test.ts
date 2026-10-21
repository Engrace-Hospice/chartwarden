/**
 * M10L — the Drizzle HOPE write lifecycle, proven against real Postgres.
 *
 * Drives the writes as the NOBYPASSRLS `chartwarden_app` role: record a draft (linked to its open schedule) ·
 * sign (server-authoritative J2051 verdict; the DB schedule-mark-completed trigger closes the schedule, a
 * fired trigger opens the SFV in the same tx) · correct (the append-only amendment whose insert fires the
 * DB supersede trigger and reuses the original's target_date) · SFV completion · schedule skip · submission
 * assemble/retry · summary-PDF request. Like the M7/M8/M9 write suites it binds the REAL catalog-validating
 * transactional publisher (buildBootOutboxCatalog([M10_OUTBOX_EVENTS]) → the caller's tx) and asserts the
 * `m10.hope.*` rows land in `outbox_event`. RLS is exercised end-to-end.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m10:write:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import type { LatestAssessment, ScaleType } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { importHopeSpec } from "../../../scripts/db/import-hope-spec";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import {
  createAdmissionStatusReader,
  createDrizzleAdmissionReaderStore,
} from "../src/modules/06-admission/index";
import {
  type HopeWriteOutboxPort,
  M10_OUTBOX_EVENTS,
  buildM10AdmissionWorkflowConsumer,
  createDbHopeBackend,
} from "../src/modules/10-hope/index";
import { answerHopeForSign } from "./_hope-sign-ready";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
/** J2051 fires at `moderate` or higher; `mild` does not. */
const TRIGGER_DATA = { J: { J2051: { entries: [{ symptomCode: "pain", severity: "moderate" }] } } };
const QUIET_DATA = { J: { J2051: { entries: [{ symptomCode: "pain", severity: "mild" }] } } };
/** An RFA-04 SFV payload whose J2053 re-rating completes the regulatory SFV branch on the admission. */
const SFV_DATA = {
  J: {
    J2053: {
      J2053A: "1",
      J2053B: "1",
      J2053C: "1",
      J2053D: "1",
      J2053E: "1",
      J2053F: "1",
      J2053G: "1",
      J2053H: "1",
    },
  },
};
/** Items the workflow writes (control / prefill / SFV reconciliation / sign) — the public answer API refuses them. */
const today = (): string => new Date().toISOString().slice(0, 10);

describe.skipIf(!DB_URL)("M10 HOPE write lifecycle — LIVE Postgres (M10L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbHopeBackend>;
  let liveNow = new Date("2026-06-01T00:00:00.000Z");
  const memberOf: Record<string, string> = {};
  const providerOf: Record<string, string> = {};
  const locationOf: Record<string, string> = {};
  let admSeq = 0x77000000;
  const nextAdmission = (): string => {
    admSeq += 1;
    return `77000000-0000-4000-8000-${admSeq.toString(16).padStart(12, "0")}`;
  };
  /**
   * The patient each seeded admission belongs to. `admission_patient_open_idx` allows ONE open admission
   * per (org, patient) (§2.3.1 no double-election), so every live admission gets its own patient.
   */
  const patientOf: Record<string, string> = {};
  /** A fresh admission id with a REAL active `admission` row behind it (M6's reader resolves it). */
  const admitted = async (org: string = ORG_A): Promise<string> => {
    const adm = nextAdmission();
    await seedAdmission(org, adm);
    return adm;
  };

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

  /** Seed an open schedule for (admission, rfa) as superuser; returns its id. */
  async function seedSchedule(
    org: string,
    admissionId: string,
    rfaKind = "01_admission",
    window: {
      opensAt?: string;
      closesAt?: string;
      lateDeadlineAt?: string;
      generatedBy?: string;
    } = {},
  ): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO hope_timepoint_schedule (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, rfa_kind, window_opens_at, window_closes_at, late_deadline_at, alert_cadence, generated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}'::jsonb,$10)
         RETURNING id`,
        [
          org,
          providerOf[org],
          locationOf[org],
          patientOf[admissionId] ?? PATIENT,
          admissionId,
          rfaKind,
          window.opensAt ?? new Date(Date.now() - 1_000).toISOString(),
          window.closesAt ?? new Date(Date.now() + 5 * 86_400_000).toISOString(),
          window.lateDeadlineAt ?? new Date(Date.now() + 10 * 86_400_000).toISOString(),
          window.generatedBy ?? "auto_admission",
        ],
      )
    ).rows[0].id as string;
  }

  async function seedAdmission(org: string, admissionId: string): Promise<void> {
    // Derive a distinct patient from the admission id (one open admission per patient — see patientOf).
    const patientId = `44444444-4444-4444-8444-${admissionId.slice(-12)}`;
    patientOf[admissionId] = patientId;
    // A real M5 patient: the HOPE admission prefill (A0220 admission date, A0500 name, …) reads it
    // through PatientHopeAdmissionPrefillReader, and those workflow-owned items gate sign readiness.
    await admin.query(
      `INSERT INTO patient (id, organization_id, provider_entity_id, location_id, mrn,
         legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
       VALUES ($1,$2,$3,$4,$5,'Test','Patient','1950-01-01','F','active')`,
      [patientId, org, providerOf[org], locationOf[org], `MRN-${patientId.slice(-12)}`],
    );
    await admin.query(
      `INSERT INTO admission (id, organization_id, provider_entity_id, location_id, patient_id,
         admitted_by_physician_id, status, admission_at, activated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active','2026-06-01'::date,'2026-06-01'::date)`,
      [admissionId, org, providerOf[org], locationOf[org], patientId, USER],
    );
  }

  /**
   * The seams production boot wires (src/index.ts → registerAdmissionSeams / registerPatientSeams) that
   * the HOPE write path reads: M6's AdmissionStatusReader (recordTimepoint resolves the admission's
   * patient/siting/admission date for the 01/02/03/05 RFAs; sign reads the siting for D8 findings) and
   * M5's HOPE-admission prefill readers (PatientHopeAdmissionPrefillReader / PatientAddressReader /
   * PatientCoverageReader). Both are bound to the SAME Drizzle adapters boot uses, over this suite's
   * NOBYPASSRLS app-role handle. Re-applied before every test because the D8 block resets the registry.
   */
  function registerBootSeams(): void {
    registerSeam(
      "AdmissionStatusReader",
      createAdmissionStatusReader(createDrizzleAdmissionReaderStore(handle.db)),
    );
    registerPatientSeams({ db: handle.db });
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await importHopeSpec({ databaseUrl: DB_URL });
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m10w@x.test')`, [USER]);
    for (const org of [ORG_A, ORG_B]) {
      memberOf[org] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, org],
        )
      ).rows[0].id as string;
      providerOf[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end,
                                        addresses, iqies_facility_id)
           VALUES ($1,$2,$3,$4,'enc','12-31',
                   '[{"line1":"1 St","city":"Town","state":"OR","postalCode":"97000"}]'::jsonb, $5) RETURNING id`,
          [
            org,
            `CCN-M10W-${org.slice(0, 4)}`,
            `M10W ${org.slice(0, 4)}`,
            `NPI-M10W-${org.slice(0, 4)}`,
            `FAC${org.slice(0, 4)}`,
          ],
        )
      ).rows[0].id as string;
      locationOf[org] = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerOf[org]],
        )
      ).rows[0].id as string;
    }
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M10_OUTBOX_EVENTS]));
    const outbox: HopeWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m10" }),
    };
    // GAP-015: the capture gate judges lateness on the SERVER clock. It defaults to a date before every
    // fixture window (so the gate reads each fixture's own `targetDate`, exactly as before); the GAP-015
    // cases below move it.
    svc = createDbHopeBackend(handle.db, outbox, () => liveNow);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(() => registerBootSeams());
  // Vendor configuration is stubbed per test (assembleSubmission); never let it leak past a failure.
  afterEach(() => vi.unstubAllEnvs());

  const recordArgs = (data: Record<string, unknown>) => ({
    rfaKind: "01_admission" as const,
    targetDate: new Date().toISOString(),
    authorDiscipline: "RN",
    data,
  });

  /** Patch canonical answers through the production route-service path (which emits on its tx). */
  async function patch(id: string, answers: Record<string, string>): Promise<void> {
    const ws = await svc.getAssessmentWorkspace(ORG_A, id);
    await svc.patchAssessmentAnswers(ORG_A, memberOf[ORG_A], id, {
      ifVersion: ws.assessment.version,
      changes: Object.entries(answers).map(([itemCode, value]) => ({
        itemCode,
        action: "set" as const,
        value,
      })),
    });
  }

  /** Complete a draft until sign-ready — shared helper (_hope-sign-ready.ts), incl. the A1005/A1010 checklists. */
  const answerForSign = (id: string, overrides: Record<string, string> = {}): Promise<void> =>
    answerHopeForSign(
      { svc, orgId: ORG_A, membershipId: memberOf[ORG_A]!, answerDate: today() },
      id,
      overrides,
    );

  it("M6 activation/discharge consumer materializes HOPE schedules idempotently", async () => {
    const adm = await admitted();
    const published: string[] = [];
    const consumer = buildM10AdmissionWorkflowConsumer({
      db: handle.db,
      outbox: {
        async publish(_tx, input) {
          published.push(`${input.eventName}:${input.payload.rfaKind as string}`);
        },
      },
      admissions: createAdmissionStatusReader(createDrizzleAdmissionReaderStore(handle.db)),
    });

    const activated = {
      id: "evt-activation-1",
      organizationId: ORG_A,
      eventType: "m6.admission.activated",
      payload: {
        admissionId: adm,
        patientId: patientOf[adm],
        activatedAt: "2026-06-01T12:00:00.000Z",
      },
    };
    await consumer.handle(activated);
    await consumer.handle(activated);

    let { rows } = await admin.query(
      "SELECT rfa_kind FROM hope_timepoint_schedule WHERE admission_id=$1 ORDER BY rfa_kind",
      [adm],
    );
    expect(rows.map((r) => r.rfa_kind)).toEqual(["01_admission", "02_huv1", "03_huv2"]);

    const discharged = {
      id: "evt-discharge-1",
      organizationId: ORG_A,
      eventType: "m6.admission.discharged",
      payload: { admissionId: adm, reason: "death", dischargeDate: "2026-06-20" },
    };
    await consumer.handle(discharged);
    await consumer.handle(discharged);
    rows = (
      await admin.query(
        "SELECT rfa_kind FROM hope_timepoint_schedule WHERE admission_id=$1 ORDER BY rfa_kind",
        [adm],
      )
    ).rows;
    expect(rows.map((r) => r.rfa_kind)).toEqual([
      "01_admission",
      "02_huv1",
      "03_huv2",
      "05_discharge",
    ]);
    expect(published).toEqual([
      "m10.hope.timepoint_scheduled:01_admission",
      "m10.hope.timepoint_scheduled:02_huv1",
      "m10.hope.timepoint_scheduled:03_huv2",
      "m10.hope.timepoint_scheduled:05_discharge",
    ]);
  });

  it("anchors the Admission window on the org-LOCAL activation day, not its UTC date", async () => {
    const adm = await admitted();
    // 23:30 on 2026-06-01 in America/Los_Angeles (the location's zone) is 06:30Z on 2026-06-02. The
    // window must open at that LOCAL day's midnight — anchoring on the UTC date opened it the next day,
    // after the patient had already been admitted.
    await admin.query("UPDATE admission SET activated_at = $2 WHERE id = $1", [
      adm,
      "2026-06-02T06:30:00.000Z",
    ]);
    const consumer = buildM10AdmissionWorkflowConsumer({
      db: handle.db,
      outbox: { async publish() {} },
      admissions: createAdmissionStatusReader(createDrizzleAdmissionReaderStore(handle.db)),
    });
    await consumer.handle({
      id: "evt-activation-late-evening",
      organizationId: ORG_A,
      eventType: "m6.admission.activated",
      payload: {
        admissionId: adm,
        patientId: patientOf[adm],
        activatedAt: "2026-06-02T06:30:00.000Z",
      },
    });
    const { rows } = await admin.query(
      `SELECT window_opens_at FROM hope_timepoint_schedule WHERE admission_id=$1 AND rfa_kind='01_admission'`,
      [adm],
    );
    expect(new Date(rows[0].window_opens_at).toISOString()).toBe("2026-06-01T07:00:00.000Z");
  });

  it("record → sign (no J2051) closes the linked schedule and emits timepoint_signed", async () => {
    const adm = await admitted();
    const sched = await seedSchedule(ORG_A, adm);
    const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
    expect(draft.status).toBe("draft");
    await answerForSign(draft.id); // J2050A defaults to "0" (no symptom impact) → no trigger
    const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
    expect(signed.status).toBe("signed");
    expect((await svc.getAssessment(ORG_A, draft.id)).j2051TriggerFired).toBe(false);
    // The AFTER-UPDATE trigger closed the schedule.
    const back = await svc.getSchedule(ORG_A, sched);
    expect(back.status).toBe("completed");
    expect(await eventsFor(draft.id)).toContain("m10.hope.timepoint_signed");
  });

  it("recordTimepoint enforces the linked schedule window and persists late capture facts", async () => {
    const beforeAdm = await admitted();
    await seedSchedule(ORG_A, beforeAdm, "01_admission", {
      opensAt: "2026-06-10T00:00:00.000Z",
      closesAt: "2026-06-14T23:59:59.999Z",
      lateDeadlineAt: "2026-06-21T23:59:59.999Z",
    });
    await expect(
      svc.recordTimepoint(ORG_A, memberOf[ORG_A], beforeAdm, {
        ...recordArgs(QUIET_DATA),
        targetDate: "2026-06-09T23:59:59.999Z",
      }),
    ).rejects.toMatchObject({ code: "M10_TIMEPOINT_NOT_OPEN", statusCode: 409 });

    const lateAdm = await admitted();
    await seedSchedule(ORG_A, lateAdm, "01_admission", {
      opensAt: "2026-06-10T00:00:00.000Z",
      closesAt: "2026-06-14T23:59:59.999Z",
      lateDeadlineAt: "2026-06-21T23:59:59.999Z",
    });
    await expect(
      svc.recordTimepoint(ORG_A, memberOf[ORG_A], lateAdm, {
        ...recordArgs(QUIET_DATA),
        targetDate: "2026-06-16T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "M10_LATE_REASON_REQUIRED", statusCode: 400 });

    const late = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], lateAdm, {
      ...recordArgs(QUIET_DATA),
      targetDate: "2026-06-16T12:00:00.000Z",
      lateCompletionReasonCode: "hospitalization",
    });
    expect(late.wasLate).toBe(true);
    const { rows } = await admin.query(
      "SELECT was_late, late_completion_reason_code FROM hope_assessment WHERE id=$1",
      [late.id],
    );
    expect(rows[0]).toMatchObject({
      was_late: true,
      late_completion_reason_code: "hospitalization",
    });
  });

  describe("GAP-015 — the capture gate judges the SERVER clock, not the client's targetDate", () => {
    const WINDOW = {
      opensAt: "2026-06-10T00:00:00.000Z",
      closesAt: "2026-06-14T23:59:59.999Z",
      lateDeadlineAt: "2026-06-21T23:59:59.999Z",
    };
    const IN_WINDOW_DATE = "2026-06-12T12:00:00.000Z";
    afterEach(() => {
      liveNow = new Date("2026-06-01T00:00:00.000Z");
    });

    it("a filer past the late deadline cannot send an in-window targetDate (409 M10_TIMEPOINT_EXPIRED)", async () => {
      const adm = await admitted();
      await seedSchedule(ORG_A, adm, "01_admission", WINDOW);
      liveNow = new Date("2026-06-30T12:00:00.000Z");
      await expect(
        svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, {
          ...recordArgs(QUIET_DATA),
          targetDate: IN_WINDOW_DATE,
          lateCompletionReasonCode: "pto",
        }),
      ).rejects.toMatchObject({ code: "M10_TIMEPOINT_EXPIRED", statusCode: 409 });
    });

    it("a filer in the grace span cannot get was_late=false: the reason is required and was_late is true", async () => {
      const adm = await admitted();
      await seedSchedule(ORG_A, adm, "01_admission", WINDOW);
      liveNow = new Date("2026-06-17T12:00:00.000Z");
      await expect(
        svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, {
          ...recordArgs(QUIET_DATA),
          targetDate: IN_WINDOW_DATE,
        }),
      ).rejects.toMatchObject({ code: "M10_LATE_REASON_REQUIRED" });
      const late = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, {
        ...recordArgs(QUIET_DATA),
        targetDate: IN_WINDOW_DATE,
        lateCompletionReasonCode: "hospitalization",
      });
      expect(late.wasLate).toBe(true);
    });

    it("an on-time write stays on time", async () => {
      const adm = await admitted();
      await seedSchedule(ORG_A, adm, "01_admission", WINDOW);
      liveNow = new Date("2026-06-13T12:00:00.000Z");
      const ok = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, {
        ...recordArgs(QUIET_DATA),
        targetDate: IN_WINDOW_DATE,
      });
      expect(ok.wasLate).toBe(false);
    });

    it("an admin override past the deadline writes a CRITICAL hope.late_deadline_override audit with the justification", async () => {
      const adm = await admitted();
      await seedSchedule(ORG_A, adm, "01_admission", WINDOW);
      liveNow = new Date("2026-06-30T12:00:00.000Z");
      const justification = "EHR outage during the window; approved by the compliance lead";
      const row = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, {
        ...recordArgs(QUIET_DATA),
        targetDate: IN_WINDOW_DATE,
        lateCompletionReasonCode: "admin_override",
        adminOverride: true,
        adminOverrideJustification: justification,
      });
      expect(row.wasLate).toBe(true);
      const audits = (
        await admin.query(
          "SELECT severity, context FROM audit_event WHERE event_type='hope.late_deadline_override' AND resource_id=$1",
          [row.id],
        )
      ).rows;
      expect(audits).toHaveLength(1);
      expect(audits[0].severity).toBe("critical");
      expect(audits[0].context).toMatchObject({ justification });
    });
  });

  // #48 (restored from the lost Aug 25–30 history) — the window a capture is gated against. Naming the
  // `scheduleId` makes the RFA-mismatch guard real, and an EXPIRED window is gated rather than read as
  // "unscheduled" (the recording path used to look at `open` rows only).
  it("recordTimepoint gates a named scheduleId (404 unknown, 409 RFA mismatch) and an EXPIRED window", async () => {
    const adm = await admitted();
    await expect(
      svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, {
        ...recordArgs(QUIET_DATA),
        scheduleId: "77000000-0000-4000-8000-0000000fffff",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const huv1 = await seedSchedule(ORG_A, adm, "02_huv1");
    await expect(
      svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, {
        ...recordArgs(QUIET_DATA),
        scheduleId: huv1,
      }),
    ).rejects.toMatchObject({ code: "M10_RFA_KIND_MISMATCH", statusCode: 409 });

    const expiredAdm = await admitted();
    const expired = await seedSchedule(ORG_A, expiredAdm, "01_admission", {
      opensAt: "2026-06-01T00:00:00.000Z",
      closesAt: "2026-06-05T23:59:59.999Z",
      lateDeadlineAt: "2026-06-12T23:59:59.999Z",
    });
    await admin.query("UPDATE hope_timepoint_schedule SET status='expired' WHERE id=$1", [expired]);
    await expect(
      svc.recordTimepoint(ORG_A, memberOf[ORG_A], expiredAdm, {
        ...recordArgs(QUIET_DATA),
        targetDate: "2026-06-20T12:00:00.000Z",
        lateCompletionReasonCode: "hospitalization",
      }),
    ).rejects.toMatchObject({ code: "M10_TIMEPOINT_EXPIRED", statusCode: 409 });
  });

  it("route 20 regenerate actually regenerates, idempotently (#48 — it used to be a count)", async () => {
    const adm = await admitted();
    const count = async () =>
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM hope_timepoint_schedule WHERE admission_id=$1",
          [adm],
        )
      ).rows[0].n as number;
    expect(await count()).toBe(0);
    const first = await svc.regenerateSchedules(ORG_A, adm);
    expect(first.scheduleCount).toBe(3);
    const second = await svc.regenerateSchedules(ORG_A, adm);
    expect(second.scheduleCount).toBe(3); // no duplicates
    expect(await count()).toBe(3);
  });

  it("a J2051 moderate answer opens the SFV; recordSfv completes it; the signed admission carries the trigger", async () => {
    // The SFV obligation now opens while the draft is ANSWERED (hope-sfv-service
    // reconcileTriggeringAssessment, on J2050/J2051 patch), and readiness refuses to sign a fired
    // trigger until the SFV's regulatory J2052/J2053 branch is complete — so the order is
    // answer → SFV open → RFA-04 completion → sign.
    const adm = await admitted();
    await seedSchedule(ORG_A, adm);
    const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(TRIGGER_DATA));
    await patch(draft.id, { J2050A: "1", J2050B: today(), J2051A: "2" }); // 2 = Moderate
    const { sfvs } = await svc.listSfv(ORG_A, "open");
    const sfv = sfvs.find((s) => s.triggeringAssessmentId === draft.id);
    expect(sfv).toBeDefined();
    expect(await eventsFor(sfv!.id)).toContain("m10.hope.sfv_created");
    // Complete the SFV with an RFA-04 row.
    const completion = await svc.recordSfv(ORG_A, memberOf[ORG_A], adm, {
      triggeringAssessmentId: draft.id,
      targetDate: new Date().toISOString(),
      authorDiscipline: "RN",
      data: SFV_DATA,
    });
    expect(completion.status).toBe("signed");
    const done = await svc.getSfv(ORG_A, sfv!.id);
    expect(done.status).toBe("completed");
    expect(await eventsFor(sfv!.id)).toContain("m10.hope.sfv_completed");
    // Now the admission record signs, carrying the server-authoritative trigger verdict.
    await answerForSign(draft.id);
    const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
    expect(signed.status).toBe("signed");
    const view = await svc.getAssessment(ORG_A, draft.id);
    expect(view.j2051TriggerFired).toBe(true);
    expect(view.j2051MaxSeverity).toBe("moderate");
    const events = await eventsFor(draft.id);
    expect(events).toContain("m10.hope.timepoint_signed");
    expect(events).toContain("m10.hope.j2051_trigger_fired");
  });

  // ── GAP-019 — the §D8 clinical-context snapshot + its compensating warning finding ───────────────
  //
  // The DB backend used to skip D8 entirely: `clinical_context_snapshot` was written only by a
  // CORRECTION copying the original's (always-null) value, so no production HOPE assessment has ever
  // carried the PPS/ESAS-r context D8 exists to preserve — and the spec's compensating control ("if no
  // PPS is on file at signing, the validator emits a warning-severity finding") did not exist either,
  // so the gap was invisible to compliance review rather than merely non-blocking.
  describe("D8 clinical-context snapshot at sign (GAP-019)", () => {
    /**
     * Register the M9 seam the sign path reads. `pps` null ⇒ the missing-PPS case. The M6
     * AdmissionStatusReader the finding's siting comes from is the real Drizzle reader registered by the
     * suite-level beforeEach (registerBootSeams) over the admission row `admitted()` seeds.
     */
    function seams(scores: { pps: number | null; esas_r: number | null } | "unavailable"): void {
      registerSeam("LatestAssessmentProvider", {
        latest: async () => {
          throw new Error("single-scale `latest` is not exercised by this suite");
        },
        linkSummary: async () => {
          throw new Error("`linkSummary` is not exercised by this suite");
        },
        // (#211, restored) The M9 seam publishes the WHOLE `LatestAssessment`, not the two fields M10
        // reads off it; a `{ scaleType, score }` fake satisfies nothing but its own consumer.
        latestBatch: async (_patientId: string, scaleTypes: readonly ScaleType[]) => {
          if (scores === "unavailable") throw new Error("M9 seam unavailable");
          return scaleTypes.flatMap<LatestAssessment>((scaleType) => {
            const score = scores[scaleType as "pps" | "esas_r"];
            if (score === null) return [];
            return [
              {
                assessmentId: `assess-${scaleType}`,
                patientId: PATIENT,
                admissionId: "adm-1",
                scaleType,
                scaleVersion: "1",
                score,
                scoreInterpretation: null,
                capturedAt: "2026-01-05T00:00:00.000Z",
                capture: {
                  capturedByMembershipId: "mem-1",
                  capturedByDiscipline: "rn",
                  providerEntityId: "pe-1",
                  locationId: "loc-1",
                },
                sourceEncounterId: null,
                cosignRequired: false,
                cosignedAt: null,
                status: "active",
                redacted: false,
              } as LatestAssessment,
            ];
          });
        },
      });
    }

    async function d8Findings(assessmentId: string): Promise<Array<{ severity: string }>> {
      const { rows } = await admin.query(
        "SELECT severity, rule_id, message FROM hope_validation_finding WHERE hope_assessment_id=$1 AND rule_id=$2",
        [assessmentId, "D8_CLINICAL_CONTEXT_PPS_MISSING"],
      );
      return rows;
    }

    afterEach(() => __resetSeamsForTest());

    it("snapshots PPS + ESAS-r onto the signed row, and writes NO warning finding", async () => {
      seams({ pps: 60, esas_r: 4 });
      const adm = await admitted();
      await seedSchedule(ORG_A, adm);
      const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
      await answerForSign(draft.id);
      await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
      expect((await svc.getAssessment(ORG_A, draft.id)).snapshot).toEqual({ pps: 60, esas_r: 4 });
      expect(await d8Findings(draft.id)).toHaveLength(0);
    });

    it("records the snapshot AND a warning finding when no PPS is on file", async () => {
      // "we looked and there was none" is a different fact from "we never looked", so the snapshot is
      // still written — with a null pps — beside the finding.
      seams({ pps: null, esas_r: 7 });
      const adm = await admitted();
      await seedSchedule(ORG_A, adm);
      const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
      await answerForSign(draft.id);
      const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
      expect(signed.status).toBe("signed"); // §7.13 — never blocking
      expect((await svc.getAssessment(ORG_A, draft.id)).snapshot).toEqual({ pps: null, esas_r: 7 });
      const findings = await d8Findings(draft.id);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe("warning");
    });

    it("still signs, and still records the finding, when the M9 seam cannot be reached at all", async () => {
      seams("unavailable");
      const adm = await admitted();
      await seedSchedule(ORG_A, adm);
      const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
      await answerForSign(draft.id);
      const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
      expect(signed.status).toBe("signed");
      expect((await svc.getAssessment(ORG_A, draft.id)).snapshot).toBeNull();
      expect(await d8Findings(draft.id)).toHaveLength(1);
    });

    it("with no seams registered at all the signature still succeeds (the old behaviour, unblocked)", async () => {
      const adm = await admitted();
      await seedSchedule(ORG_A, adm);
      // Recording a 01_admission draft REQUIRES the M6 seam (recordTimepoint resolves the admission's
      // patient/siting/admission date through it) and its prefill reads M5, so the draft is recorded and
      // answered with the boot seams in place; the registry is then emptied so the SIGN path — the
      // subject of this test — runs with none at all.
      const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
      await answerForSign(draft.id);
      __resetSeamsForTest();
      const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
      expect(signed.status).toBe("signed");
      expect((await svc.getAssessment(ORG_A, draft.id)).snapshot).toBeNull();
      // The finding row needs the NOT NULL siting the M6 seam supplies, so it cannot be written here —
      // the service logs that instead of dropping it silently.
      expect(await d8Findings(draft.id)).toHaveLength(0);
    });
  });

  it("a signed correction supersedes the original (DB trigger), reuses target_date, emits correction_submitted", async () => {
    const adm = await admitted();
    await seedSchedule(ORG_A, adm);
    const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
    await answerForSign(draft.id);
    await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
    const signed = await svc.getAssessment(ORG_A, draft.id);
    const corrected = await svc.correctTimepoint(ORG_A, memberOf[ORG_A], signed.id, {
      correctionReason: "corrected section J after re-review",
      targetDate: new Date(Date.now() + 86_400_000).toISOString(), // ignored — the FK reuses the original's
      authorDiscipline: "RN",
      data: TRIGGER_DATA,
    });
    expect(corrected.correctsAssessmentId).toBe(signed.id);
    expect(corrected.targetDate).toBe(signed.targetDate); // composite self-FK forces the reuse
    expect(await eventsFor(corrected.id)).toContain("m10.hope.correction_submitted");
    // Migration 0225: a DRAFT correction must not supersede the source record — only its signature does.
    expect((await svc.getAssessment(ORG_A, signed.id)).status).toBe("signed");
    // Sign the correction with a substantive change (sign refuses NO_REGULATORY_CHANGES otherwise).
    await answerForSign(corrected.id, { A1400A: "0", A1400B: "1" }); // payer: Medicare → Medicaid
    await svc.signTimepoint(ORG_A, memberOf[ORG_A], corrected.id);
    const original = await svc.getAssessment(ORG_A, signed.id);
    expect(original.status).toBe("superseded");
    expect(original.supersededByAssessmentId).toBe(corrected.id);
    // Correcting the now-superseded original is refused (409).
    await expect(
      svc.correctTimepoint(ORG_A, memberOf[ORG_A], signed.id, {
        correctionReason: "second attempt on a superseded row",
        targetDate: new Date().toISOString(),
        authorDiscipline: "RN",
        data: QUIET_DATA,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("updateDraft merges into a draft; a signed row cannot be edited (409) and cannot correct a draft (409)", async () => {
    const adm = await admitted();
    await seedSchedule(ORG_A, adm);
    const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
    const updated = await svc.updateDraft(ORG_A, draft.id, { A: { A1: "x" } });
    expect(updated.status).toBe("draft");
    // Correcting a draft (not signed) is refused.
    await expect(
      svc.correctTimepoint(ORG_A, memberOf[ORG_A], draft.id, {
        correctionReason: "cannot correct a draft",
        targetDate: new Date().toISOString(),
        authorDiscipline: "RN",
        data: QUIET_DATA,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await answerForSign(draft.id);
    await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id);
    await expect(svc.updateDraft(ORG_A, draft.id, { A: { A1: "y" } })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("skipSchedule marks the schedule skipped", async () => {
    const adm = await admitted();
    const sched = await seedSchedule(ORG_A, adm);
    const skipped = await svc.skipSchedule(ORG_A, sched, "patient_declined");
    expect(skipped.status).toBe("skipped");
  });

  it("assembleSubmission queues a submission; retry is refused unless the submission is rejected", async () => {
    // The CMS submission header (the spec's Control items) is computed at package time from the
    // provider entity (FAC_ID, STATE_CD), the software-vendor configuration (SFTWR_*), the frozen spec
    // (ASMT_SYS_CD, ITM_SET_VRSN_CD, SPEC_VRSN_CD), the record's ISC and its correction chain.
    // Setup gaps refuse with a 422 naming what to set, and package nothing.
    vi.stubEnv("CHARTWARDEN_SOFTWARE_VENDOR_ID", "");
    await expect(svc.assembleSubmission(ORG_A, providerOf[ORG_A])).rejects.toMatchObject({
      statusCode: 422,
      details: [expect.objectContaining({ code: "WX-HOPE-SUBMISSION-VENDOR-CONFIG" })],
    });
    await admin.query("UPDATE provider_entity SET iqies_facility_id = NULL WHERE id=$1", [
      providerOf[ORG_A],
    ]);
    vi.stubEnv("CHARTWARDEN_SOFTWARE_VENDOR_ID", "12-3456789");
    vi.stubEnv("CHARTWARDEN_SOFTWARE_VENDOR_NAME", "ChartWarden Test Vendor");
    vi.stubEnv("CHARTWARDEN_SOFTWARE_VENDOR_EMAIL", "hope@vendor.test");
    vi.stubEnv("APP_VERSION", "2026.9.26");
    await expect(svc.assembleSubmission(ORG_A, providerOf[ORG_A])).rejects.toMatchObject({
      statusCode: 422,
      details: [expect.objectContaining({ code: "WX-HOPE-SUBMISSION-FACILITY-ID" })],
    });
    await admin.query("UPDATE provider_entity SET iqies_facility_id = $2 WHERE id=$1", [
      providerOf[ORG_A],
      `FAC${ORG_A.slice(0, 4)}`,
    ]);
    const { rows: noPackages } = await admin.query(
      "SELECT count(*)::int AS n FROM hope_submission WHERE organization_id=$1 AND status='packaged'",
      [ORG_A],
    );
    expect(noPackages[0].n).toBe(0);
    const assembled = await svc.assembleSubmission(ORG_A, providerOf[ORG_A]);
    vi.unstubAllEnvs();
    // The manual-iQIES-upload transport builds the XML package in the same tx: the row lands
    // `packaged` (package + per-assessment items written), still announced as submission_queued.
    expect(assembled.status).toBe("packaged");
    const { rows: packagedItems } = await admin.query(
      "SELECT count(*)::int AS n FROM hope_submission_item WHERE hope_submission_id=$1",
      [assembled.id],
    );
    expect(packagedItems[0].n).toBeGreaterThan(0);
    const { rows: xmlRows } = await admin.query(
      `SELECT i.iqies_validation_result->>'xmlContentBase64' AS b64, a.isc
         FROM hope_submission_item i JOIN hope_assessment a ON a.id = i.hope_assessment_id
        WHERE i.hope_submission_id=$1`,
      [assembled.id],
    );
    for (const { b64, isc } of xmlRows) {
      const xml = Buffer.from(b64, "base64").toString("utf8");
      const tag = (code: string) => new RegExp(`<${code}>([^<]*)</${code}>`).exec(xml)?.[1];
      expect(tag("ITM_SBST_CD")).toBe(isc);
      expect(tag("ASMT_SYS_CD")).toBe("HOPE");
      expect(tag("ITM_SET_VRSN_CD")).toBe("1.00");
      expect(tag("SPEC_VRSN_CD")).toBe("1.00");
      expect(tag("STATE_CD")).toBe("OR");
      expect(tag("FAC_ID")).toBe(`FAC${ORG_A.slice(0, 4)}`);
      expect(tag("SFTWR_VNDR_ID")).toBe("123456789");
      expect(tag("SFTWR_VNDR_NAME")).toBe("ChartWarden Test Vendor");
      expect(tag("SFTWR_VNDR_EMAIL_ADR")).toBe("hope@vendor.test");
      expect(tag("SFTWR_PROD_NAME")).toBe("ChartWarden");
      expect(tag("SFTWR_PROD_VRSN_CD")).toBe("2026.9.26");
      expect(tag("CRCTN_NUM")).toMatch(/^\d{2}$/);
    }
    expect(await eventsFor(assembled.id)).toContain("m10.hope.submission_queued");
    // A queued submission cannot be retried (409).
    await expect(svc.retrySubmission(ORG_A, assembled.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    // Seed a rejected submission → retry re-queues it.
    const rejected = (
      await admin.query(
        `INSERT INTO hope_submission (organization_id, provider_entity_id, submission_period, status, item_count)
         VALUES ($1,$2,'2026-06','rejected',3) RETURNING id`,
        [ORG_A, providerOf[ORG_A]],
      )
    ).rows[0].id as string;
    const requeued = await svc.retrySubmission(ORG_A, rejected);
    expect(requeued.status).toBe("queued");
  });

  it("requestSummaryPdf emits summary_requested for a real assessment", async () => {
    const adm = await admitted();
    await seedSchedule(ORG_A, adm);
    const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
    const res = await svc.requestSummaryPdf(ORG_A, memberOf[ORG_A], draft.id);
    expect(res).toEqual({ assessmentId: draft.id, requested: true });
    expect(await eventsFor(draft.id)).toContain("m10.hope.summary_requested");
    // F-099 (restored) — the chart target M22 files the render against rides on the payload.
    const { rows } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m10.hope.summary_requested'",
      [draft.id],
    );
    expect(rows[0].payload).toMatchObject({ patientId: patientOf[adm] });
  });

  it("the compliance dashboard reports null rates + counts, and a non-terminal batch is not a non-acceptance", async () => {
    // #48 / F-058 (restored) — a rate over an empty denominator is `null` (no data), never 1, and only
    // terminal batches (accepted / rejected / partially_accepted) enter the acceptance ratio.
    const before = await svc.complianceDashboard(ORG_B, providerOf[ORG_B]);
    expect(before.submissionAcceptanceRate).toBeNull();
    expect(before.submissionAcceptanceCounts).toEqual({ accepted: 0, total: 0 });
    await admin.query(
      `INSERT INTO hope_submission (organization_id, provider_entity_id, submission_period, status, item_count)
       VALUES ($1,$2,'2026-06','queued',1)`,
      [ORG_B, providerOf[ORG_B]],
    );
    const after = await svc.complianceDashboard(ORG_B, providerOf[ORG_B]);
    expect(after.submissionAcceptanceRate).toBeNull();
    expect(after.submissionAcceptanceCounts.total).toBe(0);
  });

  // ── #45 (restored) — migration 0217, the repair of rows the pre-fix record path already wrote ───────
  describe("#45 — migration 0217 repairs hope_assessment.patient_id rows already written", () => {
    const REPAIR_SQL = readFileSync(
      join(MIGRATIONS_DIR, "0217_m10_hope_patient_id_repair.sql"),
      "utf8",
    );
    /** Seed a real `admission` row (its patient_id is the truth the repair reads). */
    async function seedRepairAdmission(org: string, patientId: string): Promise<string> {
      return (
        await admin.query(
          `INSERT INTO admission (organization_id, provider_entity_id, location_id, patient_id,
             admitted_by_physician_id, status, admission_at)
           VALUES ($1,$2,$3,$4,$5,'active', now()) RETURNING id`,
          [org, providerOf[org], locationOf[org], patientId, USER],
        )
      ).rows[0].id as string;
    }
    /** Write the corrupt shape the pre-fix service produced: patient_id := admission_id. */
    async function seedCorruptAssessment(org: string, admissionId: string): Promise<string> {
      return (
        await admin.query(
          `INSERT INTO hope_assessment (organization_id, patient_id, admission_id, rfa_kind, status,
             data, target_date, created_by_membership_id)
           VALUES ($1,$2,$2,'01_admission','draft','{}'::jsonb, now(), $3) RETURNING id`,
          [org, admissionId, memberOf[org]],
        )
      ).rows[0].id as string;
    }

    it("repoints a corrupted assessment (and its SFV) at the admission's real patient", async () => {
      const realPatient = "44444444-0000-4000-8000-000000000045";
      const adm = await seedRepairAdmission(ORG_A, realPatient);
      const assessmentId = await seedCorruptAssessment(ORG_A, adm);
      await admin.query(
        `INSERT INTO symptom_follow_up_visit (organization_id, provider_entity_id, location_id,
           patient_id, admission_id, triggering_assessment_id, triggered_at, due_at, alert_cadence)
         VALUES ($1,$2,$3,$4,$4,$5, now(), now() + interval '2 days', '{}'::jsonb)`,
        [ORG_A, providerOf[ORG_A], locationOf[ORG_A], adm, assessmentId],
      );

      await admin.query(REPAIR_SQL);

      expect(
        (await admin.query("SELECT patient_id FROM hope_assessment WHERE id=$1", [assessmentId]))
          .rows[0].patient_id,
      ).toBe(realPatient);
      expect(
        (
          await admin.query(
            "SELECT patient_id FROM symptom_follow_up_visit WHERE triggering_assessment_id=$1",
            [assessmentId],
          )
        ).rows[0].patient_id,
      ).toBe(realPatient);
    });

    it("leaves a row whose admission cannot be resolved, and is a no-op on re-run", async () => {
      const orphanAdmission = "77000000-0000-4000-8000-0000000f0045";
      const orphanId = await seedCorruptAssessment(ORG_A, orphanAdmission);
      // Cross-org: the admission exists, but in ORG_B. The repair joins on organization_id too.
      const crossOrgAdmission = await seedRepairAdmission(
        ORG_B,
        "44444444-0000-4000-8000-0000000000b0",
      );
      const crossOrgId = await seedCorruptAssessment(ORG_A, crossOrgAdmission);

      await admin.query(REPAIR_SQL);
      expect(
        (await admin.query("SELECT patient_id FROM hope_assessment WHERE id=$1", [orphanId]))
          .rows[0].patient_id,
      ).toBe(orphanAdmission);
      expect(
        (await admin.query("SELECT patient_id FROM hope_assessment WHERE id=$1", [crossOrgId]))
          .rows[0].patient_id,
      ).toBe(crossOrgAdmission);

      // Re-running touches nothing: a repaired row can never match `patient_id = admission_id` again.
      const realPatient = "44444444-0000-4000-8000-000000000046";
      const adm = await seedRepairAdmission(ORG_A, realPatient);
      const repaired = await seedCorruptAssessment(ORG_A, adm);
      await admin.query(REPAIR_SQL);
      const before = (
        await admin.query("SELECT patient_id, updated_at FROM hope_assessment WHERE id=$1", [
          repaired,
        ])
      ).rows[0];
      await admin.query(REPAIR_SQL);
      const after = (
        await admin.query("SELECT patient_id, updated_at FROM hope_assessment WHERE id=$1", [
          repaired,
        ])
      ).rows[0];
      expect(after.patient_id).toBe(realPatient);
      expect(after.updated_at).toEqual(before.updated_at);
    });
  });

  it("RLS — org B cannot sign or correct org A's assessment (non-leaking 404)", async () => {
    const adm = await admitted();
    await seedSchedule(ORG_A, adm);
    const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
    await expect(svc.signTimepoint(ORG_B, memberOf[ORG_B], draft.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(svc.getAssessment(ORG_B, draft.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});
