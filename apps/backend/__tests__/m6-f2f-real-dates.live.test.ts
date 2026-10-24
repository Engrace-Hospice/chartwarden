/**
 * F-226 — LIVE Postgres proof that the F2F prior-to window is computed from the REAL encounter date against
 * the period's REAL expected start, through M6's production write service (`scheduleF2f` → `completeF2f` →
 * `attestF2f` → `signCtiHospiceMd`), as the real NOBYPASSRLS `chartwarden_app` role, with the REAL
 * catalog-validating outbox publisher.
 *
 * Before F-226 `completeF2f` dropped the validated `encounterDate`, stamped today, and computed the window
 * against a hard-coded today + 7, so `within_window` was always true on the production write path; a pending
 * period had no start date to compute it against at all.
 *
 *   · a pending period opened by `createElectionPeriod` carries `expected_start` = preceding scheduled end + 1
 *   · in-window real date -> completes with within_window=true, attests, and ACTIVATES the period
 *   · out-of-window date (start-31) and same-day (== start) are refused 409 F2F_OUTSIDE_WINDOW; the row stays
 *     `scheduled`; a future / absurdly old date is 422 F2F_ENCOUNTER_DATE_INVALID
 *   · the override path (R-F2F-03, legal from `scheduled`) lets an out-of-window encounter complete with the
 *     honest within_window=false and activate with the F2F_WINDOW_OVERRIDDEN flag
 *   · the activation gate RECOMPUTES: a period whose start moved after completion is refused at activation
 *   · an undeterminable period start is refused (409 F2F_PERIOD_START_UNKNOWN), never guessed
 *   · migration 0299 repairs legacy always-true rows on not-yet-activated periods (idempotently) and leaves
 *     activated history alone
 *   · cross-tenant: another org cannot complete/override this org's F2F
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m6:f2f-real-dates:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { runElectionPeriodAutoEndCron } from "../src/modules/06-admission/jobs/cron-workers";
import { SYSTEM_F2F_ACTOR } from "../src/modules/06-admission/routes/service";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
import { validatingM6Outbox } from "./_m6-outbox";
const F2F_ATTESTATION_NARRATIVE =
  "Face-to-face encounter performed by the hospice clinician; findings support a terminal prognosis of six months or less (GAP-022 fixture).";

const NARRATIVE_OK =
  "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care. The prognosis of six months or less is supported by serial decline in functional status, nutritional intake and symptom burden.";
const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative: NARRATIVE_OK,
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "11111111-1111-1111-1111-11111111226a";
const ORG_B = "22222222-2222-2222-2222-22222222226b";
const USER = "33333333-3333-3333-3333-33333333226a";
const MD = "55555555-5555-5555-5555-55555555226a";
const ATTENDING = "77777777-7777-7777-7777-77777777226a";
const PROVIDER_ENTITY = "88888888-8888-8888-8888-88888888226a";

const DRAFT = {
  electedProviderEntityId: PROVIDER_ENTITY,
  electedAttendingPhysicianId: ATTENDING,
  waiverAcknowledged: true,
} as const;
const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;
const OVERRIDE_REASON = "Documented hospitalisation delayed the visit past the window.";

const dayOffset = (offset: number): string =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!DB_URL)("F-226 — F2F real dates — LIVE Postgres (chartwarden_app role)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("DROP SCHEMA IF EXISTS report_mv CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of [...ROLES, "report_writer"])
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

  /** Period-1 activation ceremony through production writes only. */
  async function activate(patientId = randomUUID()) {
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      hospicePhysicianId: MD,
      organizationId: ORG_A,
      actorUserId: USER,
      patientId,
    });
    const periodId = (await svc.listElectionPeriods(ORG_A, admissionId))?.[0]?.id as string;
    const nor = await svc.acknowledgeNor(
      ORG_A,
      admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId, DRAFT);
    await svc.signElection(ORG_A, es.id, es.version, USER, SIGN);
    const cti = await svc.draftCti(
      ORG_A,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: ATTENDING,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      USER,
    );
    await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    await svc.activateAdmission(ORG_A, admissionId, nor.version);
    return { admissionId, periodId, patientId };
  }

  /** Activate period 2 through production (recert, no F2F needed), then open PENDING period 3. */
  async function pending3() {
    const a = await activate();
    // Period 1 ended yesterday (org-local), so period 2 (contiguous, 42 CFR 418.21(a)) starts today and its
    // recert signature below starts it at once — a recert never starts before its own start date.
    await admin.query(
      `UPDATE election_period SET scheduled_end_at=(now() AT TIME ZONE 'America/New_York')::date - 1
        WHERE id=$1`,
      [a.periodId],
    );
    const p2 = await svc.createElectionPeriod(ORG_A, a.admissionId);
    const cti2 = await svc.draftCti(
      ORG_A,
      { electionPeriodId: p2.id, hospiceMedicalDirectorId: MD, ...CTI_CLINICAL, isRecert: true },
      USER,
    );
    await svc.signCtiHospiceMd(ORG_A, cti2.id, cti2.version, USER);
    const p3 = await svc.createElectionPeriod(ORG_A, a.admissionId);
    const cti3 = await svc.draftCti(
      ORG_A,
      { electionPeriodId: p3.id, hospiceMedicalDirectorId: MD, ...CTI_CLINICAL, isRecert: true },
      USER,
    );
    return { ...a, p2Id: p2.id, periodId: p3.id, cti: cti3 };
  }

  /**
   * Period 2 ends the day before `start`; the hourly auto-end cron on `start` completes it and starts the
   * signed period 3 on its own start date (never on its early signing day).
   */
  const runToStart = async (admissionId: string, start: string) => {
    await admin.query(
      "UPDATE election_period SET scheduled_end_at = $2::date - 1 WHERE admission_id=$1 AND sequence_number = 2",
      [admissionId, start],
    );
    await runElectionPeriodAutoEndCron({
      connection: {} as never,
      db: handle.db,
      outbox: validatingM6Outbox(),
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      now: () => new Date(`${start}T17:00:00.000Z`),
    });
  };
  const setStart = (periodId: string, start: string | null) =>
    admin.query("UPDATE election_period SET expected_start = $2 WHERE id=$1", [periodId, start]);
  const schedule = async (periodId: string) =>
    svc.scheduleF2f(ORG_A, {
      // GAP-024 — the period must belong to the admission, so the real owner is looked up.
      admissionId: (
        await admin.query("SELECT admission_id FROM election_period WHERE id=$1", [periodId])
      ).rows[0].admission_id,
      electionPeriodId: periodId,
      scheduledClinicianId: USER,
      clinicianRole: "hospice_md",
      actor: SYSTEM_F2F_ACTOR,
    });
  const f2fRow = async (id: string) =>
    (
      await admin.query(
        `SELECT status, encounter_date::text AS d, within_window, window_override
           FROM face_to_face_encounter WHERE id=$1`,
        [id],
      )
    ).rows[0] as {
      status: string;
      d: string | null;
      within_window: boolean | null;
      window_override: boolean;
    };
  const periodStatus = async (id: string) =>
    (await admin.query("SELECT status FROM election_period WHERE id=$1", [id])).rows[0].status;
  const adequacyOf = async (periodId: string) =>
    (
      await admin.query(
        `SELECT payload FROM outbox_event
          WHERE event_type='m6.election.period_started' AND payload->>'electionPeriodId'=$1`,
        [periodId],
      )
    ).rows
      .map((r) => (r.payload as { adequacy?: unknown }).adequacy)
      .filter((x) => x !== undefined);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name)
       VALUES ($1,'org-f226a','A','A'), ($2,'org-f226b','B','B')`,
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'f226@x.test'), ($2,'f226-md@x.test'), ($3,'f226-att@x.test')`,
      [USER, MD, ATTENDING],
    );
    await admin.query(
      `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,$2,'A Hospice','341234','1111111111','\\x00','12-31')`,
      [PROVIDER_ENTITY, ORG_A],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    registerM5IntakeSeams(handle.db);
    svc = createDbAdmissionRouteService(handle.db, validatingM6Outbox(), undefined, {
      async belongsToOrg(organizationId: string, providerEntityId: string) {
        const { rows } = await admin.query(
          "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
          [providerEntityId, organizationId],
        );
        return rows.length > 0;
      },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  describe("expected_start is stamped when a pending period is opened", () => {
    it("createElectionPeriod: expected_start = the preceding period's scheduled_end_at + 1 day", async () => {
      const a = await activate();
      const p2 = await svc.createElectionPeriod(ORG_A, a.admissionId);
      const { rows } = await admin.query(
        `SELECT ep.expected_start::text AS s, (prior.scheduled_end_at + 1)::text AS want
           FROM election_period ep
           JOIN election_period prior ON prior.admission_id = ep.admission_id AND prior.sequence_number = 1
          WHERE ep.id = $1`,
        [p2.id],
      );
      expect(rows[0].s).toBeTruthy();
      expect(rows[0].s).toBe(rows[0].want);
      // period 1 (seeded by the intake cascade) has no expected start
      expect(
        (await admin.query("SELECT expected_start FROM election_period WHERE id=$1", [a.periodId]))
          .rows[0].expected_start,
      ).toBeNull();
    });

    it("a period opened while the preceding period has no scheduled end yet gets NULL (not guessed)", async () => {
      const a = await activate();
      const p2 = await svc.createElectionPeriod(ORG_A, a.admissionId); // pending, no scheduled end
      const p3 = await svc.createElectionPeriod(ORG_A, a.admissionId);
      expect(
        (await admin.query("SELECT expected_start FROM election_period WHERE id=$1", [p3.id]))
          .rows[0].expected_start,
      ).toBeNull();
      expect(p2.state).toBe("pending");
    });
  });

  describe("completeF2f uses the REAL encounter date", () => {
    it("in-window date: completes with within_window=true, persists the real date, attests, and ACTIVATES period 3", async () => {
      const p = await pending3();
      await setStart(p.periodId, dayOffset(10)); // the prior period is about to end
      const f = await schedule(p.periodId);
      const done = await svc.completeF2f(ORG_A, f.id, f.version, dayOffset(-1)); // 11 days before start
      expect(await f2fRow(f.id)).toMatchObject({
        status: "completed",
        d: dayOffset(-1),
        within_window: true,
        window_override: false,
      });
      const completedEvt = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m6.f2f.completed' AND aggregate_id=$1",
        [f.id],
      );
      expect(completedEvt.rows[0].payload).toMatchObject({
        encounterDate: dayOffset(-1),
        withinWindow: true,
      });
      await svc.attestF2f(ORG_A, f.id, done.version, USER, F2F_ATTESTATION_NARRATIVE);
      const signed = await svc.signCtiHospiceMd(ORG_A, p.cti.id, p.cti.version, USER);
      expect(signed.state).toBe("signed");
      expect(await periodStatus(p.periodId)).toBe("pending"); // signed 10 days early
      await runToStart(p.admissionId, dayOffset(10));
      expect(await periodStatus(p.periodId)).toBe("active");
      expect((await adequacyOf(p.periodId))[0]).toEqual({
        verdict: "adequate",
        f2fRequired: true,
        reasonCodes: [],
        flags: [],
      });
    });

    it("window edges through the service: start-30 and start-1 complete; start-31 is refused", async () => {
      const p = await pending3();
      const start = dayOffset(-1); // a period whose start was yesterday (overdue): dates all in the past
      await setStart(p.periodId, start);
      const edge = (n: number) => {
        const d = new Date(`${start}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
      };
      // start-31: refused, row untouched
      const f = await schedule(p.periodId);
      await expect(svc.completeF2f(ORG_A, f.id, f.version, edge(-31))).rejects.toMatchObject({
        code: "F2F_OUTSIDE_WINDOW",
        statusCode: 409,
      });
      expect(await f2fRow(f.id)).toMatchObject({
        status: "scheduled",
        d: null,
        within_window: null,
      });
      // start-30 then start-1 (two separate rows: a completed row cannot be re-completed)
      const first = await svc.completeF2f(ORG_A, f.id, f.version, edge(-30));
      expect(first.state).toBe("completed");
      expect((await f2fRow(f.id)).within_window).toBe(true);
      const g = await schedule(p.periodId);
      await svc.completeF2f(ORG_A, g.id, g.version, edge(-1));
      expect((await f2fRow(g.id)).within_window).toBe(true);
    });

    it("start+1 is refused per R-F2F-02; the period's first day itself is timely (MBPM ch. 9 §20.1(5)(a))", async () => {
      const p = await pending3();
      const start = dayOffset(-2);
      await setStart(p.periodId, start);
      const f = await schedule(p.periodId);
      await expect(svc.completeF2f(ORG_A, f.id, f.version, dayOffset(-1))).rejects.toMatchObject({
        code: "F2F_OUTSIDE_WINDOW",
      });
      expect((await f2fRow(f.id)).status).toBe("scheduled");
      await svc.completeF2f(ORG_A, f.id, f.version, start);
      const row = await f2fRow(f.id);
      expect(row.status).toBe("completed");
      expect(row.within_window).toBe(true);
    });

    it("a future date and an absurdly old date are malformed input (422), not a window verdict", async () => {
      const p = await pending3();
      await setStart(p.periodId, dayOffset(10));
      const f = await schedule(p.periodId);
      await expect(svc.completeF2f(ORG_A, f.id, f.version, dayOffset(3))).rejects.toMatchObject({
        code: "F2F_ENCOUNTER_DATE_INVALID",
        statusCode: 422,
      });
      await expect(svc.completeF2f(ORG_A, f.id, f.version, dayOffset(-400))).rejects.toMatchObject({
        code: "F2F_ENCOUNTER_DATE_INVALID",
        statusCode: 422,
      });
      expect((await f2fRow(f.id)).status).toBe("scheduled");
    });

    it("an undeterminable period start is refused (never guessed): 409 F2F_PERIOD_START_UNKNOWN", async () => {
      const p = await pending3();
      await setStart(p.periodId, null);
      await admin.query(
        "UPDATE election_period SET scheduled_end_at = NULL WHERE admission_id=$1 AND sequence_number = 2",
        [p.admissionId],
      );
      const f = await schedule(p.periodId);
      await expect(svc.completeF2f(ORG_A, f.id, f.version, dayOffset(-1))).rejects.toMatchObject({
        code: "F2F_PERIOD_START_UNKNOWN",
        statusCode: 409,
      });
    });

    it("a legacy period with NULL expected_start derives it from the preceding period's end + 1", async () => {
      const p = await pending3();
      await setStart(p.periodId, null); // un-stamped legacy row
      await admin.query(
        "UPDATE election_period SET scheduled_end_at = current_date + 9 WHERE admission_id=$1 AND sequence_number = 2",
        [p.admissionId],
      );
      const f = await schedule(p.periodId);
      const done = await svc.completeF2f(ORG_A, f.id, f.version, dayOffset(-1)); // start = today+10 -> inside
      expect(done.state).toBe("completed");
      expect((await f2fRow(f.id)).within_window).toBe(true);
    });
  });

  describe("the override path (R-F2F-03) — authority stays with the route permission", () => {
    it("override on the scheduled row lets an out-of-window encounter complete with the HONEST false, and activate flagged", async () => {
      const p = await pending3();
      await setStart(p.periodId, dayOffset(10));
      const f = await schedule(p.periodId);
      const outside = dayOffset(-60);
      await expect(svc.completeF2f(ORG_A, f.id, f.version, outside)).rejects.toMatchObject({
        code: "F2F_OUTSIDE_WINDOW",
      });
      // too-short reason is rejected by the state machine
      await expect(
        svc.overrideF2fWindow(ORG_A, f.id, "too short", f.version, MD),
      ).rejects.toMatchObject({
        code: "F2F_OVERRIDE_REASON_TOO_SHORT",
      });
      const over = await svc.overrideF2fWindow(ORG_A, f.id, OVERRIDE_REASON, f.version, MD);
      expect(over.state).toBe("scheduled");
      const done = await svc.completeF2f(ORG_A, f.id, over.version, outside);
      expect(await f2fRow(f.id)).toMatchObject({
        status: "completed",
        d: outside,
        within_window: false,
        window_override: true,
      });
      await svc.attestF2f(ORG_A, f.id, done.version, USER, F2F_ATTESTATION_NARRATIVE);
      await svc.signCtiHospiceMd(ORG_A, p.cti.id, p.cti.version, USER);
      await runToStart(p.admissionId, dayOffset(10));
      expect(await periodStatus(p.periodId)).toBe("active");
      expect((await adequacyOf(p.periodId))[0]).toMatchObject({
        verdict: "adequate",
        flags: ["F2F_WINDOW_OVERRIDDEN"],
      });
    });

    it("an override with an undeterminable start completes with within_window NULL (unverified)", async () => {
      const p = await pending3();
      await setStart(p.periodId, null);
      await admin.query(
        "UPDATE election_period SET scheduled_end_at = NULL WHERE admission_id=$1 AND sequence_number = 2",
        [p.admissionId],
      );
      const f = await schedule(p.periodId);
      const over = await svc.overrideF2fWindow(ORG_A, f.id, OVERRIDE_REASON, f.version, MD);
      await svc.completeF2f(ORG_A, f.id, over.version, dayOffset(-1));
      expect((await f2fRow(f.id)).within_window).toBeNull();
    });
  });

  describe("the activation gate RECOMPUTES from the dates (fails closed on disagreement)", () => {
    it("a start that moved after completion is refused at activation: 409 F2F_OUTSIDE_WINDOW, tx rolled back", async () => {
      const p = await pending3();
      await setStart(p.periodId, dayOffset(10));
      const f = await schedule(p.periodId);
      const done = await svc.completeF2f(ORG_A, f.id, f.version, dayOffset(-1));
      await svc.attestF2f(ORG_A, f.id, done.version, USER, F2F_ATTESTATION_NARRATIVE);
      await setStart(p.periodId, dayOffset(60)); // encounter is now 61 days before the start
      await expect(
        svc.signCtiHospiceMd(ORG_A, p.cti.id, p.cti.version, USER),
      ).rejects.toMatchObject({
        code: "ELECTION_PERIOD_ADEQUACY_FAILED",
        statusCode: 409,
        details: [{ code: "F2F_OUTSIDE_WINDOW" }],
      });
      expect(await periodStatus(p.periodId)).toBe("pending");
      expect(
        (
          await admin.query("SELECT status FROM certification_of_terminal_illness WHERE id=$1", [
            p.cti.id,
          ])
        ).rows[0].status,
      ).toBe("drafted");
    });

    it("a stored within_window=true on an out-of-window date (the pre-F-226 bug shape) is not trusted", async () => {
      const p = await pending3();
      await setStart(p.periodId, dayOffset(10));
      await admin.query(
        `INSERT INTO face_to_face_encounter (organization_id, election_period_id, performed_by_user_id,
           performer_role, encounter_date, within_window, status, attestation_signed_at)
         VALUES ($1,$2,$3,'hospice_np', current_date, true, 'attested', now())`,
        [ORG_A, p.periodId, MD],
      );
      // encounter today is 10 days before start: inside. Move the encounter out with the flag still true:
      await admin.query(
        "UPDATE face_to_face_encounter SET encounter_date = current_date - 90 WHERE election_period_id=$1",
        [p.periodId],
      );
      await expect(
        svc.signCtiHospiceMd(ORG_A, p.cti.id, p.cti.version, USER),
      ).rejects.toMatchObject({
        code: "ELECTION_PERIOD_ADEQUACY_FAILED",
        details: [{ code: "F2F_OUTSIDE_WINDOW" }],
      });
    });
  });

  describe("cross-tenant isolation (real chartwarden_app role, RLS)", () => {
    it("another org cannot complete or override this org's F2F; nothing changes", async () => {
      const p = await pending3();
      await setStart(p.periodId, dayOffset(10));
      const f = await schedule(p.periodId);
      await expect(svc.completeF2f(ORG_B, f.id, f.version, dayOffset(-1))).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(
        svc.overrideF2fWindow(ORG_B, f.id, OVERRIDE_REASON, f.version, MD),
      ).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(await f2fRow(f.id)).toMatchObject({
        status: "scheduled",
        d: null,
        window_override: false,
      });
    });
  });

  describe("migration 0299 — repair of legacy always-true rows (idempotent, not-yet-activated only)", () => {
    const MIGRATION = readFileSync(
      join(MIGRATIONS_DIR, "0299_election_period_expected_start.sql"),
      "utf8",
    );
    const seedF2f = async (
      periodId: string,
      encounter: string | null,
      within: boolean | null,
      o: { status?: string; override?: boolean } = { status: "completed" },
    ) =>
      (
        await admin.query(
          `INSERT INTO face_to_face_encounter (organization_id, election_period_id, performed_by_user_id,
             performer_role, encounter_date, within_window, status, window_override, window_override_reason,
             window_override_by, attestation_signed_at)
           VALUES ($1,$2,$3,'hospice_md', $4, $5, $6, $7, $8, $9, ${o.status === "scheduled" ? "NULL" : "now()"})
           RETURNING id`,
          [
            ORG_A,
            periodId,
            MD,
            encounter,
            within,
            o.status ?? "completed",
            !!o.override,
            o.override ? OVERRIDE_REASON : null,
            o.override ? USER : null,
          ],
        )
      ).rows[0].id as string;

    it("derives expected_start for pending periods, recomputes within_window, NULLs what it cannot derive, leaves history", async () => {
      const a = await activate();
      // Legacy shape: prior period (seq 2) completed with a real end; pending seq 3 un-stamped; pending seq 4 un-stamped
      // with NO preceding end on record (seq 3 has no scheduled end) -> not derivable.
      await admin.query(
        `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind, status, effective_at, scheduled_end_at)
         VALUES ($1,$2,2,'ninety_day','completed','2026-01-01','2026-03-31')`,
        [ORG_A, a.admissionId],
      );
      const p3 = (
        await admin.query(
          `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind, status)
           VALUES ($1,$2,3,'sixty_day','pending') RETURNING id`,
          [ORG_A, a.admissionId],
        )
      ).rows[0].id as string;
      const p4 = (
        await admin.query(
          `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind, status)
           VALUES ($1,$2,4,'sixty_day','pending') RETURNING id`,
          [ORG_A, a.admissionId],
        )
      ).rows[0].id as string;
      // p3 expected start (derived) = 2026-04-01 -> window [2026-03-02, 2026-03-31]
      const inWin = await seedF2f(p3, "2026-03-20", true, { status: "attested" });
      const tooEarly = await seedF2f(p3, "2026-02-01", true); // bogus true, 59 days before
      const sameDay = await seedF2f(p3, "2026-04-01", true); // bogus true, same day
      const noDate = await seedF2f(p3, null, true); // bogus true, no encounter date
      const overridden = await seedF2f(p3, "2026-04-05", true, { override: true }); // after start, override on file
      const scheduledOnly = await seedF2f(p3, null, null, { status: "scheduled" });
      const noStart = await seedF2f(p4, "2026-03-20", true); // period start not derivable
      // activated history: period 1 is active and carries a bogus-true F2F -> must NOT be touched
      const history = await seedF2f(a.periodId, "2020-01-01", true);

      await admin.query(MIGRATION);
      const snapshot = async () =>
        (
          await admin.query(
            `SELECT id, within_window, updated_at::text u FROM face_to_face_encounter WHERE id = ANY($1) ORDER BY id`,
            [[inWin, tooEarly, sameDay, noDate, overridden, scheduledOnly, noStart, history]],
          )
        ).rows as { id: string; within_window: boolean | null; u: string }[];
      const after = Object.fromEntries((await snapshot()).map((r) => [r.id, r.within_window]));
      expect(after[inWin]).toBe(true);
      expect(after[tooEarly]).toBe(false);
      expect(after[sameDay]).toBe(false);
      expect(after[noDate]).toBeNull();
      expect(after[overridden]).toBe(false); // honest verdict; the override (not this flag) is what waives it
      expect(after[scheduledOnly]).toBeNull();
      expect(after[noStart]).toBeNull(); // fail closed
      expect(after[history]).toBe(true); // activated history untouched
      const starts = (
        await admin.query(
          "SELECT id, expected_start::text s FROM election_period WHERE id = ANY($1)",
          [[p3, p4, a.periodId]],
        )
      ).rows as { id: string; s: string | null }[];
      const startOf = (id: string) => starts.find((r) => r.id === id)?.s ?? null;
      expect(startOf(p3)).toBe("2026-04-01");
      expect(startOf(p4)).toBeNull(); // seq 3 has no scheduled end
      expect(startOf(a.periodId)).toBeNull(); // activated period left alone

      // idempotent: a second run changes nothing (including updated_at: the IS DISTINCT FROM guard skips rows)
      const before2 = await snapshot();
      await admin.query(MIGRATION);
      expect(await snapshot()).toEqual(before2);
    });
  });
});
