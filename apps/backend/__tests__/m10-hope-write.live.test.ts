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
import type { AbacContext } from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { LatestAssessment, ScaleType } from "@chartwarden/types";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { importHopeSpec } from "../../../scripts/db/import-hope-spec";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { activeLegalHoldScopeInTransaction } from "../src/modules/04-audit/legal-hold-scope";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import {
  createAdmissionStatusReader,
  createDrizzleAdmissionReaderStore,
} from "../src/modules/06-admission/index";
import {
  type HopeWriteOutboxPort,
  M10_OUTBOX_EVENTS,
  buildHopeAbacPredicates,
  buildM10AdmissionWorkflowConsumer,
  createDbHopeBackend,
} from "../src/modules/10-hope/index";
import { busyWithin } from "./_hope-busy-within";
import { answerHopeForSign } from "./_hope-sign-ready";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "11111111-1111-1111-1111-111111111111";
// The acting membership a skip / regenerate hands the service for its audit event (no HTTP request in these tests).
const OPERATOR = { membershipId: "88888888-8888-4888-8888-888888888888" };
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
    // The cancel's byte purge reads the REAL M4 legal-hold scope on its own transaction, as the app role.
    svc = createDbHopeBackend(handle.db, outbox, () => liveNow, {
      activeLegalHoldScopeInTransaction: (tx, organizationId) =>
        activeLegalHoldScopeInTransaction(tx, organizationId),
    });
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
    const ws = await svc.getAssessmentWorkspace(ORG_A, id, { mayWrite: true });
    await svc.patchAssessmentAnswers(ORG_A, memberOf[ORG_A], id, {
      ifVersion: ws.assessment.version,
      changes: Object.entries(answers).map(([itemCode, value]) => ({
        itemCode,
        action: "set" as const,
        value,
      })),
    });
  }

  /**
   * The text of every statement a FRESH app-role backend sends while `run` executes. The spy goes on pg's Client
   * BEFORE the probe pool opens its connections: `createDbClient` binds each client's `query` when it connects, so a
   * spy installed after the suite's own pool is warm would never see its statements.
   */
  async function statementsDuring<T>(
    run: (backend: typeof svc) => Promise<T>,
    /** Runs just BEFORE each statement is sent (it can commit another transaction's write in between two reads). */
    beforeSend?: (text: string) => Promise<void>,
    /** Connections in the probe pool: concurrent calls need more than one, or they queue on the single connection. */
    poolSize = 1,
  ): Promise<{ out: T; sql: string[] }> {
    const sql: string[] = [];
    const original = Client.prototype.query;
    const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
      this: Client,
      ...args: unknown[]
    ) {
      const first = args[0] as string | { text?: string } | undefined;
      const text = typeof first === "string" ? first : (first?.text ?? "");
      sql.push(text);
      const send = () => (original as (...a: unknown[]) => unknown).apply(this, args);
      return beforeSend ? beforeSend(text).then(send) : send();
    } as never);
    const probe = createDbClient({ connectionString: appRoleUrl(DB_URL as string), max: poolSize });
    try {
      const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M10_OUTBOX_EVENTS]));
      const backend = createDbHopeBackend(
        probe.db,
        { publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m10" }) },
        () => liveNow,
      );
      return { out: await run(backend), sql };
    } finally {
      spy.mockRestore();
      await probe.close();
    }
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
    const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id, {
      attestationConfirmed: true,
    });
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

    it("an admin override past the deadline writes a CRITICAL hope.late_deadline_override audit with the request facts and the justification", async () => {
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
        request: {
          requestId: "req-override-1",
          correlationId: "client-trace-1",
          sourceIp: "203.0.113.9",
          userAgent: "agent\r\n/2.0",
        },
      });
      expect(row.wasLate).toBe(true);
      const audits = (
        await admin.query(
          "SELECT severity, context, correlation_id, request_id, source_ip, user_agent FROM audit_event WHERE event_type='hope.late_deadline_override' AND resource_id=$1",
          [row.id],
        )
      ).rows;
      expect(audits).toHaveLength(1);
      expect(audits[0].severity).toBe("critical");
      expect(audits[0]).toMatchObject({
        correlation_id: `hope-late-deadline-override:${row.id}`,
        request_id: "req-override-1",
        source_ip: "203.0.113.9",
        user_agent: "agent/2.0",
      });
      // The client's trace hint rides in the context beside the typed justification, the only record of why the cutoff was lifted.
      expect(audits[0].context).toMatchObject({
        clientCorrelationId: "client-trace-1",
        justification,
      });
      expect(audits[0].context).not.toHaveProperty("justificationSupplied");
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
    const first = await svc.regenerateSchedules(ORG_A, adm, OPERATOR);
    expect(first.scheduleCount).toBe(3);
    const second = await svc.regenerateSchedules(ORG_A, adm, OPERATOR);
    expect(second.scheduleCount).toBe(3); // no duplicates
    expect(await count()).toBe(3);
  });

  it("#883 persists actor-bound attribution for same-discipline, clinical-lead and legacy inactivations", async () => {
    const adm = await admitted();
    await seedSchedule(ORG_A, adm);
    const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
    expect(draft.authorDiscipline).toBe("RN");
    expect(
      (await admin.query("SELECT author_discipline FROM hope_assessment WHERE id=$1", [draft.id]))
        .rows[0].author_discipline,
    ).toBe("RN");

    const predicate = buildHopeAbacPredicates({
      resolver: svc,
      isInCaseload: async () => true,
    })["hope.authorDisciplineAllowed"]!;
    const context = (roles: readonly string[]): AbacContext =>
      ({
        organizationId: ORG_A,
        userId: USER,
        roles,
        attributes: { membershipId: memberOf[ORG_A] },
        providerEntityIds: [],
        locationIds: [],
        permissions: new Set<string>(),
      }) as unknown as AbacContext;
    const target = { id: draft.id };
    expect(await predicate(context(["rn"]), target)).toBe(true);
    expect(await predicate(context(["np"]), target)).toBe(false);

    await answerForSign(draft.id);
    await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id, { attestationConfirmed: true });
    const inactivation = await svc.inactivateTimepoint(ORG_A, memberOf[ORG_A], draft.id, {
      reason: "recorded against the wrong chart",
      authorDiscipline: "RN",
    });
    expect(inactivation.authorDiscipline).toBe("RN");
    expect(
      (
        await admin.query("SELECT author_discipline FROM hope_assessment WHERE id=$1", [
          inactivation.id,
        ])
      ).rows[0].author_discipline,
    ).toBe("RN");
    expect(await predicate(context(["rn"]), { id: inactivation.id })).toBe(true);
    expect(await predicate(context(["np"]), { id: inactivation.id })).toBe(false);

    const crossDisciplineAdmission = await admitted();
    await seedSchedule(ORG_A, crossDisciplineAdmission);
    const crossDisciplineOriginal = await svc.recordTimepoint(
      ORG_A,
      memberOf[ORG_A],
      crossDisciplineAdmission,
      recordArgs(QUIET_DATA),
    );
    await answerForSign(crossDisciplineOriginal.id);
    await svc.signTimepoint(ORG_A, memberOf[ORG_A], crossDisciplineOriginal.id, {
      attestationConfirmed: true,
    });
    const crossDisciplineInactivation = await svc.inactivateTimepoint(
      ORG_A,
      memberOf[ORG_A],
      crossDisciplineOriginal.id,
      {
        reason: "clinical lead inactivation",
        authorDiscipline: "NP",
      },
    );
    expect(crossDisciplineInactivation.authorDiscipline).toBe("NP");
    expect(
      (
        await admin.query("SELECT author_discipline FROM hope_assessment WHERE id=$1", [
          crossDisciplineInactivation.id,
        ])
      ).rows[0].author_discipline,
    ).toBe("NP");
    expect(await predicate(context(["np"]), { id: crossDisciplineInactivation.id })).toBe(true);
    expect(await predicate(context(["rn"]), { id: crossDisciplineInactivation.id })).toBe(false);

    const legacyAdmission = await admitted();
    await seedSchedule(ORG_A, legacyAdmission);
    const legacyOriginal = await svc.recordTimepoint(
      ORG_A,
      memberOf[ORG_A],
      legacyAdmission,
      recordArgs(QUIET_DATA),
    );
    await answerForSign(legacyOriginal.id);
    await svc.signTimepoint(ORG_A, memberOf[ORG_A], legacyOriginal.id, {
      attestationConfirmed: true,
    });
    await admin.query("UPDATE hope_assessment SET author_discipline=NULL WHERE id=$1", [
      legacyOriginal.id,
    ]);
    const legacyInactivation = await svc.inactivateTimepoint(
      ORG_A,
      memberOf[ORG_A],
      legacyOriginal.id,
      {
        reason: "legacy attribution repair",
        authorDiscipline: "NP",
      },
    );
    expect(legacyInactivation.authorDiscipline).toBe("NP");
    expect(
      (
        await admin.query("SELECT author_discipline FROM hope_assessment WHERE id=$1", [
          legacyInactivation.id,
        ])
      ).rows[0].author_discipline,
    ).toBe("NP");
    expect(await predicate(context(["np"]), { id: legacyInactivation.id })).toBe(true);
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
      attestationConfirmed: true,
    });
    expect(completion.status).toBe("signed");
    // #850 — the ABAC resolver sees the RFA kind of the stored row, so the SFV author rule (LPN/LVN) can
    // govern an SFV's correction draft; a cross-tenant id resolves to nothing (fail closed).
    const sfvFacts = await svc.loadAssessment(ORG_A, completion.id);
    expect(sfvFacts?.rfaKind).toBe("04_sfv");
    expect(await svc.loadAssessment(ORG_B, completion.id)).toBeNull();
    const done = await svc.getSfv(ORG_A, sfv!.id);
    expect(done.status).toBe("completed");
    expect(await eventsFor(sfv!.id)).toContain("m10.hope.sfv_completed");
    // Now the admission record signs, carrying the server-authoritative trigger verdict.
    await answerForSign(draft.id);
    const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id, {
      attestationConfirmed: true,
    });
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
      await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id, { attestationConfirmed: true });
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
      const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id, {
        attestationConfirmed: true,
      });
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
      const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id, {
        attestationConfirmed: true,
      });
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
      const signed = await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id, {
        attestationConfirmed: true,
      });
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
    await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id, { attestationConfirmed: true });
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
    await svc.signTimepoint(ORG_A, memberOf[ORG_A], corrected.id, { attestationConfirmed: true });
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
    await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id, { attestationConfirmed: true });
    await expect(svc.updateDraft(ORG_A, draft.id, { A: { A1: "y" } })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("recording a timepoint whose target date predates every loaded spec is a typed 422 (M10_SPEC_NOT_IN_FORCE), not a 500, and records no assessment", async () => {
    const adm = await admitted();
    await seedSchedule(ORG_A, adm);

    const failure = await svc
      .recordTimepoint(ORG_A, memberOf[ORG_A], adm, {
        ...recordArgs(QUIET_DATA),
        targetDate: "2025-09-30T12:00:00.000Z", // the first loaded spec is in force from 2025-10-01
      })
      .catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: "M10_SPEC_NOT_IN_FORCE", statusCode: 422 });
    expect(String((failure as Error).message)).not.toContain("2025-09-30");
    expect(
      (await admin.query("SELECT 1 FROM hope_assessment WHERE admission_id=$1", [adm])).rows,
    ).toEqual([]);
  });

  describe("lock discipline — locked re-judging, bounded waits, serialised check-then-insert", () => {
    const outcome = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: { code?: string; statusCode?: number }) => `${e.statusCode}:${e.code ?? "OTHER"}`,
      );
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    /** A second connection holding the assessment row lock, as a concurrent writer would. */
    async function holdAssessment(id: string): Promise<Client> {
      const holder = new Client({ connectionString: DB_URL });
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM hope_assessment WHERE id=$1 FOR UPDATE", [id]);
      return holder;
    }
    /** Wait until the statement under test is parked in a lock wait whose SQL names `table` (quoted). */
    async function awaitBlockedOn(table: string): Promise<void> {
      for (let i = 0; i < 100; i += 1) {
        const { rows } = await admin.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock' AND query ILIKE $1`,
          [`%"${table}"%`],
        );
        if (rows.length > 0) return;
        await sleep(50);
      }
      throw new Error(`no statement ever became blocked on a ${table} lock`);
    }
    async function freshDraft(): Promise<string> {
      const adm = await admitted();
      await seedSchedule(ORG_A, adm);
      return (await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA))).id;
    }
    const patchInput = (version: number) => ({
      ifVersion: version,
      changes: [
        { itemCode: "J2050A", action: "set" as const, value: "1" },
        { itemCode: "J2050B", action: "set" as const, value: today() },
        { itemCode: "J2051A", action: "set" as const, value: "2" },
      ],
    });

    it("updateDraft parked behind a sign refuses on the locked row and never rewrites the signed record", async () => {
      const id = await freshDraft();
      const before = (await admin.query("SELECT data FROM hope_assessment WHERE id=$1", [id]))
        .rows[0].data;
      const holder = await holdAssessment(id);
      try {
        const edit = outcome(svc.updateDraft(ORG_A, id, { A: { A1: "rewritten after sign" } }));
        await awaitBlockedOn("hope_assessment");
        await holder.query(
          "UPDATE hope_assessment SET status='signed', signed_at=now(), signed_by_membership_id=$2, version=version+1 WHERE id=$1",
          [id, memberOf[ORG_A]],
        );
        await holder.query("COMMIT");
        expect(await edit).toBe("409:M10_CORRECTION_TARGET_NOT_SIGNED");
        const after = (
          await admin.query("SELECT data, status FROM hope_assessment WHERE id=$1", [id])
        ).rows[0];
        expect(after.status).toBe("signed");
        expect(after.data).toEqual(before);
      } finally {
        await holder.end();
      }
    });

    it("updateDraft is scoped to its own organization", async () => {
      const id = await freshDraft();
      await expect(svc.updateDraft(ORG_B, id, { A: { A1: "x" } })).rejects.toMatchObject({
        statusCode: 404,
      });
      const row = (await admin.query("SELECT data FROM hope_assessment WHERE id=$1", [id])).rows[0];
      expect(JSON.stringify(row.data)).not.toContain('"A1":"x"');
    });

    it("a patch behind a long-held assessment lock answers a retryable 409 instead of waiting for the lock", async () => {
      const id = await freshDraft();
      const ws = await svc.getAssessmentWorkspace(ORG_A, id, { mayWrite: true });
      const holder = await holdAssessment(id);
      try {
        // The holder never lets go during the call, so an unbounded wait would hang here; the 409 IS the proof that the wait ended.
        const result = await outcome(
          svc.patchAssessmentAnswers(ORG_A, memberOf[ORG_A], id, patchInput(ws.assessment.version)),
        );
        expect(result).toBe("409:M10_RECORD_BUSY");
      } finally {
        await holder.query("ROLLBACK");
        await holder.end();
      }
      // The refused patch left the version as it was, and the record is usable again once the lock is free.
      const reopened = await svc.getAssessmentWorkspace(ORG_A, id, { mayWrite: true });
      expect(reopened.assessment.version).toBe(ws.assessment.version);
      await svc.patchAssessmentAnswers(
        ORG_A,
        memberOf[ORG_A],
        id,
        patchInput(reopened.assessment.version),
      );
    }, 30_000);

    it("a patch naming a protected or unknown item is refused BEFORE it queues for the assessment lock", async () => {
      const id = await freshDraft();
      const ws = await svc.getAssessmentWorkspace(ORG_A, id, { mayWrite: true });
      const holder = await holdAssessment(id);
      try {
        for (const [itemCode, status] of [
          ["A0050", 403],
          ["ZZ9999", 404],
        ] as const) {
          const refused = svc.patchAssessmentAnswers(ORG_A, memberOf[ORG_A], id, {
            ifVersion: ws.assessment.version,
            changes: [{ itemCode, action: "set", value: "1" }],
          });
          // A patch that queued for the held lock would end as the busy 409 after the lock timeout, never as this 403 / 404.
          await expect(refused).rejects.toMatchObject({ statusCode: status });
        }
      } finally {
        await holder.query("ROLLBACK");
        await holder.end();
      }
    });

    it("opening an already-reconciled draft's workspace takes no assessment lock", async () => {
      const id = await freshDraft();
      await svc.getAssessmentWorkspace(ORG_A, id, { mayWrite: true }); // reconciles the workflow control answers once
      const holder = await holdAssessment(id);
      try {
        // A workspace read that queued for the held lock would end as the busy 409 after the lock timeout, not resolve.
        await expect(
          svc.getAssessmentWorkspace(ORG_A, id, { mayWrite: true }),
        ).resolves.toBeTruthy();
      } finally {
        await holder.query("ROLLBACK");
        await holder.end();
      }
    });

    it("a workspace open that rewrites a chart-derived answer bumps the version (a stale signer is refused); one that changes nothing, or a read-only one, does not", async () => {
      const id = await freshDraft();
      const first = await svc.getAssessmentWorkspace(ORG_A, id, { mayWrite: true });
      const patientId = (
        await admin.query("SELECT patient_id FROM hope_assessment WHERE id=$1", [id])
      ).rows[0].patient_id as string;
      const storedLastName = async () =>
        (
          await admin.query(
            `SELECT a.value #>> '{}' AS value FROM hope_assessment_answer a
             JOIN hope_spec_item i ON i.id = a.spec_item_id
             WHERE a.hope_assessment_id=$1 AND i.item_code='A0500C'`,
            [id],
          )
        ).rows[0]?.value as string | undefined;
      const renameChartPatient = (name: string) =>
        admin.query("UPDATE patient SET legal_last_name=$2 WHERE id=$1", [patientId, name]);

      // The chart did not move: a re-open writes nothing and keeps the version everyone's `ifVersion` names.
      const unchanged = await svc.getAssessmentWorkspace(ORG_A, id, { mayWrite: true });
      expect(unchanged.assessment.version).toBe(first.assessment.version);

      // A caller without hope.timepoint.write is shown the STORED state: the chart's new value is not written.
      await renameChartPatient("Renamed-One");
      const readOnly = await svc.getAssessmentWorkspace(ORG_A, id, { mayWrite: false });
      expect(readOnly.assessment.version).toBe(first.assessment.version);
      expect(await storedLastName()).toBe("Patient");

      // A writer's open rewrites the chart-derived answer, in the same transaction as the version bump.
      const reopened = await svc.getAssessmentWorkspace(ORG_A, id, { mayWrite: true });
      expect(await storedLastName()).toBe("Renamed-One");
      expect(reopened.assessment.version).toBe(first.assessment.version + 1);

      // The reviewer who loaded the older version can no longer patch or sign what the chart rewrote under them.
      await expect(
        svc.patchAssessmentAnswers(
          ORG_A,
          memberOf[ORG_A],
          id,
          patchInput(first.assessment.version),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        svc.signTimepoint(ORG_A, memberOf[ORG_A], id, {
          ifVersion: first.assessment.version,
          attestationConfirmed: true,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      // ...and the version the open returned is the one to act on.
      await svc.patchAssessmentAnswers(
        ORG_A,
        memberOf[ORG_A],
        id,
        patchInput(reopened.assessment.version),
      );
    });

    it("re-recording a timepoint whose draft exists bumps the version when the chart rewrote an answer and answers that version; an unchanged chart, and the first fill, keep it", async () => {
      const adm = await admitted();
      await seedSchedule(ORG_A, adm);
      const record = () => svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
      const storedVersion = async (id: string) =>
        (await admin.query("SELECT version FROM hope_assessment WHERE id=$1", [id])).rows[0]
          .version as number;
      const storedLastName = async (id: string) =>
        (
          await admin.query(
            `SELECT a.value #>> '{}' AS value FROM hope_assessment_answer a
             JOIN hope_spec_item i ON i.id = a.spec_item_id
             WHERE a.hope_assessment_id=$1 AND i.item_code='A0500C'`,
            [id],
          )
        ).rows[0]?.value as string | undefined;

      // The first fill of a brand-new record: version 1 (a bump would 409 the first patch of whoever opens it).
      const first = await record();
      expect(first.version).toBe(1);
      expect(await storedVersion(first.id)).toBe(1);

      // The chart did not move: the same draft, the same version, nothing written.
      const unchanged = await record();
      expect(unchanged.id).toBe(first.id);
      expect(unchanged.version).toBe(1);
      expect(await storedVersion(first.id)).toBe(1);

      // The chart moved: the re-record rewrites the chart-derived answer, bumps the version in that transaction, and its
      // answer carries the bumped version (not the row it read before the prefill).
      await admin.query("UPDATE patient SET legal_last_name=$2 WHERE id=$1", [
        patientOf[adm],
        "Renamed-Rerecord",
      ]);
      const reRecorded = await record();
      expect(reRecorded.id).toBe(first.id);
      expect(await storedLastName(first.id)).toBe("Renamed-Rerecord");
      expect(await storedVersion(first.id)).toBe(2);
      expect(reRecorded.version).toBe(2);

      // The reviewer who loaded version 1 can no longer sign what the chart rewrote under them...
      await expect(
        svc.signTimepoint(ORG_A, memberOf[ORG_A], first.id, {
          ifVersion: first.version,
          attestationConfirmed: true,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      // ...and the version the re-record answered is the one to act on.
      await svc.patchAssessmentAnswers(
        ORG_A,
        memberOf[ORG_A],
        first.id,
        patchInput(reRecorded.version),
      );
    });

    it("a lock that waited out a partition move retries on the moved row instead of failing 40001", async () => {
      const id = await freshDraft();
      const ws = await svc.getAssessmentWorkspace(ORG_A, id, { mayWrite: true });
      const holder = await holdAssessment(id);
      try {
        const patched = outcome(
          svc.patchAssessmentAnswers(ORG_A, memberOf[ORG_A], id, patchInput(ws.assessment.version)),
        );
        await awaitBlockedOn("hope_assessment");
        // What setHuvCompletionDate does to the row: a new target month moves it to another partition (delete + insert).
        await holder.query(
          "UPDATE hope_assessment SET target_date = target_date + interval '1 month' WHERE id=$1",
          [id],
        );
        await holder.query("COMMIT");
        expect(await patched).toBeNull();
        const row = (await admin.query("SELECT version FROM hope_assessment WHERE id=$1", [id]))
          .rows[0];
        expect(row.version).toBe(ws.assessment.version + 1);
      } finally {
        await holder.end();
      }
    }, 30_000);

    it("a legacy spec-less draft's spec initialisation commits BEFORE the workspace prefill starts (its row lock is not held across the seam calls)", async () => {
      const id = await freshDraft();
      await admin.query(
        "UPDATE hope_assessment SET spec_version_id = NULL, isc = NULL WHERE id=$1",
        [id],
      );

      const { sql } = await statementsDuring((b) =>
        b.getAssessmentWorkspace(ORG_A, id, { mayWrite: true }),
      );

      const init = sql.findIndex((text) => /^update "hope_assessment"/i.test(text.trim()));
      expect(init).toBeGreaterThanOrEqual(0);
      // The prefill's first statement reads the spec version's code; the init transaction must have committed before it.
      const prefill = sql.findIndex(
        (text, i) => i > init && /from "hope_spec_version"/i.test(text) && /"code"/i.test(text),
      );
      const commitBetween = sql.findIndex(
        (text, i) => i > init && (prefill < 0 || i < prefill) && /^commit/i.test(text.trim()),
      );
      expect(prefill).toBeGreaterThan(init);
      expect(commitBetween).toBeGreaterThan(init);
    });

    it("a read-only caller opening a legacy spec-less draft is answered a 409 and writes nothing, in the workspace and the review; a writer's open then freezes the spec", async () => {
      const id = await freshDraft();
      await admin.query(
        "UPDATE hope_assessment SET spec_version_id = NULL, isc = NULL WHERE id=$1",
        [id],
      );
      const snapshot = async () => ({
        row: (
          await admin.query(
            "SELECT version, updated_at, spec_version_id, isc FROM hope_assessment WHERE id=$1",
            [id],
          )
        ).rows[0],
        answers: (
          await admin.query(
            "SELECT count(*)::int AS n FROM hope_assessment_answer WHERE hope_assessment_id=$1",
            [id],
          )
        ).rows[0].n,
      });
      const before = await snapshot();
      expect(before.row.spec_version_id).toBeNull();

      const readOnly = { mayWrite: false };
      expect(await outcome(svc.getAssessmentWorkspace(ORG_A, id, readOnly))).toBe("409:CONFLICT");
      expect(await outcome(svc.getAssessmentReview(ORG_A, id, readOnly))).toBe("409:CONFLICT");
      // Neither the assessment row (spec, ISC, version, updated_at) nor its derived control answers were written.
      expect(await snapshot()).toEqual(before);

      // A caller who can edit opens it once: that freezes the spec, and then a read-only caller reads it as any draft.
      await svc.getAssessmentWorkspace(ORG_A, id, { mayWrite: true });
      expect((await snapshot()).row.spec_version_id).not.toBeNull();
      expect(await outcome(svc.getAssessmentWorkspace(ORG_A, id, readOnly))).toBeNull();
      expect(await outcome(svc.getAssessmentReview(ORG_A, id, readOnly))).toBeNull();
    });

    it("a read-only caller's workspace and validation reads store nothing: no control answer is rewritten and no validation finding is reconciled", async () => {
      const id = await freshDraft();
      await svc.getAssessmentWorkspace(ORG_A, id, { mayWrite: true }); // a writer's first open writes the workflow-control answers
      const controlAnswers = () =>
        admin
          .query(
            `SELECT count(*)::int AS n FROM hope_assessment_answer a
               JOIN hope_spec_item i ON i.id = a.spec_item_id
              WHERE a.hope_assessment_id=$1 AND i.item_code IN ('A0050','A0250')`,
            [id],
          )
          .then((r) => r.rows[0].n as number);
      const findings = () =>
        admin
          .query(
            "SELECT count(*)::int AS n FROM hope_validation_finding WHERE hope_assessment_id=$1",
            [id],
          )
          .then((r) => r.rows[0].n as number);
      expect(await controlAnswers()).toBe(2);
      // Make the controls out of date (the state a read-only open must leave alone).
      await admin.query(
        `DELETE FROM hope_assessment_answer a USING hope_spec_item i
          WHERE a.spec_item_id = i.id AND a.hope_assessment_id=$1 AND i.item_code IN ('A0050','A0250')`,
        [id],
      );
      expect(await controlAnswers()).toBe(0);
      const findingsBefore = await findings();

      const readOnly = { mayWrite: false };
      await svc.getAssessmentWorkspace(ORG_A, id, readOnly);
      await svc.getValidation(ORG_A, id, { mode: "final", ...readOnly });

      expect(await controlAnswers()).toBe(0);
      expect(await findings()).toBe(findingsBefore);
      // Not vacuous: the same open by a writer restores the control answers and stores the findings.
      await svc.getAssessmentWorkspace(ORG_A, id, { mayWrite: true });
      await svc.getValidation(ORG_A, id, { mayWrite: true, mode: "final" });
      expect(await controlAnswers()).toBe(2);
      expect(await findings()).toBeGreaterThan(findingsBefore);
    });

    it("a sign behind a long-held assessment lock answers a retryable 409 instead of waiting for the lock and leaves the draft a draft", async () => {
      const id = await freshDraft();
      const before = (
        await admin.query("SELECT status, version FROM hope_assessment WHERE id=$1", [id])
      ).rows[0];
      const holder = await holdAssessment(id);

      const result = await busyWithin(
        svc.signTimepoint(ORG_A, memberOf[ORG_A], id, { attestationConfirmed: true }),
        holder,
      );

      expect(result).toBe("409:M10_RECORD_BUSY");
      const after = (
        await admin.query("SELECT status, version FROM hope_assessment WHERE id=$1", [id])
      ).rows[0];
      expect(after).toEqual(before);
    }, 30_000);

    it("a sign that was waiting on a row that moved partition (a HUV completion date) retries once on the moved row instead of failing 40001", async () => {
      // A draft that is NOT sign-ready: a sign that gets past its lock on the moved row then stops at the readiness check
      // (a typed 422) and rolls back, so this test leaves no signed record behind for the tests that follow it.
      const id = await freshDraft();
      const holder = await holdAssessment(id);
      try {
        const signing = outcome(
          svc.signTimepoint(ORG_A, memberOf[ORG_A], id, { attestationConfirmed: true }),
        );
        await awaitBlockedOn("hope_assessment");
        // What setHuvCompletionDate does to the row: a new target month moves it to another partition (delete + insert).
        await holder.query(
          "UPDATE hope_assessment SET target_date = target_date + interval '1 month' WHERE id=$1",
          [id],
        );
        await holder.query("COMMIT");

        // Before the retry this was the raw `40001` (no typed code); now the lock finds the moved row and the sign judges it.
        expect(await signing).toBe("422:VALIDATION_FAILED");
      } finally {
        await holder.end();
      }
      expect(
        (await admin.query("SELECT status FROM hope_assessment WHERE id=$1", [id])).rows[0].status,
      ).toBe("draft");
    }, 30_000);

    it("opening a legacy spec-less draft behind a long-held assessment lock answers the same retryable 409 (its spec-freezing UPDATE is bounded too)", async () => {
      const id = await freshDraft();
      await admin.query(
        "UPDATE hope_assessment SET spec_version_id = NULL, isc = NULL WHERE id=$1",
        [id],
      );
      const holder = await holdAssessment(id);

      const result = await busyWithin(
        svc.getAssessmentWorkspace(ORG_A, id, { mayWrite: true }),
        holder,
      );

      expect(result).toBe("409:M10_RECORD_BUSY");
      const row = (
        await admin.query("SELECT spec_version_id FROM hope_assessment WHERE id=$1", [id])
      ).rows[0];
      expect(row.spec_version_id).toBeNull(); // the spec was not frozen: the refused read left that column as it was
    }, 30_000);

    it("two concurrent records of the same admission RFA converge on ONE draft", async () => {
      const adm = await admitted();
      await seedSchedule(ORG_A, adm);
      let delayed = false;
      const slowFirstInsert = async (text: string): Promise<void> => {
        if (delayed || !/insert into "hope_assessment" /i.test(text)) return;
        delayed = true;
        await sleep(600); // the other call's existing-draft read lands in this window
      };
      const { out } = await statementsDuring(
        (b) =>
          Promise.all([
            b.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA)),
            b.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA)),
          ]),
        slowFirstInsert,
        4,
      );
      expect(out[0].id).toBe(out[1].id);
      const { rows } = await admin.query(
        "SELECT id FROM hope_assessment WHERE admission_id=$1 AND rfa_kind='01_admission' AND status='draft'",
        [adm],
      );
      expect(rows).toHaveLength(1);
    });

    it("two concurrent corrections of one signed record leave ONE pending correction", async () => {
      const id = await freshDraft();
      // The final validator's section-presence check reads `hope_assessment.data` (see seedSignedAssessment below).
      const sections = Object.fromEntries(
        ["A", "B", "C", "D", "E", "F", "G", "H", "I", "K", "M", "N", "O", "Q", "X", "Z"].map(
          (s) => [s, { presentForValidation: true }],
        ),
      );
      await admin.query("UPDATE hope_assessment SET data = data || $2::jsonb WHERE id=$1", [
        id,
        JSON.stringify(sections),
      ]);
      await answerForSign(id);
      await svc.signTimepoint(ORG_A, memberOf[ORG_A], id, { attestationConfirmed: true });
      const correct = (b: typeof svc) =>
        outcome(
          b.correctTimepoint(ORG_A, memberOf[ORG_A], id, {
            correctionReason: "concurrent correction",
            targetDate: new Date().toISOString(),
            authorDiscipline: "RN",
            data: QUIET_DATA,
          }),
        );
      let delayed = false;
      const slowFirstInsert = async (text: string): Promise<void> => {
        if (delayed || !/insert into "hope_assessment" /i.test(text)) return;
        delayed = true;
        await sleep(600);
      };
      const { out } = await statementsDuring(
        (b) => Promise.all([correct(b), correct(b)]),
        slowFirstInsert,
        4,
      );
      // One created the correction; the other saw it pending and was refused.
      expect(out.filter((code) => code === null)).toHaveLength(1);
      expect(out.filter((code) => code === "409:CONFLICT")).toHaveLength(1);
      const { rows } = await admin.query(
        "SELECT id FROM hope_assessment WHERE corrects_assessment_id=$1 AND status='draft'",
        [id],
      );
      expect(rows).toHaveLength(1);
    }, 30_000);
  });

  it("skipSchedule marks the schedule skipped", async () => {
    const adm = await admitted();
    const sched = await seedSchedule(ORG_A, adm);
    const skipped = await svc.skipSchedule(ORG_A, sched, "other", OPERATOR);
    expect(skipped.status).toBe("skipped");
    const { rows } = await admin.query(
      "SELECT skip_reason_code FROM hope_timepoint_schedule WHERE id=$1",
      [sched],
    );
    expect(rows[0].skip_reason_code).toBe("other");
  });

  it("skipSchedule refuses a reason that is not on the closed list (422, nothing sent to the database to change)", async () => {
    const adm = await admitted();
    const sched = await seedSchedule(ORG_A, adm);
    await expect(
      svc.skipSchedule(ORG_A, sched, "typed by the clinician", OPERATOR),
    ).rejects.toMatchObject({
      statusCode: 422,
    });
    const { rows } = await admin.query(
      "SELECT status, skip_reason_code FROM hope_timepoint_schedule WHERE id=$1",
      [sched],
    );
    expect(rows[0]).toMatchObject({ status: "open", skip_reason_code: null });
  });

  // The tenant predicate is explicit on every write, on top of RLS. RLS cannot show that: the owner connection below
  // bypasses it, so only the statements' own `organization_id` predicate stands between ORG_B and ORG_A's rows.
  it("another tenant's id finds nothing on a connection that bypasses RLS: skip, retry, mark-uploaded, cancel, download, the result import and the batch list", async () => {
    const adm = await admitted();
    const sched = await seedSchedule(ORG_A, adm);
    const insertSubmission = async (status: string): Promise<string> =>
      (
        await admin.query(
          `INSERT INTO hope_submission (organization_id, provider_entity_id, submission_period, status, item_count)
           VALUES ($1,$2,'2026-07',$3,1) RETURNING id`,
          [ORG_A, providerOf[ORG_A], status],
        )
      ).rows[0].id as string;
    const rejected = await insertSubmission("rejected");
    const packaged = await insertSubmission("packaged");
    const exported = await insertSubmission("exported");
    // The later assemble test starts from "no package exists": these rows are removed again, pass or fail.
    try {
      const owner = createDbClient({ connectionString: DB_URL as string });
      try {
        const backend = createDbHopeBackend(
          owner.db,
          { publish: async () => undefined },
          () => liveNow,
        );
        const asOrgB = memberOf[ORG_B] as string;
        const statusCode = (p: Promise<unknown>) =>
          p.then(
            () => null,
            (e: { statusCode?: number }) => e.statusCode,
          );
        expect(await statusCode(backend.skipSchedule(ORG_B, sched, "other", OPERATOR))).toBe(404);
        expect(await statusCode(backend.retrySubmission(ORG_B, rejected))).toBe(404);
        expect(await statusCode(backend.markSubmissionUploaded(ORG_B, asOrgB, packaged, {}))).toBe(
          404,
        );
        expect(
          await statusCode(
            backend.cancelSubmission(ORG_B, asOrgB, packaged, { reasonCode: "other" }),
          ),
        ).toBe(404);
        expect(await statusCode(backend.downloadSubmissionPackage(ORG_B, packaged))).toBe(404);
        // The result import locks, reads and writes the batch by id: each statement names the tenant, so ORG_B finds no batch
        // (without the predicate the lock finds ORG_A's `exported` row and the call answers 422 M10_SUBMISSION_RESULT_NO_MATCH instead).
        expect(
          await statusCode(
            backend.importSubmissionResult(ORG_B, asOrgB, exported, {
              results: [
                { assessmentId: "90000000-0000-4000-8000-0000000000aa", status: "accepted" },
              ],
            }),
          ),
        ).toBe(404);
        // The worklist read: the control (ORG_A sees its batches on this same connection) shows the predicate is what hides them.
        const listed = async (org: string): Promise<string[]> =>
          (await backend.listSubmissions(org)).submissions.map((submission) => submission.id);
        expect(await listed(ORG_A)).toEqual(expect.arrayContaining([rejected, packaged, exported]));
        for (const id of [rejected, packaged, exported])
          expect(await listed(ORG_B)).not.toContain(id);
      } finally {
        await owner.close();
      }
      const status = async (table: string, id: string): Promise<string> =>
        (await admin.query(`SELECT status FROM ${table} WHERE id=$1`, [id])).rows[0]
          .status as string;
      expect(await status("hope_timepoint_schedule", sched)).toBe("open");
      expect(await status("hope_submission", rejected)).toBe("rejected");
      expect(await status("hope_submission", packaged)).toBe("packaged");
      expect(await status("hope_submission", exported)).toBe("exported");
    } finally {
      await admin.query("DELETE FROM hope_submission WHERE id = ANY($1::uuid[])", [
        [rejected, packaged, exported],
      ]);
    }
  });

  // The id-keyed reads and the draft writes name the tenant too (see the test above for why only a connection that
  // bypasses RLS shows it). Each ORG_B call would find ORG_A's row, and answer something other than a 404, if its
  // statement kept the id alone: the draft is not a HUV, not signed, and is readable.
  it("another tenant's id finds nothing on a connection that bypasses RLS: the id-keyed reads and the draft writes", async () => {
    const adm = await admitted();
    const sched = await seedSchedule(ORG_A, adm);
    const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
    const sfv = (
      await admin.query(
        `INSERT INTO symptom_follow_up_visit (organization_id, patient_id, admission_id,
           triggering_assessment_id, triggered_at, due_at, status, alert_cadence)
         VALUES ($1,$2,$3,$4,now(),now() + interval '2 days','open','{}'::jsonb) RETURNING id`,
        [ORG_A, patientOf[adm], adm, draft.id],
      )
    ).rows[0].id as string;
    const submission = (
      await admin.query(
        `INSERT INTO hope_submission (organization_id, provider_entity_id, submission_period, status, item_count)
         VALUES ($1,$2,'2026-07','packaged',1) RETURNING id`,
        [ORG_A, providerOf[ORG_A]],
      )
    ).rows[0].id as string;
    const owner = createDbClient({ connectionString: DB_URL as string });
    try {
      const backend = createDbHopeBackend(
        owner.db,
        { publish: async () => undefined },
        () => liveNow,
      );
      const asOrgB = memberOf[ORG_B] as string;
      const statusCode = (p: Promise<unknown>) =>
        p.then(
          () => null,
          (e: { statusCode?: number }) => e.statusCode,
        );

      // The control: the owner connection does read ORG_A's draft as ORG_A, so a 404 below is the predicate's doing.
      expect((await backend.getAssessment(ORG_A, draft.id)).id).toBe(draft.id);
      expect(await statusCode(backend.getAssessment(ORG_B, draft.id))).toBe(404);
      expect(await statusCode(backend.getSchedule(ORG_B, sched))).toBe(404);
      expect(await statusCode(backend.getSfv(ORG_B, sfv))).toBe(404);
      expect(await statusCode(backend.getSubmission(ORG_B, submission))).toBe(404);
      expect(await statusCode(backend.requestSummaryPdf(ORG_B, asOrgB, draft.id))).toBe(404);
      expect(
        await statusCode(
          backend.setHuvCompletionDate(ORG_B, asOrgB, draft.id, {
            ifVersion: draft.version,
            z0350: today(),
          }),
        ),
      ).toBe(404);
      expect(
        await statusCode(
          backend.correctTimepoint(ORG_B, asOrgB, draft.id, {
            correctionReason: "cross-tenant attempt",
            targetDate: new Date().toISOString(),
            authorDiscipline: "RN",
            data: QUIET_DATA,
          }),
        ),
      ).toBe(404);
      expect(await backend.listPatientAssessments(ORG_B, patientOf[adm] as string)).toEqual({
        assessments: [],
      });
      const state = JSON.stringify(await backend.getWorkflowState(ORG_B, adm));
      expect(state).not.toContain(draft.id);
      expect(state).not.toContain(sched);
      expect(state).not.toContain(sfv);
      // ...and the same call as ORG_A does see the draft (the check above is not vacuous).
      expect(JSON.stringify(await backend.getWorkflowState(ORG_A, adm))).toContain(draft.id);
      const { rows } = await admin.query(
        "SELECT version, status FROM hope_assessment WHERE id=$1",
        [draft.id],
      );
      expect(rows[0]).toMatchObject({ version: draft.version, status: "draft" });
    } finally {
      await owner.close();
      // The later assemble test starts from "no package exists": the rows seeded here are removed again, pass or fail.
      await admin.query("DELETE FROM hope_submission WHERE id=$1", [submission]);
      await admin.query("DELETE FROM symptom_follow_up_visit WHERE id=$1", [sfv]);
    }
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

  describe("R-08 — cancel a package that was never uploaded", () => {
    const stubVendor = (): void => {
      vi.stubEnv("CHARTWARDEN_SOFTWARE_VENDOR_ID", "12-3456789");
      vi.stubEnv("CHARTWARDEN_SOFTWARE_VENDOR_NAME", "ChartWarden Test Vendor");
      vi.stubEnv("CHARTWARDEN_SOFTWARE_VENDOR_EMAIL", "hope@vendor.test");
      vi.stubEnv("APP_VERSION", "2026.9.26");
    };
    const subRow = async (id: string) =>
      (await admin.query("SELECT * FROM hope_submission WHERE id=$1", [id])).rows[0];
    const itemRows = async (id: string) =>
      (
        await admin.query(
          "SELECT hope_assessment_id, item_status, xml_sha256, xml_size_bytes, xml_filename, iqies_validation_result FROM hope_submission_item WHERE hope_submission_id=$1 ORDER BY hope_assessment_id",
          [id],
        )
      ).rows;
    const errorCode = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: { code?: string; statusCode?: number }) => `${e.statusCode}:${e.code ?? "OTHER"}`,
      );
    /**
     * A signed, assemble-able admission record of its own (this block must not depend on which earlier tests
     * managed to sign). The final validator's section-presence check reads `hope_assessment.data`, so the
     * required sections are presented there before the canonical answers complete the record.
     */
    async function seedSignedAssessment(): Promise<string> {
      const adm = await admitted();
      await seedSchedule(ORG_A, adm);
      const draft = await svc.recordTimepoint(ORG_A, memberOf[ORG_A], adm, recordArgs(QUIET_DATA));
      const sections = Object.fromEntries(
        ["A", "B", "C", "D", "E", "F", "G", "H", "I", "K", "M", "N", "O", "Q", "X", "Z"].map(
          (s) => [s, { presentForValidation: true }],
        ),
      );
      await admin.query("UPDATE hope_assessment SET data = data || $2::jsonb WHERE id=$1", [
        draft.id,
        JSON.stringify(sections),
      ]);
      await answerForSign(draft.id);
      await svc.signTimepoint(ORG_A, memberOf[ORG_A], draft.id, { attestationConfirmed: true }); // R-05: signing needs the attestation
      return draft.id;
    }
    /** Release whatever earlier tests left packaged, then package every signed assessment afresh. */
    async function freshPackage(): Promise<string> {
      await seedSignedAssessment();
      const { rows: live } = await admin.query(
        "SELECT id FROM hope_submission WHERE organization_id=$1 AND status IN ('packaged','exported')",
        [ORG_A],
      );
      for (const { id } of live)
        await svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, id as string, {
          reasonCode: "generated_in_error",
        });
      stubVendor();
      return (await svc.assembleSubmission(ORG_A, providerOf[ORG_A]!)).id;
    }

    const cancelEvents = async (id: string) =>
      (
        await admin.query(
          "SELECT outcome, actor_user_id, organization_id, resource_kind, context FROM audit_event WHERE event_type='hope.submission_cancelled' AND resource_id=$1",
          [id],
        )
      ).rows;

    it("assemble -> cancel -> assemble again re-packages the SAME assessments in a NEW batch; the bytes are purged, the evidence stays", async () => {
      const first = await freshPackage();
      const before = await subRow(first);
      const itemsBefore = await itemRows(first);
      expect(itemsBefore.length).toBeGreaterThan(0);
      // Before the cancel the package and every record's XML are stored (the bytes the cancel must purge).
      expect(before.acceptance_report.packageContentBase64).toEqual(expect.any(String));
      for (const i of itemsBefore)
        expect(i.iqies_validation_result.xmlContentBase64).toEqual(expect.any(String));
      stubVendor();
      // While the package is live its assessments are locked in it (the partial unique index's job).
      await expect(svc.assembleSubmission(ORG_A, providerOf[ORG_A]!)).rejects.toMatchObject({
        statusCode: 409,
      });

      const cancelled = await svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, first, {
        reasonCode: "package_lost",
      });
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.cancelReasonCode).toBe("package_lost");
      const after = await subRow(first);
      expect(after.status).toBe("cancelled");
      expect(after.cancel_reason_code).toBe("package_lost");
      expect(after.cancelled_by_membership_id).toBe(memberOf[ORG_A]);
      expect(after.cancelled_at).toBeInstanceOf(Date);
      // CW-DS-01: a cancelled package was never transmitted (no CMS 10-year anchor) and no scan or eraser reaches it, so its
      // bytes (the ZIP) and each record's XML (name, DOB, MBI/SSN) are NULLed in the cancel's own transaction. What stays is
      // the evidence that a package existed: its hash, size and name, each record's XML hash, size and name, and who/when/why.
      expect(after.acceptance_report).toBeNull();
      expect(after.package_sha256).toBe(before.package_sha256);
      expect(after.package_size_bytes).toBe(before.package_size_bytes);
      expect(after.package_filename).toBe(before.package_filename);
      const itemsAfter = await itemRows(first);
      expect(itemsAfter.map((i) => i.item_status)).toEqual(itemsAfter.map(() => "cancelled"));
      expect(itemsAfter.map((i) => i.iqies_validation_result)).toEqual(itemsAfter.map(() => null));
      expect(itemsAfter.map((i) => i.xml_sha256)).toEqual(itemsBefore.map((i) => i.xml_sha256));
      expect(itemsAfter.map((i) => i.xml_size_bytes)).toEqual(
        itemsBefore.map((i) => i.xml_size_bytes),
      );
      expect(itemsAfter.map((i) => i.xml_filename)).toEqual(itemsBefore.map((i) => i.xml_filename));
      // The explicit audit event (the service was called directly here, so it carries no session user; the route-stack
      // suite asserts `actor_user_id`): written once, ids and enums only, naming the hash of the package that was purged.
      const events = await cancelEvents(first);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        outcome: "success",
        organization_id: ORG_A,
        resource_kind: "hope_submission",
      });
      expect(events[0].context).toMatchObject({
        reasonCode: "package_lost",
        priorStatus: "packaged",
        packageSha256: before.package_sha256,
        packageBytesPurged: true,
        itemsCancelled: itemsBefore.length,
        byMembershipId: memberOf[ORG_A],
      });
      // A replay changes nothing and writes no second event.
      await svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, first, { reasonCode: "other" });
      expect(await cancelEvents(first)).toHaveLength(1);
      // A cancel before upload is not an outbox event: the batch's own events are still only the queued one.
      expect(await eventsFor(first)).toEqual(["m10.hope.submission_queued"]);

      // The cancelled items no longer hold the unique pending slot: a new batch takes the same assessments.
      stubVendor();
      const second = await svc.assembleSubmission(ORG_A, providerOf[ORG_A]!);
      expect(second.id).not.toBe(first);
      expect(second.status).toBe("packaged");
      const itemsSecond = await itemRows(second.id);
      expect(itemsSecond.map((i) => i.hope_assessment_id)).toEqual(
        itemsBefore.map((i) => i.hope_assessment_id),
      );
      expect(itemsSecond.every((i) => i.item_status === "pending")).toBe(true);
    });

    /** An ACTIVE M4 legal hold on these patients (none = org-wide: no patient selector), released by the returned function. */
    async function holdPatients(...patientIds: string[]): Promise<() => Promise<void>> {
      const criteria = patientIds.length > 0 ? { patientIds } : {};
      const {
        rows: [hold],
      } = await admin.query(
        "INSERT INTO legal_hold (organization_id, name, criteria, status, reason) VALUES ($1,'m10 cancel hold',$2::jsonb,'active','litigation hold for the test') RETURNING id",
        [ORG_A, JSON.stringify(criteria)],
      );
      return async () => {
        await admin.query(
          "UPDATE legal_hold SET status='released', released_at=now() WHERE id=$1",
          [hold.id],
        );
      };
    }

    it("a cancel under a patient-scoped legal hold on a patient of the batch still cancels but keeps ALL the bytes, and says so in the event", async () => {
      const id = await freshPackage();
      const items = await itemRows(id);
      const heldPatient = (
        await admin.query("SELECT patient_id FROM hope_assessment WHERE id=$1", [
          items[0].hope_assessment_id,
        ])
      ).rows[0].patient_id as string;
      const release = await holdPatients(heldPatient);
      try {
        const cancelled = await svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, id, {
          reasonCode: "package_lost",
        });

        expect(cancelled.status).toBe("cancelled");
        const row = await subRow(id);
        expect(row.status).toBe("cancelled");
        expect(row.acceptance_report.packageContentBase64).toEqual(expect.any(String));
        const after = await itemRows(id);
        expect(after.map((i) => i.item_status)).toEqual(after.map(() => "cancelled"));
        for (const i of after)
          expect(i.iqies_validation_result.xmlContentBase64).toEqual(expect.any(String));
        const [event] = await cancelEvents(id);
        expect(event.context).toMatchObject({
          packageBytesPurged: false,
          bytesKeptForLegalHold: true,
          bytesKeptReason: "legal_hold",
          repeatCancel: false,
        });
      } finally {
        await release();
      }
    });

    it("repeating the cancel while the hold applies changes nothing; once the hold is released it purges the kept bytes (status and provenance untouched, one more event)", async () => {
      const id = await freshPackage();
      const heldPatient = (
        await admin.query("SELECT patient_id FROM hope_assessment WHERE id=$1", [
          (await itemRows(id))[0].hope_assessment_id,
        ])
      ).rows[0].patient_id as string;
      const release = await holdPatients(heldPatient);
      let provenance: Record<string, unknown>;
      try {
        await svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, id, { reasonCode: "package_lost" });
        const kept = await subRow(id);
        provenance = {
          status: kept.status,
          cancelled_at: kept.cancelled_at,
          cancelled_by_membership_id: kept.cancelled_by_membership_id,
          cancel_reason_code: kept.cancel_reason_code,
        };
        // The hold still applies: a repeat is a no-op (bytes stay, no new event).
        await svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, id, { reasonCode: "other" });
        expect((await subRow(id)).acceptance_report).not.toBeNull();
        expect(await cancelEvents(id)).toHaveLength(1);
      } finally {
        await release();
      }

      // Released: the same call purges what was kept, and says so.
      const again = await svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, id, {
        reasonCode: "other",
      });

      expect(again.status).toBe("cancelled");
      const purged = await subRow(id);
      expect(purged.acceptance_report).toBeNull();
      expect({
        status: purged.status,
        cancelled_at: purged.cancelled_at,
        cancelled_by_membership_id: purged.cancelled_by_membership_id,
        cancel_reason_code: purged.cancel_reason_code,
      }).toEqual(provenance);
      for (const i of await itemRows(id)) expect(i.iqies_validation_result).toBeNull();
      const events = await cancelEvents(id);
      expect(events).toHaveLength(2);
      expect(events[1].context).toMatchObject({
        repeatCancel: true,
        packageBytesPurged: true,
        bytesKeptReason: "none",
        reasonCode: "package_lost",
      });
      // Purged: a further repeat writes nothing.
      await svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, id, { reasonCode: "other" });
      expect(await cancelEvents(id)).toHaveLength(2);
    });

    it("a hold read that FAILS on the cancel's transaction (select 1/0) does not abort the cancel: it commits (200), keeps the bytes, and the event says the scope was unreadable", async () => {
      const id = await freshPackage();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      // A reader that fails INSIDE the cancel's transaction: Postgres aborts a transaction after an error, so the cancel can only
      // go on if the read ran in a SAVEPOINT that was rolled back.
      const failingRead = createDbHopeBackend(
        handle.db,
        { publish: async () => undefined },
        () => liveNow,
        {
          activeLegalHoldScopeInTransaction: async (tx) => {
            await tx.execute(sql`select 1/0`);
            return { orgWide: false, patientIds: new Set<string>() };
          },
        },
      );
      let logged = "";
      try {
        const cancelled = await failingRead.cancelSubmission(ORG_A, memberOf[ORG_A]!, id, {
          reasonCode: "package_lost",
        });

        expect(cancelled.status).toBe("cancelled");
        logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
      } finally {
        warn.mockRestore();
      }
      const row = await subRow(id);
      expect(row.status).toBe("cancelled"); // committed
      expect(row.acceptance_report.packageContentBase64).toEqual(expect.any(String)); // kept
      for (const i of await itemRows(id)) {
        expect(i.item_status).toBe("cancelled"); // the transaction went on after the failed read
        expect(i.iqies_validation_result.xmlContentBase64).toEqual(expect.any(String));
      }
      const [event] = await cancelEvents(id);
      expect(event.context).toMatchObject({
        packageBytesPurged: false,
        bytesKeptForLegalHold: false,
        bytesKeptReason: "hold_scope_unreadable",
      });
      // The read's failure was logged by the error class and the organisation, nothing else.
      expect(logged).toContain("legal-hold read failed");
      expect(logged).not.toContain("1/0");
      expect(logged).not.toContain("division");
    });

    it("an org-wide hold seen only AFTER the batch row lock keeps the bytes: a hold committed while the cancel waited for the row", async () => {
      const id = await freshPackage();
      const holder = await holdRowLock(id);
      let release: (() => Promise<void>) | undefined;
      try {
        const cancelling = svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, id, {
          reasonCode: "package_lost",
        });
        await awaitBlockedStatement();
        // The hold commits while the cancel is parked on the row lock: a scope read before the lock would not see it.
        release = await holdPatients();
        await holder.query("ROLLBACK");
        await cancelling;
      } finally {
        await holder.end().catch(() => undefined);
        await release?.();
      }

      expect((await subRow(id)).status).toBe("cancelled");
      expect((await subRow(id)).acceptance_report).not.toBeNull();
      expect((await cancelEvents(id))[0].context).toMatchObject({ bytesKeptReason: "legal_hold" });
    }, 30_000);

    it("an org-wide legal hold keeps the bytes too; a hold on a patient who is NOT in the batch purges as usual", async () => {
      const orgWide = await freshPackage();
      const releaseOrgWide = await holdPatients();
      try {
        await svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, orgWide, { reasonCode: "other" });
      } finally {
        await releaseOrgWide();
      }
      expect((await subRow(orgWide)).acceptance_report).not.toBeNull();
      expect((await cancelEvents(orgWide))[0].context).toMatchObject({
        bytesKeptForLegalHold: true,
        bytesKeptReason: "legal_hold",
      });

      const other = await freshPackage();
      const releaseElsewhere = await holdPatients("55555555-5555-4555-8555-555555555555");
      try {
        await svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, other, { reasonCode: "other" });
      } finally {
        await releaseElsewhere();
      }
      expect((await subRow(other)).acceptance_report).toBeNull();
      for (const i of await itemRows(other)) expect(i.iqies_validation_result).toBeNull();
      expect((await cancelEvents(other))[0].context).toMatchObject({
        packageBytesPurged: true,
        bytesKeptForLegalHold: false,
        bytesKeptReason: "none",
      });
    });

    it("a download stamps who took the package out (exported_by_membership_id), once, on the packaged -> exported step", async () => {
      const id = await freshPackage();
      expect((await subRow(id)).exported_by_membership_id).toBeNull();

      await svc.downloadSubmissionPackage(ORG_A, id, memberOf[ORG_A]!);

      const exported = await subRow(id);
      expect(exported.status).toBe("exported");
      expect(exported.exported_by_membership_id).toBe(memberOf[ORG_A]);
      // A re-download of an exported batch streams again and leaves the first exporter in place.
      await svc.downloadSubmissionPackage(ORG_A, id, OPERATOR.membershipId);
      expect((await subRow(id)).exported_by_membership_id).toBe(memberOf[ORG_A]);
    });

    it("a cancelled batch refuses mark-uploaded, results, download and retry (409); its bytes are gone and its hash stays", async () => {
      const id = await freshPackage();
      await svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, id, { reasonCode: "never_uploaded" });
      const [item] = await itemRows(id);
      expect(await errorCode(svc.markSubmissionUploaded(ORG_A, memberOf[ORG_A]!, id, {}))).toBe(
        "409:M10_SUBMISSION_CANCELLED",
      );
      expect(
        await errorCode(
          svc.importSubmissionResult(ORG_A, memberOf[ORG_A]!, id, {
            results: [{ assessmentId: item.hope_assessment_id, status: "accepted" }],
          }),
        ),
      ).toBe("409:M10_SUBMISSION_CANCELLED");
      expect(await errorCode(svc.downloadSubmissionPackage(ORG_A, id))).toBe(
        "409:M10_SUBMISSION_CANCELLED",
      );
      expect(await errorCode(svc.retrySubmission(ORG_A, id))).toBe(
        "409:M10_SUBMISSION_RETRY_NOT_REJECTED",
      );
      const row = await subRow(id);
      expect(row.status).toBe("cancelled");
      expect(row.transmitted_at).toBeNull();
      expect(row.acceptance_report).toBeNull();
      expect(row.package_sha256).toEqual(expect.any(String));
    });

    it("refuses after mark-uploaded and for a rejected, queued, accepted or file_error batch (409 each); a replay and a concurrent double cancel both answer cancelled", async () => {
      const uploaded = await freshPackage();
      await svc.markSubmissionUploaded(ORG_A, memberOf[ORG_A]!, uploaded, {});
      expect(
        await errorCode(
          svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, uploaded, { reasonCode: "other" }),
        ),
      ).toBe("409:M10_SUBMISSION_CANCEL_NOT_ALLOWED");
      expect((await subRow(uploaded)).status).toBe("submitted_pending_result");

      for (const status of ["rejected", "queued", "accepted", "file_error"]) {
        const seeded = (
          await admin.query(
            `INSERT INTO hope_submission (organization_id, provider_entity_id, submission_period, status, item_count)
             VALUES ($1,$2,'2026-06',$3,1) RETURNING id`,
            [ORG_A, providerOf[ORG_A], status],
          )
        ).rows[0].id as string;
        expect(
          await errorCode(
            svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, seeded, { reasonCode: "other" }),
          ),
        ).toBe("409:M10_SUBMISSION_CANCEL_NOT_ALLOWED");
      }

      // The uploaded batch is the only live one now; release it for the replay case via a fresh package.
      await admin.query("UPDATE hope_submission SET status='accepted' WHERE id=$1", [uploaded]);
      await admin.query(
        "UPDATE hope_submission_item SET item_status='accepted' WHERE hope_submission_id=$1",
        [uploaded],
      );
      const id = await freshPackage();
      const [a, b] = await Promise.all([
        svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, id, { reasonCode: "package_lost" }),
        svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, id, { reasonCode: "other" }),
      ]);
      expect([a.status, b.status]).toEqual(["cancelled", "cancelled"]);
      expect(a.cancelReasonCode).toBe(b.cancelReasonCode); // one winner; the loser replays its view
      const replay = await svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, id, {
        reasonCode: "other",
      });
      expect(replay).toEqual(a);
      expect((await subRow(id)).cancel_reason_code).toBe(a.cancelReasonCode);
      // One winner wrote one event; the loser replayed the cancelled view and wrote none.
      expect(await cancelEvents(id)).toHaveLength(1);
    });

    /** A second connection holding the batch row lock, as a concurrent cancel / mark-uploaded would. */
    async function holdRowLock(id: string): Promise<Client> {
      const holder = new Client({ connectionString: DB_URL });
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM hope_submission WHERE id=$1 FOR UPDATE", [id]);
      return holder;
    }
    /**
     * Wait until the statement UNDER TEST is parked on a lock: a backend of this database, other than the
     * polling connection, in a lock wait whose SQL names `hope_submission` (the quoted table, so a wait on
     * `hope_submission_item` or any unrelated table never satisfies it). A bare "some lock is ungranted"
     * check would release the test on someone else's wait and let the holder commit before the statement
     * under test had queued, which silently drops the ordering these tests exist to prove.
     */
    async function awaitBlockedStatement(): Promise<void> {
      for (let i = 0; i < 100; i += 1) {
        const { rows } = await admin.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND query ILIKE '%"hope_submission"%'`,
        );
        if (rows.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("the statement under test never became blocked on a hope_submission lock");
    }
    /** What a committed cancel leaves on the batch (the same columns cancelHopeSubmission writes). */
    const cancelAsHolder = async (holder: Client, id: string): Promise<void> => {
      await holder.query(
        "UPDATE hope_submission_item SET item_status='cancelled' WHERE hope_submission_id=$1",
        [id],
      );
      await holder.query(
        "UPDATE hope_submission SET status='cancelled', cancelled_at=now(), cancelled_by_membership_id=$2, cancel_reason_code='other' WHERE id=$1",
        [id, memberOf[ORG_A]],
      );
      await holder.query("COMMIT");
    };

    it("a download parked behind a cancel is refused and never resurrects the cancelled batch", async () => {
      const id = await freshPackage();
      const holder = await holdRowLock(id);
      try {
        const download = errorCode(svc.downloadSubmissionPackage(ORG_A, id));
        // The download reads the still-`packaged` row, then its packaged->exported write queues behind the cancel.
        await awaitBlockedStatement();
        await cancelAsHolder(holder, id);
        expect(await download).toBe("409:M10_SUBMISSION_CANCELLED");
        const row = await subRow(id);
        expect(row.status).toBe("cancelled");
        expect(row.exported_at).toBeNull();
      } finally {
        await holder.end();
      }
    });

    it("mark-uploaded parked behind a cancel is refused as cancelled and never marks the batch uploaded", async () => {
      const id = await freshPackage();
      const holder = await holdRowLock(id);
      try {
        const marked = errorCode(svc.markSubmissionUploaded(ORG_A, memberOf[ORG_A]!, id, {}));
        await awaitBlockedStatement();
        await cancelAsHolder(holder, id);
        expect(await marked).toBe("409:M10_SUBMISSION_CANCELLED");
        const row = await subRow(id);
        expect(row.status).toBe("cancelled");
        expect(row.transmitted_at).toBeNull();
      } finally {
        await holder.end();
      }
    });

    it("a download parked behind mark-uploaded still streams, but never writes exported over the uploaded batch", async () => {
      const id = await freshPackage();
      const holder = await holdRowLock(id);
      try {
        const download = svc.downloadSubmissionPackage(ORG_A, id).then((r) => r.bytes.length);
        await awaitBlockedStatement();
        await holder.query(
          "UPDATE hope_submission SET status='submitted_pending_result', transmitted_at=now(), submitted_at=now() WHERE id=$1",
          [id],
        );
        await holder.query("COMMIT");
        expect(await download).toBeGreaterThan(0);
        const row = await subRow(id);
        expect(row.status).toBe("submitted_pending_result");
        expect(row.exported_at).toBeNull();
      } finally {
        await holder.end();
      }
    });

    it.each<readonly [string, (id: string) => Promise<unknown>]>([
      [
        "cancel",
        (id: string) => svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, id, { reasonCode: "other" }),
      ],
      [
        "mark-uploaded",
        (id: string) => svc.markSubmissionUploaded(ORG_A, memberOf[ORG_A]!, id, {}),
      ],
      [
        "download (its packaged->exported write)",
        (id: string) => svc.downloadSubmissionPackage(ORG_A, id),
      ],
    ])(
      "a %s behind a long-held batch lock answers a retryable 409 instead of waiting for the lock and leaves the batch packaged",
      async (_label, call) => {
        const id = await freshPackage();
        const holder = await holdRowLock(id);

        const result = await busyWithin(call(id), holder);

        expect(result).toBe("409:M10_RECORD_BUSY");
        const row = await subRow(id);
        expect(row.status).toBe("packaged");
        expect(row.exported_at).toBeNull();
        expect(row.transmitted_at).toBeNull();
        expect(row.cancelled_at).toBeNull();
      },
      30_000,
    );

    it("re-downloading an exported batch does not queue behind a lock on its row (only a download that advances packaged->exported takes the lock)", async () => {
      const id = await freshPackage();
      await svc.downloadSubmissionPackage(ORG_A, id); // packaged -> exported
      expect((await subRow(id)).status).toBe("exported");
      const holder = await holdRowLock(id);
      try {
        // A download that queued for the held lock would end as the busy 409 after the lock timeout, not stream.
        await expect(svc.downloadSubmissionPackage(ORG_A, id)).resolves.toBeTruthy();
      } finally {
        await holder.query("ROLLBACK");
        await holder.end();
      }
    });

    it("a download refuses a cancelled batch without reading its package column, and reads it only to stream", async () => {
      const id = await freshPackage();
      const streamed = await statementsDuring((b) => b.downloadSubmissionPackage(ORG_A, id));
      expect(streamed.out.bytes.length).toBeGreaterThan(0);
      // The package ZIP (multi-MB base64) is read by exactly one statement, the one that streams it.
      expect(streamed.sql.filter((q) => q.includes('"acceptance_report"'))).toHaveLength(1);
      await svc.cancelSubmission(ORG_A, memberOf[ORG_A]!, id, { reasonCode: "never_uploaded" });
      const refused = await statementsDuring((b) =>
        errorCode(b.downloadSubmissionPackage(ORG_A, id)),
      );
      expect(refused.out).toBe("409:M10_SUBMISSION_CANCELLED");
      // Not vacuous: the spy does see the statements this call sent.
      expect(refused.sql.some((q) => q.includes('"hope_submission"'))).toBe(true);
      expect(refused.sql.filter((q) => q.includes('"acceptance_report"'))).toEqual([]);
    });

    it("a download whose batch is cancelled between its two reads is refused, never streamed (an exported batch has no advance guard)", async () => {
      const id = await freshPackage();
      await svc.downloadSubmissionPackage(ORG_A, id); // packaged -> exported: nothing guards a later write
      expect((await subRow(id)).status).toBe("exported");
      let cancelledBetweenReads = false;
      const cancelNow = async (text: string): Promise<void> => {
        // The package column is read by exactly one statement, AFTER the light status read has already seen `exported`.
        if (cancelledBetweenReads || !text.includes('"acceptance_report"')) return;
        cancelledBetweenReads = true;
        await admin.query(
          "UPDATE hope_submission_item SET item_status='cancelled' WHERE hope_submission_id=$1",
          [id],
        );
        await admin.query(
          "UPDATE hope_submission SET status='cancelled', cancelled_at=now(), cancelled_by_membership_id=$2, cancel_reason_code='other' WHERE id=$1",
          [id, memberOf[ORG_A]],
        );
      };

      const racing = await statementsDuring(
        (b) => errorCode(b.downloadSubmissionPackage(ORG_A, id)),
        cancelNow,
      );

      expect(cancelledBetweenReads).toBe(true); // not vacuous: the cancel really landed between the reads
      expect(racing.out).toBe("409:M10_SUBMISSION_CANCELLED");
      // The status travels with the bytes in ONE statement, so the bytes only leave with the version that was judged.
      const packageReads = racing.sql.filter((q) => q.includes('"acceptance_report"'));
      expect(packageReads).toHaveLength(1);
      expect(packageReads[0]).toMatch(/"status"/);
      expect((await subRow(id)).status).toBe("cancelled");
    });

    it.each([
      ["a Feb 30 (a JS Date would store March 2)", "2026-02-30T10:00:00Z"],
      ["a timestamp with no offset (read in the server's local time)", "2026-06-07T10:00:00"],
    ])(
      "mark-uploaded refuses submittedAt %s with a 422 and leaves the batch packaged",
      async (_label, submittedAt) => {
        const id = await freshPackage();

        const outcome = await errorCode(
          svc.markSubmissionUploaded(ORG_A, memberOf[ORG_A]!, id, { submittedAt }),
        );

        expect(outcome).toBe("422:VALIDATION_FAILED");
        const row = await subRow(id);
        expect(row.status).toBe("packaged");
        expect(row.transmitted_at).toBeNull();
      },
    );

    it("the validation read refuses a submissionDate that does not exist (422)", async () => {
      const id = await seedSignedAssessment();

      const outcome = await errorCode(
        svc.getValidation(ORG_A, id, {
          mayWrite: true,
          mode: "final",
          submissionDate: "2026-02-30T10:00:00Z",
        }),
      );

      expect(outcome).toBe("422:VALIDATION_FAILED");
    });

    it("the database ties `cancelled` to its who/when/why: all three on a cancelled batch, none on any other", async () => {
      const id = await freshPackage();
      const refused = (sql: string, params: unknown[]) =>
        expect(admin.query(sql, params)).rejects.toThrow(
          /hope_submission_cancelled_provenance_check/,
        );
      await refused("UPDATE hope_submission SET status='cancelled' WHERE id=$1", [id]);
      await refused(
        "UPDATE hope_submission SET status='cancelled', cancelled_at=now(), cancel_reason_code='other' WHERE id=$1",
        [id],
      ); // no actor
      await refused(
        "UPDATE hope_submission SET cancelled_at=now(), cancelled_by_membership_id=$2, cancel_reason_code='other' WHERE id=$1",
        [id, memberOf[ORG_A]],
      ); // full provenance on a batch that is not cancelled
      // Half-filled provenance on a batch that is not cancelled: the rule is all-or-none in BOTH directions.
      await refused("UPDATE hope_submission SET cancel_reason_code='other' WHERE id=$1", [id]);
      await refused("UPDATE hope_submission SET cancelled_at=now() WHERE id=$1", [id]);
      await refused(
        "UPDATE hope_submission SET cancelled_by_membership_id=$2, cancel_reason_code='other' WHERE id=$1",
        [id, memberOf[ORG_A]],
      );
      const row = await subRow(id);
      expect(row.status).toBe("packaged");
      expect([row.cancelled_at, row.cancelled_by_membership_id, row.cancel_reason_code]).toEqual([
        null,
        null,
        null,
      ]);
    });

    it("is invisible to another tenant (404) and leaves the batch packaged", async () => {
      const id = await freshPackage();
      expect(
        await errorCode(
          svc.cancelSubmission(ORG_B, memberOf[ORG_B]!, id, { reasonCode: "package_lost" }),
        ),
      ).toBe("404:NOT_FOUND");
      expect((await subRow(id)).status).toBe("packaged");
    });

    it("the database refuses a reason outside the fixed list (no free text, so no PHI)", async () => {
      const id = await freshPackage();
      await expect(
        admin.query("UPDATE hope_submission SET cancel_reason_code=$2 WHERE id=$1", [
          id,
          "John Doe lost the package",
        ]),
      ).rejects.toThrow(/hope_submission_cancel_reason_code_check/);
    });
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
    await expect(
      svc.signTimepoint(ORG_B, memberOf[ORG_B], draft.id, { attestationConfirmed: true }),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(svc.getAssessment(ORG_B, draft.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});
