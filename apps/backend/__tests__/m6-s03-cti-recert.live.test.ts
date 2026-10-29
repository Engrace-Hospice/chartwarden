/**
 * S03 (Clinical Workflow Audit 2026-10-28 §5, CW-CL-02) — CTI and recertification: valid, missing signature,
 * overdue, invalid face-to-face — proven through the production write path on real Postgres as the
 * NOBYPASSRLS `chartwarden_app` role, with the real catalog-validating outbox.
 *
 * Acceptance pinned here (every refusal is TYPED and leaves the prior state intact):
 *   · valid          — initial CTI and a recert sign; the signature time is the SERVER's (a client-supplied
 *                      `hospiceMdSignedAt` is ignored); exactly one active benefit period afterwards
 *   · missing sig    — a drafted-only CTI cannot activate the admission; wrong physician / stale version /
 *                      double-sign / voided CTI are refused with their codes and the row does not move
 *   · overdue        — `markCtiLate` stamps the flag and publishes the deadline; the signature-reminder cron
 *                      fires `signature_due_1d` then `signature_overdue` (and never for a signed CTI); the
 *                      recert-due window opens, escalates to `overdue` exactly once, and is closed (never
 *                      paged) once the recert has been completed
 *   · unsupported / invalid F2F — a recert too short, or a period >= 3 with no / merely scheduled / merely
 *                      completed / out-of-window / future-dated F2F is refused and the CTI stays `drafted`;
 *                      a lapsed F2F window pages once (`m6.f2f.window_missed`); the properly attested F2F
 *                      then lets the same CTI sign
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m6:s03-cti-recert:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import {
  type M6WorkerDeps,
  buildM6WorkerDeps,
  runComplianceWindowEscalationCron,
  runCtiSignatureNotifyCron,
  runF2fWindowMissedScanCron,
  runRecertDueNotifyCron,
} from "../src/modules/06-admission/jobs/cron-workers";
import { SYSTEM_F2F_ACTOR } from "../src/modules/06-admission/routes/service";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
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
const F2F_ATTESTATION =
  "Face-to-face encounter performed by the hospice clinician; findings support a terminal prognosis of six months or less (S03 fixture).";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG = "11111111-1111-1111-1111-1111111103c3";
const USER = "33333333-3333-3333-3333-3333333303c3";
const MD = "55555555-5555-5555-5555-5555555503c3";
const OTHER_MD = "66666666-6666-6666-6666-6666666603c3";
const ATTENDING = "77777777-7777-7777-7777-7777777703c3";
const PROVIDER_ENTITY = "88888888-8888-8888-8888-8888888803c3";
const ORG_TZ = "America/New_York";
const DAY_MS = 86_400_000;

describe.skipIf(!DB_URL)("S03 CTI + recertification — LIVE (chartwarden_app)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("DROP SCHEMA IF EXISTS report_mv CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of [...LIVE_DROP_ROLES, "report_writer"])
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

  /** Referral → qualify → accept: a period-1 admission, election/CTI still to come. */
  async function admit() {
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      hospicePhysicianId: MD,
      organizationId: ORG,
      actorUserId: USER,
      patientId: randomUUID(),
    });
    const periods = await svc.listElectionPeriods(ORG, admissionId);
    return { admissionId, periodId: periods?.[0]?.id as string };
  }
  const draftInitial = (periodId: string) =>
    svc.draftCti(
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
  /** NOR + signed election statement — everything activation needs except a signed CTI. */
  async function electAndAck(admissionId: string, periodId: string) {
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
    return nor;
  }
  async function activate() {
    const a = await admit();
    const nor = await electAndAck(a.admissionId, a.periodId);
    const cti = await draftInitial(a.periodId);
    await svc.signCtiHospiceMd(ORG, cti.id, cti.version, USER);
    await svc.activateAdmission(ORG, a.admissionId, nor.version);
    return a;
  }
  /** Period 1 ended `endOffset` org-local days from today; opens period 2 and drafts its recert CTI. */
  async function recert2(admissionId: string, endOffset: number, cti = {}) {
    await admin.query(
      `UPDATE election_period
          SET scheduled_end_at=(now() AT TIME ZONE '${ORG_TZ}')::date + $2::int,
              effective_at=(now() AT TIME ZONE '${ORG_TZ}')::date + $2::int - 89
        WHERE admission_id=$1 AND sequence_number=1`,
      [admissionId, endOffset],
    );
    const ep = await svc.createElectionPeriod(ORG, admissionId);
    const drafted = await svc.draftCti(
      ORG,
      {
        electionPeriodId: ep.id,
        hospiceMedicalDirectorId: MD,
        ...CTI_CLINICAL,
        isRecert: true,
        ...cti,
      },
      USER,
    );
    return { periodId: ep.id, cti: drafted };
  }
  /** A pending period 3 (60-day) starting in 10 days, with a recert CTI ready to sign. */
  async function pendingPeriod3(admissionId: string, withPeriod2 = false) {
    if (withPeriod2)
      await admin.query(
        `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind, status,
                                      scheduled_end_at)
         VALUES ($1,$2,2,'ninety_day','active', current_date + 9)`,
        [ORG, admissionId],
      );
    const periodId = (
      await admin.query(
        `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind, expected_start)
         VALUES ($1,$2,3,'sixty_day', current_date + 10) RETURNING id`,
        [ORG, admissionId],
      )
    ).rows[0].id as string;
    const cti = await svc.draftCti(
      ORG,
      { electionPeriodId: periodId, hospiceMedicalDirectorId: MD, ...CTI_CLINICAL, isRecert: true },
      USER,
    );
    return { periodId, cti };
  }

  const ctiRow = async (id: string) =>
    (
      await admin.query(
        `SELECT status, version::int AS version, hospice_md_signed_at, signed_late, narrative
           FROM certification_of_terminal_illness WHERE id=$1`,
        [id],
      )
    ).rows[0] as {
      status: string;
      version: number;
      hospice_md_signed_at: Date | null;
      signed_late: boolean;
      narrative: string | null;
    };
  const periodStatus = async (id: string) =>
    (await admin.query("SELECT status FROM election_period WHERE id=$1", [id])).rows[0]
      .status as string;
  const activeCount = async (admissionId: string) =>
    Number(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM election_period WHERE admission_id=$1 AND status='active'",
          [admissionId],
        )
      ).rows[0].n,
    );
  const events = async (eventType: string, aggregateId: string) =>
    (
      await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type=$1 AND aggregate_id=$2",
        [eventType, aggregateId],
      )
    ).rows.map((r) => r.payload as Record<string, unknown>);
  const dbNow = async () => (await admin.query("SELECT now() AS t")).rows[0].t as Date;
  const deps = (now: Date): M6WorkerDeps => ({
    ...buildM6WorkerDeps({
      connection: { host: "unused" } as never,
      db: handle.db,
      outbox: validatingM6Outbox(),
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
    }),
    now: () => now,
  });

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-s03','A','A')",
      [ORG],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'s03@x.test'),($2,'s03-md@x.test'),($3,'s03-att@x.test'),($4,'s03-md2@x.test')`,
      [USER, MD, ATTENDING, OTHER_MD],
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

  // ── VALID ─────────────────────────────────────────────────────────────────────────────────────
  describe("valid", () => {
    it("initial CTI signs on the server's clock — a client-supplied signing time is ignored", async () => {
      const a = await admit();
      const nor = await electAndAck(a.admissionId, a.periodId);
      const cti = await draftInitial(a.periodId);
      const before = await dbNow();
      const signed = await svc.signCtiHospiceMd(ORG, cti.id, cti.version, USER, {
        hospiceMdSignedAt: "2001-01-01T00:00:00.000Z",
      } as never);
      const after = await dbNow();
      expect(signed.state).toBe("signed");
      const row = await ctiRow(cti.id);
      const at = (row.hospice_md_signed_at as Date).getTime();
      expect(at).toBeGreaterThanOrEqual(before.getTime() - 5_000);
      expect(at).toBeLessThanOrEqual(after.getTime() + 5_000);
      // …and a signed CTI is what lets the admission activate.
      expect((await svc.activateAdmission(ORG, a.admissionId, nor.version)).state).toBe("active");
      expect(await activeCount(a.admissionId)).toBe(1);
    });

    it("a recert with a full narrative signs, starts period 2 and hands over from period 1 (one active)", async () => {
      const a = await activate();
      const { periodId, cti } = await recert2(a.admissionId, -1);
      expect((await svc.signCtiHospiceMd(ORG, cti.id, cti.version, USER)).state).toBe("signed");
      expect(await periodStatus(periodId)).toBe("active");
      expect(await activeCount(a.admissionId)).toBe(1);
      expect(await periodStatus(a.periodId)).toBe("completed");
    });
  });

  // ── MISSING SIGNATURE ──────────────────────────────────────────────────────────────────────────
  describe("missing signature", () => {
    it("a drafted-only CTI cannot activate the admission; prior state is preserved; signing then activates", async () => {
      const a = await admit();
      const nor = await electAndAck(a.admissionId, a.periodId);
      const cti = await draftInitial(a.periodId);
      await expect(svc.activateAdmission(ORG, a.admissionId, nor.version)).rejects.toMatchObject({
        statusCode: 412,
      });
      expect((await ctiRow(cti.id)).status).toBe("drafted");
      expect(await periodStatus(a.periodId)).not.toBe("active");
      expect(await activeCount(a.admissionId)).toBe(0);
      const adm = await admin.query("SELECT status FROM admission WHERE id=$1", [a.admissionId]);
      expect(adm.rows[0].status).not.toBe("active");
      await svc.signCtiHospiceMd(ORG, cti.id, cti.version, USER);
      expect((await svc.activateAdmission(ORG, a.admissionId, nor.version)).state).toBe("active");
    });

    it("refuses wrong physician at draft, stale version, double sign, premature attending sign and a voided CTI — row untouched", async () => {
      const a = await admit();
      await electAndAck(a.admissionId, a.periodId);

      // A CTI naming a hospice MD other than the admission's selected physician is refused at draft.
      await expect(
        svc.draftCti(
          ORG,
          {
            electionPeriodId: a.periodId,
            hospiceMedicalDirectorId: OTHER_MD,
            ...CTI_CLINICAL,
            isRecert: false,
          },
          USER,
        ),
      ).rejects.toMatchObject({ code: "CTI_HOSPICE_PHYSICIAN_MISMATCH", statusCode: 400 });

      const voidedCti = await draftInitial(a.periodId);
      await svc.voidCti(ORG, voidedCti.id, "entered in error", voidedCti.version);

      const cti = await draftInitial(a.periodId);
      await expect(svc.signCtiHospiceMd(ORG, cti.id, cti.version + 7, USER)).rejects.toMatchObject({
        statusCode: 409,
      });
      await expect(svc.signCtiAttending(ORG, cti.id, cti.version, USER)).rejects.toThrow();
      await admin.query("UPDATE admission SET hospice_physician_id=$2 WHERE id=$1", [
        a.admissionId,
        OTHER_MD,
      ]);
      await expect(svc.signCtiHospiceMd(ORG, cti.id, cti.version, USER)).rejects.toMatchObject({
        code: "CTI_HOSPICE_PHYSICIAN_MISMATCH",
        statusCode: 400,
      });
      expect(await ctiRow(cti.id)).toMatchObject({ status: "drafted", hospice_md_signed_at: null });
      await admin.query("UPDATE admission SET hospice_physician_id=$2 WHERE id=$1", [
        a.admissionId,
        MD,
      ]);
      expect((await ctiRow(cti.id)).status).toBe("drafted");

      const signed = await svc.signCtiHospiceMd(ORG, cti.id, cti.version, USER);
      const frozen = await ctiRow(cti.id);
      await expect(svc.signCtiHospiceMd(ORG, cti.id, signed.version, USER)).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(await ctiRow(cti.id)).toEqual(frozen); // the first signature is not re-stamped

      await expect(
        svc.signCtiHospiceMd(ORG, voidedCti.id, voidedCti.version + 1, USER),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect((await ctiRow(voidedCti.id)).status).toBe("voided");
    });

    it("a recert whose narrative is too short is refused 422 and neither the CTI nor the periods move", async () => {
      const a = await activate();
      const { periodId, cti } = await recert2(a.admissionId, 5, { narrative: "too short" });
      await expect(svc.signCtiHospiceMd(ORG, cti.id, cti.version, USER)).rejects.toMatchObject({
        code: "CTI_NARRATIVE_REQUIRED",
        statusCode: 422,
        details: [{ code: "CTI_NARRATIVE_TOO_SHORT" }],
      });
      expect(await ctiRow(cti.id)).toMatchObject({ status: "drafted", hospice_md_signed_at: null });
      expect(await periodStatus(periodId)).toBe("pending");
      expect(await periodStatus(a.periodId)).toBe("active");
      expect(await activeCount(a.admissionId)).toBe(1);
    });
  });

  // ── OVERDUE ────────────────────────────────────────────────────────────────────────────────────
  describe("overdue", () => {
    it("markCtiLate flags the CTI and publishes the written-certification deadline", async () => {
      const a = await admit();
      const cti = await draftInitial(a.periodId);
      const late = await svc.markCtiLate(ORG, cti.id, cti.version);
      expect(late.writtenCertDeadlineAt).toBeTruthy();
      expect((await ctiRow(cti.id)).signed_late).toBe(true);
      const published = await events("m6.cti.late_flagged", cti.id);
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({ ctiId: cti.id });
      await expect(svc.markCtiLate(ORG, cti.id, cti.version)).rejects.toMatchObject({
        statusCode: 409,
      }); // stale version after the bump
    });

    it("the signature-reminder cron fires due_1d then overdue for an unsigned CTI, and never for a signed one", async () => {
      const unsigned = await admit();
      const open = await draftInitial(unsigned.periodId);
      const signedAdm = await admit();
      const done = await draftInitial(signedAdm.periodId);
      await svc.signCtiHospiceMd(ORG, done.id, done.version, USER);

      const due = new Date(Date.now() + 3 * DAY_MS);
      for (const id of [open.id, done.id])
        await admin.query(
          "UPDATE certification_of_terminal_illness SET signature_requested_at=now(), signature_due_at=$2 WHERE id=$1",
          [id, due],
        );

      await runCtiSignatureNotifyCron(deps(new Date(Date.now() + DAY_MS))); // 2 days to go: nothing
      expect(await events("m6.cti.signature_due_1d", open.id)).toHaveLength(0);
      expect(await events("m6.cti.signature_overdue", open.id)).toHaveLength(0);

      await runCtiSignatureNotifyCron(deps(new Date(due.getTime() - 3_600_000))); // inside last 24h
      expect(await events("m6.cti.signature_due_1d", open.id)).toHaveLength(1);
      expect(await events("m6.cti.signature_overdue", open.id)).toHaveLength(0);

      await runCtiSignatureNotifyCron(deps(new Date(due.getTime() + 3_600_000))); // past due
      const overdue = await events("m6.cti.signature_overdue", open.id);
      expect(overdue).toHaveLength(1);
      expect(overdue[0]).toMatchObject({ ctiId: open.id, hospiceMdId: MD });

      for (const t of ["m6.cti.signature_due_1d", "m6.cti.signature_overdue"])
        expect(await events(t, done.id)).toHaveLength(0);
    });

    it("recert-due window opens once, escalates to overdue exactly once, and is closed unpaged once the recert is done", async () => {
      const pending = await activate(); // recert never completed
      const completed = await activate(); // recert completed in time
      const today = new Date();
      for (const a of [pending, completed])
        await admin.query(
          `UPDATE election_period SET scheduled_end_at=(now() AT TIME ZONE '${ORG_TZ}')::date + 5,
                  effective_at=(now() AT TIME ZONE '${ORG_TZ}')::date - 84 WHERE id=$1`,
          [a.periodId],
        );

      await runRecertDueNotifyCron(deps(today));
      await runRecertDueNotifyCron(deps(today)); // replay: idempotent
      const windows = async (admissionId: string) =>
        (
          await admin.query(
            "SELECT id, status, severity FROM compliance_window WHERE admission_id=$1 AND window_kind='recert_due_14d'",
            [admissionId],
          )
        ).rows as { id: string; status: string; severity: string }[];
      const [pendingWin] = await windows(pending.admissionId);
      const [completedWin] = await windows(completed.admissionId);
      expect(await windows(pending.admissionId)).toHaveLength(1);
      expect(pendingWin?.status).toBe("open");
      expect(await windows(completed.admissionId)).toHaveLength(1);

      // The second admission's recert is signed after its window opened: period 1 hands over.
      const { cti } = await recert2(completed.admissionId, -1);
      await svc.signCtiHospiceMd(ORG, cti.id, cti.version, USER);

      // Four days past the period end the un-recertified window is overdue; the completed one is closed.
      const later = new Date(today.getTime() + 10 * DAY_MS);
      await runComplianceWindowEscalationCron(deps(later));
      await runComplianceWindowEscalationCron(deps(later)); // replay: no second page
      expect((await windows(pending.admissionId))[0]).toMatchObject({
        status: "overdue",
        severity: "alert",
      });
      const paged = await events("m6.compliance.window.overdue", pendingWin?.id as string);
      expect(paged).toHaveLength(1);
      expect(paged[0]).toMatchObject({
        admissionId: pending.admissionId,
        windowKind: "recert_due_14d",
      });
      expect((await windows(completed.admissionId))[0]?.status).toBe("closed");
      expect(await events("m6.compliance.window.overdue", completedWin?.id as string)).toHaveLength(
        0,
      );
    });
  });

  // ── INVALID FACE-TO-FACE ───────────────────────────────────────────────────────────────────────
  describe("invalid face-to-face on a sequence-3 recert (42 CFR 418.22(a)(4))", () => {
    const sched = async (admissionId: string, periodId: string) =>
      svc.scheduleF2f(ORG, {
        admissionId,
        electionPeriodId: periodId,
        scheduledClinicianId: USER,
        clinicianRole: "hospice_md",
        actor: SYSTEM_F2F_ACTOR,
      });
    const f2fRow = async (id: string) =>
      (
        await admin.query(
          "SELECT status, version::int AS version, encounter_date::text AS d, attestation_signed_at FROM face_to_face_encounter WHERE id=$1",
          [id],
        )
      ).rows[0] as {
        status: string;
        version: number;
        d: string | null;
        attestation_signed_at: Date | null;
      };
    const today = () => new Date().toISOString().slice(0, 10);

    it("refuses with no F2F and with merely scheduled / completed ones; the CTI stays drafted, the period pending", async () => {
      const a = await activate();
      const { periodId, cti } = await pendingPeriod3(a.admissionId);
      const refused = () =>
        expect(svc.signCtiHospiceMd(ORG, cti.id, cti.version, USER)).rejects.toMatchObject({
          code: "F2F_REQUIRED_FOR_RECERT",
          statusCode: 409,
        });
      await refused(); // none at all

      const f2f = await sched(a.admissionId, periodId);
      await refused(); // scheduled only

      const done = await svc.completeF2f(ORG, f2f.id, f2f.version, today());
      expect(done.state).toBe("completed");
      await refused(); // completed but not attested

      expect(await ctiRow(cti.id)).toMatchObject({ status: "drafted", hospice_md_signed_at: null });
      expect(await periodStatus(periodId)).toBe("pending");
    });

    it("refuses an out-of-window, future-dated, under-attested or wrong-attester F2F — each leaves the F2F where it was", async () => {
      const a = await activate();
      const { periodId } = await pendingPeriod3(a.admissionId);
      const f2f = await sched(a.admissionId, periodId);

      const before = await f2fRow(f2f.id);
      // Period starts in 10 days: an encounter 60 days earlier is outside [start-30, start].
      const early = new Date(Date.now() - 60 * DAY_MS).toISOString().slice(0, 10);
      await expect(svc.completeF2f(ORG, f2f.id, f2f.version, early)).rejects.toMatchObject({
        code: "F2F_OUTSIDE_WINDOW",
        statusCode: 409,
      });
      const future = new Date(Date.now() + 3 * DAY_MS).toISOString().slice(0, 10);
      await expect(svc.completeF2f(ORG, f2f.id, f2f.version, future)).rejects.toMatchObject({
        code: "F2F_ENCOUNTER_DATE_INVALID",
      });
      await expect(svc.completeF2f(ORG, f2f.id, f2f.version, "not-a-date")).rejects.toMatchObject({
        code: "F2F_ENCOUNTER_DATE_INVALID",
      });
      expect(await f2fRow(f2f.id)).toEqual(before);
      expect(before).toMatchObject({ status: "scheduled", d: null });

      const done = await svc.completeF2f(ORG, f2f.id, f2f.version, today());
      const completed = await f2fRow(f2f.id);
      await expect(
        svc.attestF2f(ORG, f2f.id, done.version, USER, "too short"),
      ).rejects.toMatchObject({ code: "F2F_ATTESTATION_TOO_SHORT" });
      await expect(
        svc.attestF2f(ORG, f2f.id, done.version, MD, F2F_ATTESTATION), // not the performer
      ).rejects.toMatchObject({ code: "F2F_INVALID_PERFORMER" });
      expect(await f2fRow(f2f.id)).toEqual(completed);
      expect(completed.attestation_signed_at).toBeNull();
    });

    it("an attested F2F lets the same CTI sign; the attestation is stamped on the server clock", async () => {
      const a = await activate();
      const { periodId, cti } = await pendingPeriod3(a.admissionId);
      const f2f = await sched(a.admissionId, periodId);
      const done = await svc.completeF2f(ORG, f2f.id, f2f.version, today());
      const before = await dbNow();
      const attested = await svc.attestF2f(ORG, f2f.id, done.version, USER, F2F_ATTESTATION);
      const after = await dbNow();
      expect(attested.state).toBe("attested");
      const at = ((await f2fRow(f2f.id)).attestation_signed_at as Date).getTime();
      expect(at).toBeGreaterThanOrEqual(before.getTime() - 5_000);
      expect(at).toBeLessThanOrEqual(after.getTime() + 5_000);
      // Replaying the attestation is refused, not re-stamped.
      await expect(
        svc.attestF2f(ORG, f2f.id, attested.version, USER, F2F_ATTESTATION),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect((await svc.signCtiHospiceMd(ORG, cti.id, cti.version, USER)).state).toBe("signed");
    });

    it("a lapsed F2F window pages exactly once, and the unsupported recert is still refused afterwards", async () => {
      const a = await activate();
      await admin.query(
        "UPDATE election_period SET scheduled_end_at = current_date + 9 WHERE admission_id=$1 AND sequence_number=1",
        [a.admissionId],
      );
      // Period 2 completed, period 3 pending: the F2F window closes the day before period 3 starts.
      await admin.query(
        "UPDATE election_period SET status='completed' WHERE admission_id=$1 AND sequence_number=1",
        [a.admissionId],
      );
      const { periodId, cti } = await pendingPeriod3(a.admissionId, true);
      const pastWindow = new Date(Date.now() + 13 * DAY_MS);

      await runF2fWindowMissedScanCron(deps(pastWindow));
      await runF2fWindowMissedScanCron(deps(pastWindow)); // replay
      const paged = await events("m6.f2f.window_missed", periodId);
      expect(paged).toHaveLength(1);
      expect(paged[0]).toMatchObject({ electionPeriodId: periodId });
      const cw = await admin.query(
        "SELECT status FROM compliance_window WHERE admission_id=$1 AND window_kind='f2f_recert_30d_prior'",
        [a.admissionId],
      );
      expect(cw.rows.map((r) => r.status)).toEqual(["overdue"]);

      await expect(svc.signCtiHospiceMd(ORG, cti.id, cti.version, USER)).rejects.toMatchObject({
        code: "F2F_REQUIRED_FOR_RECERT",
      });
      expect((await ctiRow(cti.id)).status).toBe("drafted");
      expect(await periodStatus(periodId)).toBe("pending");
    });
  });
});
