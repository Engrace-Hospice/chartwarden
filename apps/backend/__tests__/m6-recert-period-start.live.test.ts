/**
 * LIVE Postgres proof (real NOBYPASSRLS `chartwarden_app` role, real catalog-validating publisher) that a
 * recertification benefit period starts on ITS OWN start date — never on the day its CTI is signed.
 *
 * The bug: `signCtiHospiceMd` flipped the next period to `active` immediately, dated from the signing day.
 * A recert may be signed up to 15 days before the next period starts (42 CFR 418.22(a)(3)), so an early
 * signature left two `active` periods overlapping, and every later period shifted earlier. Benefit periods
 * are contiguous (42 CFR 418.21(a)): period N+1 starts the day after period N ends.
 *
 * What this pins, through production writes:
 *   · early signature → CTI signed, next period stays `pending` (no dates, no `period_started`)
 *   · the hourly auto-end cron, on the start date, completes N (`period_ended` once) and starts N+1 dated
 *     `N.end + 1` with its 42 CFR 418.21(a) window (`period_started` once, with startDate/endDate);
 *     a replayed tick emits nothing more
 *   · late signature (start date already passed) → started at once, dated from the real start, not today
 *   · opening a pending period publishes no `period_started` (it has not started)
 *   · Bug 3: the transfer-in-drafted CTI (no narrative) refuses 422 `CTI_NARRATIVE_REQUIRED` and signs once
 *     the physician supplies the narrative at signature
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m6:recert-period-start:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { localDateInTimeZone } from "@chartwarden/shared/dates";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { addCalendarDays } from "../src/modules/06-admission/certification/window-math";
import { runElectionPeriodAutoEndCron } from "../src/modules/06-admission/jobs/cron-workers";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams, seedM5Patient } from "./_m6-admit";
import { validatingM6Outbox } from "./_m6-outbox";

const NARRATIVE_OK =
  "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care. The prognosis of six months or less is supported by serial decline in functional status, nutritional intake and symptom burden.";
const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative: NARRATIVE_OK,
  clinicalFindings: { ppsScore: 40 },
};

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG = "11111111-1111-1111-1111-1111111103a7";
const USER = "33333333-3333-3333-3333-3333333303a7";
const MD = "55555555-5555-5555-5555-5555555503a7";
const ATTENDING = "77777777-7777-7777-7777-7777777703a7";
const PROVIDER_ENTITY = "88888888-8888-8888-8888-8888888803a7";
/** The org's timezone (M1 `org_timezone` default) — the cron's "today". */
const ORG_TZ = "America/New_York";
const TODAY = localDateInTimeZone(new Date(), ORG_TZ);
/** An instant that is `day` in the org timezone (17:00Z is daytime in New York). */
const instantOn = (day: string): Date => new Date(`${day}T17:00:00.000Z`);

describe.skipIf(!DB_URL)("M6 recert period starts on its start date — LIVE (chartwarden_app)", () => {
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

  /** Period-1 activation ceremony, then period 1 re-dated so it ends on `period1End`. */
  async function activeAdmission(period1End: string) {
    const patientId = randomUUID();
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      hospicePhysicianId: MD,
      organizationId: ORG,
      actorUserId: USER,
      patientId,
    });
    const periodId = (await svc.listElectionPeriods(ORG, admissionId))?.[0]?.id as string;
    const nor = await svc.acknowledgeNor(
      ORG,
      admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    const es = await svc.draftElectionStatement(ORG, admissionId, periodId, {
      electedProviderEntityId: PROVIDER_ENTITY,
      electedAttendingPhysicianId: ATTENDING,
      waiverAcknowledged: true,
    });
    await svc.signElection(ORG, es.id, es.version, USER, {
      signingPatientName: "Pat Patient",
      signingRole: "patient",
    });
    const cti = await svc.draftCti(
      ORG,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: ATTENDING,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      USER,
    );
    await svc.signCtiHospiceMd(ORG, cti.id, cti.version, USER);
    await svc.activateAdmission(ORG, admissionId, nor.version);
    await admin.query(
      "UPDATE election_period SET effective_at=$2::date - 89, scheduled_end_at=$2 WHERE id=$1",
      [periodId, period1End],
    );
    return { admissionId, period1Id: periodId };
  }

  /** Open period 2 through the production route service and draft its recert CTI. */
  async function recert(admissionId: string) {
    const ep = await svc.createElectionPeriod(ORG, admissionId);
    const cti = await svc.draftCti(
      ORG,
      { electionPeriodId: ep.id, hospiceMedicalDirectorId: MD, ...CTI_CLINICAL, isRecert: true },
      USER,
    );
    return { periodId: ep.id, cti };
  }

  const period = async (id: string) =>
    (
      await admin.query(
        `SELECT status, effective_at::text AS start, scheduled_end_at::text AS "end",
                actual_end_at::text AS "actualEnd", completed_by_cause AS cause
           FROM election_period WHERE id=$1`,
        [id],
      )
    ).rows[0] as {
      status: string;
      start: string | null;
      end: string | null;
      actualEnd: string | null;
      cause: string | null;
    };
  const events = async (eventType: string, periodId: string) =>
    (
      await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type=$1 AND payload->>'electionPeriodId'=$2",
        [eventType, periodId],
      )
    ).rows.map((r) => r.payload as Record<string, unknown>);
  const activeCount = async (admissionId: string) =>
    Number(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM election_period WHERE admission_id=$1 AND status='active'",
          [admissionId],
        )
      ).rows[0].n,
    );
  const tick = (day: string) =>
    runElectionPeriodAutoEndCron({
      connection: {} as never,
      db: handle.db,
      outbox: validatingM6Outbox(),
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
      now: () => instantOn(day),
    });

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-recert','A','A')`,
      [ORG],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'rc@x.test'), ($2,'rc-md@x.test'), ($3,'rc-att@x.test')`,
      [USER, MD, ATTENDING],
    );
    await admin.query(
      `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,$2,'A Hospice','341234','1111111111','\\x00','12-31')`,
      [PROVIDER_ENTITY, ORG],
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

  it("opening a pending recert period publishes no period_started (it has not started)", async () => {
    const a = await activeAdmission(addCalendarDays(TODAY, 10));
    const { periodId } = await recert(a.admissionId);
    expect((await period(periodId)).status).toBe("pending");
    expect(await events("m6.election.period_started", periodId)).toHaveLength(0);
  });

  it("an EARLY recert signature signs the CTI but leaves the next period pending — no overlap", async () => {
    const period1End = addCalendarDays(TODAY, 10); // signing 11 days before period 2 starts (≤ 15)
    const a = await activeAdmission(period1End);
    const { periodId, cti } = await recert(a.admissionId);

    const signed = await svc.signCtiHospiceMd(ORG, cti.id, cti.version, USER);

    expect(signed.state).toBe("signed");
    expect(await period(periodId)).toMatchObject({ status: "pending", start: null, end: null });
    expect(await events("m6.election.period_started", periodId)).toHaveLength(0);
    expect(await activeCount(a.admissionId)).toBe(1);
    expect((await period(a.period1Id)).status).toBe("active");

    // The day before the start date: nothing moves.
    await tick(period1End);
    expect((await period(periodId)).status).toBe("pending");
    expect((await period(a.period1Id)).status).toBe("active");

    // On the start date the cron completes period 1 and starts period 2, contiguously.
    const start = addCalendarDays(period1End, 1);
    await tick(start);
    expect(await period(a.period1Id)).toMatchObject({
      status: "completed",
      actualEnd: period1End,
      cause: "next_period",
    });
    expect(await period(periodId)).toMatchObject({
      status: "active",
      start,
      end: addCalendarDays(start, 89), // period 2 is a 90-day period (42 CFR 418.21(a))
    });
    expect(await activeCount(a.admissionId)).toBe(1);
    const started = await events("m6.election.period_started", periodId);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      sequence: 2,
      admissionId: a.admissionId,
      startDate: start,
      endDate: addCalendarDays(start, 89),
      adequacy: { verdict: "adequate", f2fRequired: false },
    });
    expect(await events("m6.election.period_ended", a.period1Id)).toHaveLength(1);

    // A replayed tick is a no-op: still exactly one of each event.
    await tick(start);
    expect(await events("m6.election.period_started", periodId)).toHaveLength(1);
    expect(await events("m6.election.period_ended", a.period1Id)).toHaveLength(1);
  });

  it("a LATE recert signature starts the period at once, dated from its real start — not the signing day", async () => {
    const period1End = addCalendarDays(TODAY, -3);
    const a = await activeAdmission(period1End);
    const { periodId, cti } = await recert(a.admissionId);

    await svc.signCtiHospiceMd(ORG, cti.id, cti.version, USER);

    const start = addCalendarDays(period1End, 1);
    expect(await period(periodId)).toMatchObject({ status: "active", start });
    expect(await period(a.period1Id)).toMatchObject({
      status: "completed",
      actualEnd: period1End,
      cause: "next_period",
    });
    expect(await activeCount(a.admissionId)).toBe(1);
    const started = await events("m6.election.period_started", periodId);
    expect(started).toHaveLength(1);
    // Signed after the start date: the adequacy decision flags it late (R-CTI-01), never refuses it.
    expect((started[0]?.adequacy as { flags: string[] }).flags).toContain("CTI_SIGNED_LATE");
  });

  it("an inadequate recert still refuses at signature (fail closed), before its start date", async () => {
    const a = await activeAdmission(addCalendarDays(TODAY, 10));
    await recert(a.admissionId); // period 2
    const { periodId, cti } = await recert(a.admissionId); // period 3: needs an attested F2F (R-F2F-04)
    await expect(svc.signCtiHospiceMd(ORG, cti.id, cti.version, USER)).rejects.toMatchObject({
      code: "F2F_REQUIRED_FOR_RECERT",
    });
    expect((await period(periodId)).status).toBe("pending");
    const { rows } = await admin.query(
      "SELECT status FROM certification_of_terminal_illness WHERE id=$1",
      [cti.id],
    );
    expect(rows[0].status).toBe("drafted");
  });

  it("Bug 3: a transfer-in-drafted CTI (no narrative) refuses 422, then signs with the narrative supplied", async () => {
    const patientId = randomUUID();
    await seedM5Patient(admin, ORG, patientId);
    const adm = await svc.createAdmission(
      ORG,
      { patientId, intakeMethod: "transfer_in", hospiceMedicalDirectorId: MD },
      USER,
    );
    const priorStart = addCalendarDays(TODAY, -30);
    await svc.transferIn(
      ORG,
      adm.id,
      {
        priorBenefitPeriodSequence: 1,
        priorElectionStartDate: priorStart,
        hospiceMedicalDirectorId: MD,
        effectiveDate: TODAY,
        otherHospiceName: "Prior Hospice Inc",
        otherHospiceCcn: "381588",
        narrative: "patient transferred in mid-benefit-period from Prior Hospice Inc",
      },
      USER,
    );
    const { rows } = await admin.query(
      `SELECT c.id, c.version, c.narrative, ep.id AS period_id
         FROM certification_of_terminal_illness c
         JOIN election_period ep ON ep.id = c.election_period_id
        WHERE ep.admission_id=$1 AND ep.sequence_number=2`,
      [adm.id],
    );
    const drafted = rows[0] as { id: string; version: string; narrative: null; period_id: string };
    expect(drafted.narrative).toBeNull();

    await expect(
      svc.signCtiHospiceMd(ORG, drafted.id, Number(drafted.version), USER),
    ).rejects.toMatchObject({
      code: "CTI_NARRATIVE_REQUIRED",
      statusCode: 422,
      details: [{ code: "CTI_NARRATIVE_MISSING" }],
    });
    await expect(
      svc.signCtiHospiceMd(ORG, drafted.id, Number(drafted.version), USER, {
        narrative: "too short",
      }),
    ).rejects.toMatchObject({ code: "CTI_NARRATIVE_REQUIRED", statusCode: 422 });

    const signed = await svc.signCtiHospiceMd(ORG, drafted.id, Number(drafted.version), USER, {
      narrative: NARRATIVE_OK,
    });
    expect(signed.state).toBe("signed");
    const after = await admin.query(
      "SELECT narrative FROM certification_of_terminal_illness WHERE id=$1",
      [drafted.id],
    );
    expect(after.rows[0].narrative).toBe(NARRATIVE_OK);
    // The inherited period 1 runs to priorStart + 89; our period 2 waits for its own start date.
    expect((await period(drafted.period_id)).status).toBe("pending");
    expect(await activeCount(adm.id)).toBe(1);
  });
});
