import { randomUUID } from "node:crypto";
/**
 * M6L-T05 — the Drizzle compliance-window close / override write lifecycle, proven against real
 * Postgres. This is the last M6 write slice: with it, no admission route is left at 501.
 *
 * Drives the writes as the NOBYPASSRLS `wardenx_app` role: an admission's compliance windows are opened
 * by the T02 createAdmission cascade (initial_assessment_48h / comprehensive_assessment_5d / care_plan_5d
 * / notice_of_rights); we close one, override another (capturing the reason + the overriding user), and
 * assert the §7.1 optimistic lock (stale ifVersion → 409) plus the already-closed guard.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import {
  buildM6WorkerDeps,
  runF2fWindowMissedScanCron,
} from "../src/modules/06-admission/jobs/cron-workers";
import { SYSTEM_F2F_ACTOR } from "../src/modules/06-admission/routes/service";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
import { validatingM6Outbox } from "./_m6-outbox";
const F2F_ATTESTATION_NARRATIVE =
  "Face-to-face encounter performed by the hospice clinician; findings support a terminal prognosis of six months or less (GAP-022 fixture).";

/** Clinical content every CTI draft carries (`CtiDraftSchema`, route 22) — mirrors m6-election-cti-write. */
const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative:
    "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care. The prognosis of six months or less is supported by serial decline in functional status, nutritional intake and symptom burden.",
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const MD = "55555555-5555-5555-5555-555555555555";
/** F-178b cross-tenant isolation fixtures. */
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER_B = "44444444-4444-4444-4444-444444444444";
const MD_B = "66666666-6666-6666-6666-666666666666";

describe.skipIf(!DB_URL)("M6 compliance-window write lifecycle — LIVE Postgres (M6L-T05)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;

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
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  /** Referral → triage → qualify → accept: an admission whose createAdmission cascade opened its compliance windows. */
  async function admissionWithWindows(): Promise<string> {
    // Main's intake: triage → qualify → accept (+ admission details) — see _m6-admit.ts.
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      hospicePhysicianId: MD,
      organizationId: ORG_A,
      actorUserId: USER,
      patientId: randomUUID(),
    });
    return admissionId;
  }

  /**
   * F-178b — an admission with an ACTIVE 2nd (90-day) benefit period and a PENDING, unattested 3rd
   * (recert, F2F-gated) period. Mirrors `m6-election-cti-write.live.test.ts`'s "recert (period 2):
   * hospice sign fully signs + activates the period" test — the minimal real write path that gets a
   * period to `active` with a real `scheduled_end_at`, needing neither an activated admission nor a
   * signed election statement (`signCtiHospiceMd` alone activates a recert period whose start date — the
   * day after period 1 ends — has arrived, R-EL sequence < 3).
   */
  async function pendingRecertPeriod3(
    org: string,
    user: string,
    md: string,
  ): Promise<{
    admissionId: string;
    period2Id: string;
    period2ScheduledEndAt: string;
    period3Id: string;
  }> {
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      hospicePhysicianId: md,
      organizationId: org,
      actorUserId: user,
      patientId: randomUUID(),
    });
    // Period 1 ran and ended yesterday (org-local), so period 2 — contiguous, 42 CFR 418.21(a) — starts
    // today and its (late) recert signature below starts it at once.
    await admin.query(
      `UPDATE election_period
          SET status='active',
              scheduled_end_at=(now() AT TIME ZONE 'America/New_York')::date - 1,
              effective_at=(now() AT TIME ZONE 'America/New_York')::date - 90
        WHERE admission_id=$1 AND sequence_number=1`,
      [admissionId],
    );
    const p2 = await svc.createElectionPeriod(org, admissionId);
    const cti2 = await svc.draftCti(
      org,
      { electionPeriodId: p2.id, hospiceMedicalDirectorId: md, ...CTI_CLINICAL, isRecert: true },
      user,
    );
    const signed = await svc.signCtiHospiceMd(org, cti2.id, cti2.version, user);
    expect(signed.state).toBe("signed");
    const { rows } = await admin.query(
      "SELECT status, scheduled_end_at FROM election_period WHERE id=$1",
      [p2.id],
    );
    expect(rows[0].status).toBe("active"); // §7.3 recert activates the period (its start date has arrived)
    const period2ScheduledEndAt = rows[0].scheduled_end_at.toISOString().slice(0, 10);

    const p3 = await svc.createElectionPeriod(org, admissionId);
    expect(p3.state).toBe("pending");

    return { admissionId, period2Id: p2.id, period2ScheduledEndAt, period3Id: p3.id };
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
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'m6t5@x.test'),($2,'m6t5md@x.test'),($3,'m6t5b@x.test'),($4,'m6t5mdb@x.test')`,
      [USER, MD, USER_B, MD_B],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    registerM5IntakeSeams(handle.db); // M5 intake seams M6 conversion + readiness consult
    svc = createDbAdmissionRouteService(handle.db, validatingM6Outbox()); // F-100
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("createAdmission opens the §2.5 compliance windows", async () => {
    const admissionId = await admissionWithWindows();
    const windows = await svc.listComplianceWindowsForAdmission(ORG_A, admissionId);
    expect(windows!.length).toBeGreaterThanOrEqual(4);
    expect(windows!.every((w) => w.state === "open")).toBe(true);
  });

  it("closeComplianceWindow → closed (stale ifVersion → 409, second close → 409)", async () => {
    const admissionId = await admissionWithWindows();
    const windows = await svc.listComplianceWindowsForAdmission(ORG_A, admissionId);
    const w = windows![0];
    await expect(svc.closeComplianceWindow(ORG_A, w.id, w.version + 99)).rejects.toMatchObject({
      statusCode: 409,
    });
    const closed = await svc.closeComplianceWindow(ORG_A, w.id, w.version);
    expect(closed.state).toBe("closed");
    await expect(svc.closeComplianceWindow(ORG_A, w.id, closed.version)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("overrideComplianceWindow → closed, capturing the reason + overriding user", async () => {
    const admissionId = await admissionWithWindows();
    const windows = await svc.listComplianceWindowsForAdmission(ORG_A, admissionId);
    const w = windows![0];
    const reason = "assessment completed on paper during EHR outage; scanned to chart";
    const over = await svc.overrideComplianceWindow(ORG_A, w.id, reason, w.version, MD);
    expect(over.state).toBe("closed");
    const row = await admin.query(
      "SELECT override_reason, closed_by FROM compliance_window WHERE id=$1",
      [w.id],
    );
    expect(row.rows[0].override_reason).toBe(reason);
    expect(row.rows[0].closed_by).toBe(MD);
  });

  // ── F-178b (#248) — the F2F "prior-to" window-missed scan ──────────────────────────────────────
  describe("F2F window-missed scan (admission.window_alert, F-178b)", () => {
    /** 3 days past `scheduledEndAt` (the F2F window ends the next day, period 3's first day) — comfortably past the
     *  CMS 418.22 deadline regardless of the default org timezone's offset from UTC. */
    function pastWindowEnd(scheduledEndAt: string): Date {
      return new Date(Date.parse(`${scheduledEndAt}T00:00:00.000Z`) + 3 * 86_400_000);
    }

    it("newly-missed window emits m6.f2f.window_missed exactly once (second tick is a no-op)", async () => {
      const { admissionId, period3Id, period2ScheduledEndAt } = await pendingRecertPeriod3(
        ORG_A,
        USER,
        MD,
      );
      const deps = buildM6WorkerDeps({
        connection: { host: "unused" } as never,
        db: handle.db,
        outbox: validatingM6Outbox(),
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      });
      deps.now = () => pastWindowEnd(period2ScheduledEndAt);

      await runF2fWindowMissedScanCron(deps);

      const emitted = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m6.f2f.window_missed' AND aggregate_id=$1",
        [period3Id],
      );
      expect(emitted.rows).toHaveLength(1);
      expect(emitted.rows[0].payload).toMatchObject({ electionPeriodId: period3Id });

      const cw = await admin.query(
        "SELECT status, window_kind FROM compliance_window WHERE admission_id=$1 AND window_kind='f2f_recert_30d_prior'",
        [admissionId],
      );
      expect(cw.rows).toHaveLength(1);
      expect(cw.rows[0].status).toBe("overdue");

      // Second tick, same clock: the compliance_window row is already open → no re-emit.
      await runF2fWindowMissedScanCron(deps);
      const emittedAgain = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m6.f2f.window_missed' AND aggregate_id=$1",
        [period3Id],
      );
      expect(emittedAgain.rows).toHaveLength(1);
      const cwAgain = await admin.query(
        "SELECT id FROM compliance_window WHERE admission_id=$1 AND window_kind='f2f_recert_30d_prior'",
        [admissionId],
      );
      expect(cwAgain.rows).toHaveLength(1);
    });

    it("attested before the window lapses never emits", async () => {
      const { admissionId, period3Id, period2ScheduledEndAt } = await pendingRecertPeriod3(
        ORG_A,
        USER,
        MD,
      );

      // Schedule → complete → attest the F2F on period 3 BEFORE the clock passes windowEnd.
      const f2f = await svc.scheduleF2f(ORG_A, {
        admissionId,
        electionPeriodId: period3Id,
        scheduledClinicianId: USER,
        clinicianRole: "hospice_md",
        actor: SYSTEM_F2F_ACTOR,
      });
      // F-226 - completion computes the window from the REAL encounter date against the period's expected
      // start. Period 3 here starts ~90 days out (period 2 was just activated), so pull its start in to 10
      // days from now (the realistic shape: the prior period is about to end) and record yesterday's visit.
      await admin.query(
        "UPDATE election_period SET expected_start = current_date + 10 WHERE id=$1",
        [period3Id],
      );
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const done = await svc.completeF2f(ORG_A, f2f.id, f2f.version, yesterday);
      const attested = await svc.attestF2f(
        ORG_A,
        f2f.id,
        done.version,
        USER,
        F2F_ATTESTATION_NARRATIVE,
      );
      expect(attested.state).toBe("attested");

      const deps = buildM6WorkerDeps({
        connection: { host: "unused" } as never,
        db: handle.db,
        outbox: validatingM6Outbox(),
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      });
      deps.now = () => pastWindowEnd(period2ScheduledEndAt);

      await runF2fWindowMissedScanCron(deps);

      const emitted = await admin.query(
        "SELECT id FROM outbox_event WHERE event_type='m6.f2f.window_missed' AND aggregate_id=$1",
        [period3Id],
      );
      expect(emitted.rows).toHaveLength(0);
      const cw = await admin.query(
        "SELECT id FROM compliance_window WHERE admission_id=(SELECT admission_id FROM election_period WHERE id=$1) AND window_kind='f2f_recert_30d_prior' AND status <> 'closed'",
        [period3Id],
      );
      expect(cw.rows).toHaveLength(0);
    });

    it("cross-tenant: org B's scan never touches org A's admission (and vice versa)", async () => {
      const a = await pendingRecertPeriod3(ORG_A, USER, MD);
      const b = await pendingRecertPeriod3(ORG_B, USER_B, MD_B);

      const deps = buildM6WorkerDeps({
        connection: { host: "unused" } as never,
        db: handle.db,
        outbox: validatingM6Outbox(),
        activeOrgs: {
          listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
        },
      });
      // Both periods activated back-to-back in the same test run, so one shared "future" clears both.
      const furthestScheduledEndAt =
        a.period2ScheduledEndAt > b.period2ScheduledEndAt
          ? a.period2ScheduledEndAt
          : b.period2ScheduledEndAt;
      deps.now = () => pastWindowEnd(furthestScheduledEndAt);

      await runF2fWindowMissedScanCron(deps);

      const aEmitted = await admin.query(
        "SELECT organization_id, payload FROM outbox_event WHERE event_type='m6.f2f.window_missed' AND aggregate_id=$1",
        [a.period3Id],
      );
      expect(aEmitted.rows).toHaveLength(1);
      expect(aEmitted.rows[0].organization_id).toBe(ORG_A);
      expect(aEmitted.rows[0].payload).toMatchObject({ electionPeriodId: a.period3Id });

      const bEmitted = await admin.query(
        "SELECT organization_id, payload FROM outbox_event WHERE event_type='m6.f2f.window_missed' AND aggregate_id=$1",
        [b.period3Id],
      );
      expect(bEmitted.rows).toHaveLength(1);
      expect(bEmitted.rows[0].organization_id).toBe(ORG_B);
      expect(bEmitted.rows[0].payload).toMatchObject({ electionPeriodId: b.period3Id });

      // Org A's compliance_window row belongs to org A's admission only, and vice versa.
      const aCw = await admin.query(
        "SELECT organization_id FROM compliance_window WHERE admission_id=$1 AND window_kind='f2f_recert_30d_prior'",
        [a.admissionId],
      );
      expect(aCw.rows).toHaveLength(1);
      expect(aCw.rows[0].organization_id).toBe(ORG_A);
      const bCw = await admin.query(
        "SELECT organization_id FROM compliance_window WHERE admission_id=$1 AND window_kind='f2f_recert_30d_prior'",
        [b.admissionId],
      );
      expect(bCw.rows).toHaveLength(1);
      expect(bCw.rows[0].organization_id).toBe(ORG_B);
    });
  });
});
