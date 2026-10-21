/**
 * F-062 — M6's election-period state machine, actually reached.
 *
 * `transitionElectionPeriod` defines the §2.3.2 graph and its guards, and was called by nothing but its
 * own unit test: every write path set `election_period.status` with a bare UPDATE. So the graph rejected
 * nothing, and four §2.4 rules that exist only inside the machine never ran. This suite drives the real
 * Drizzle write service against real Postgres and pins each of them, most importantly:
 *
 *   · R-F2F-04 (42 CFR 418.22(a)(4)) — a third-or-later benefit period could be activated through
 *     `signCtiHospiceMd` with no attested face-to-face encounter. `decideRecertSign` advances any period
 *     ≥ 2 on the hospice-MD signature alone and has no F2F term at all.
 *   · R-EL-01 / R-EL-02 / R-EL-04 — a representative could sign an election with no DPOA authority, for
 *     a patient already elected elsewhere, with the curative-care acknowledgment declined.
 *
 * Also pins the state that had no writer: `election_period.status = 'signed'`. The real lifecycle was
 * `pending → active → completed`, so the documented graph could not have been followed even by a caller
 * that tried — `pending` accepts only `signElectionStatement`.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m6:election-guards:live
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
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
import { validatingM6Outbox } from "./_m6-outbox";
import { dischargeOrderBy, seedPhysicianRole } from "./_physician-signer";

/** Clinical content every CTI draft carries (`CtiDraftInput` requires it — CtiDraftSchema, route 22). */
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
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-11111111062a";
const USER = "33333333-3333-3333-3333-33333333062a";
const MD = "55555555-5555-5555-5555-55555555062a";
const ATTENDING = "77777777-7777-7777-7777-77777777062a";
const PROVIDER_ENTITY = "88888888-8888-8888-8888-88888888062a";
const PROVIDER_ENTITY_2 = "88888888-8888-8888-8888-88888888062b";

const DRAFT = {
  electedProviderEntityId: PROVIDER_ENTITY,
  electedAttendingPhysicianId: ATTENDING,
  waiverAcknowledged: true,
} as const;
const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;

describe.skipIf(!DB_URL)("F-062 — the election-period guards, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  /** The service with a DPOA port that ANSWERS — the production shape (M39's ConsentEvaluator seam). */
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
  /** The same service with NO DPOA port bound — proves the unbound default denies rather than allows. */
  let svcNoDpoa: ReturnType<typeof createDbAdmissionRouteService>;
  /** Patients this fake M39 answers "has an active dpoa_healthcare consent" for. */
  const dpoaPatients = new Set<string>();

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

  /** Referral → triage → qualify → accept: a period-1 admission with its statement/CTI still to come. */
  async function admit(patientId = randomUUID()) {
    // Main's intake: triage → qualify → accept (+ admission details) — see _m6-admit.ts.
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      hospicePhysicianId: MD,
      organizationId: ORG_A,
      actorUserId: USER,
      patientId,
    });
    const periods = await svc.listElectionPeriods(ORG_A, admissionId);
    return { admissionId, periodId: periods?.[0]?.id as string, patientId };
  }

  /** The full §418 activation ceremony through production writes only. */
  async function activate(patientId = randomUUID()) {
    const a = await admit(patientId);
    const nor = await svc.acknowledgeNor(
      ORG_A,
      a.admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    const es = await svc.draftElectionStatement(ORG_A, a.admissionId, a.periodId, DRAFT);
    await svc.signElection(ORG_A, es.id, es.version, USER, SIGN);
    const cti = await svc.draftCti(
      ORG_A,
      {
        electionPeriodId: a.periodId,
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: ATTENDING,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      USER,
    );
    await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    await svc.activateAdmission(ORG_A, a.admissionId, nor.version);
    return a;
  }

  /** A recert period at `sequence`, with a hospice-MD CTI ready to sign. Returns the CTI + period ids. */
  async function recertPeriod(admissionId: string, sequence: number) {
    const periodId = (
      await admin.query(
        // `pending` — a recertification period is never re-elected, so it never passes through `signed`.
        // F-226 - a pending period carries its EXPECTED START (the F2F window anchor): 10 days out.
        `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind, expected_start)
         VALUES ($1,$2,$3,$4, current_date + 10) RETURNING id`,
        [ORG_A, admissionId, sequence, sequence <= 2 ? "ninety_day" : "sixty_day"],
      )
    ).rows[0].id as string;
    const cti = await svc.draftCti(
      ORG_A,
      { electionPeriodId: periodId, hospiceMedicalDirectorId: MD, ...CTI_CLINICAL, isRecert: true },
      USER,
    );
    return { periodId, cti };
  }

  /**
   * Period 1 ends the day before the recert periods' expected start (`current_date + 10`); the hourly
   * auto-end cron on that start date completes it and starts the signed recert — a recert never starts on
   * its (early) signing day (42 CFR 418.21(a) contiguous periods, 418.22(a)(3) early recert).
   */
  async function runToRecertStart(admissionId: string) {
    const { rows } = await admin.query(
      `UPDATE election_period SET scheduled_end_at = current_date + 9
        WHERE admission_id=$1 AND sequence_number=1 RETURNING (current_date + 10)::text AS start`,
      [admissionId],
    );
    const start = rows[0].start as string;
    await runElectionPeriodAutoEndCron({
      connection: {} as never,
      db: handle.db,
      outbox: validatingM6Outbox(),
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      now: () => new Date(`${start}T17:00:00.000Z`),
    });
  }

  /** Record an ATTESTED face-to-face encounter on a period (what R-F2F-04 looks for). */
  async function attestF2f(periodId: string) {
    await admin.query(
      `INSERT INTO face_to_face_encounter (organization_id, election_period_id, performed_by_user_id,
                                           performer_role, encounter_date, within_window, status, attestation_signed_at,
                                           attestation_narrative)
       VALUES ($1,$2,$3,'hospice_md', current_date, true, 'attested', now(), $4)`, // encounter today: 10 days before the start
      [ORG_A, periodId, MD, "x".repeat(120)],
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-f062','A','A')",
      [ORG_A],
    );
    // MD and ATTENDING are real `user` rows, not free-floating uuids:
    // `face_to_face_encounter.performed_by_user_id` carries an FK to `user`, so `attestF2f` — the whole
    // premise of the two R-F2F-04 cases — raises 23503 without them. The CTI columns have no such FK,
    // which is why `activate()` never noticed.
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'f062@x.test'), ($2,'f062-md@x.test'), ($3,'f062-att@x.test')`,
      [USER, MD, ATTENDING],
    );
    // 42 CFR 418.26(b) — the live discharges below are dated today, so they carry a physician order.
    await seedPhysicianRole(admin, ORG_A, MD);
    await admin.query(
      `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,$2,'A Hospice','341234','1111111111','\\x00','12-31'),
                ($3,$2,'A Hospice Two','341236','3333333333','\\x00','12-31')`,
      [PROVIDER_ENTITY, ORG_A, PROVIDER_ENTITY_2],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    registerM5IntakeSeams(handle.db); // M5 intake seams M6 conversion + readiness consult
    const providerEntityOrgCheck = {
      async belongsToOrg(organizationId: string, providerEntityId: string) {
        const { rows } = await admin.query(
          "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
          [providerEntityId, organizationId],
        );
        return rows.length > 0;
      },
    };
    svc = createDbAdmissionRouteService(
      handle.db,
      validatingM6Outbox(), // F-100
      undefined,
      providerEntityOrgCheck,
      undefined,
      {
        // Stands in for M39's ConsentEvaluator seam. Production binds the real one in
        // `mountAdmissionRoutes`; this suite drives both answers.
        async hasActiveDpoaHealthcareConsent(_org: string, patientId: string) {
          return dpoaPatients.has(patientId);
        },
      },
    );
    svcNoDpoa = createDbAdmissionRouteService(
      handle.db,
      validatingM6Outbox(), // F-100
      undefined,
      providerEntityOrgCheck,
    );
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  describe("the `signed` state nothing used to write", () => {
    it("advances the period pending → signed when its election statement is signed", async () => {
      const a = await admit();
      const before = await admin.query("SELECT status FROM election_period WHERE id=$1", [
        a.periodId,
      ]);
      expect(before.rows[0].status).toBe("pending");

      const es = await svc.draftElectionStatement(ORG_A, a.admissionId, a.periodId, DRAFT);
      await svc.signElection(ORG_A, es.id, es.version, USER, SIGN);

      const after = await admin.query("SELECT status FROM election_period WHERE id=$1", [
        a.periodId,
      ]);
      expect(after.rows[0].status).toBe("signed");
    });

    it("reaches active only through signed, and completed only through active", async () => {
      const a = await activate();
      const active = await admin.query("SELECT status FROM election_period WHERE id=$1", [
        a.periodId,
      ]);
      expect(active.rows[0].status).toBe("active");

      await svc.discharge(
        ORG_A,
        a.admissionId,
        {
          reason: "moved_out_of_service_area",
          dischargeDate: new Date().toISOString().slice(0, 10),
          narrative: "relocated out of the service area",
          dischargeOrder: dischargeOrderBy(MD),
        },
        USER,
      );
      const done = await admin.query("SELECT status FROM election_period WHERE id=$1", [
        a.periodId,
      ]);
      expect(done.rows[0].status).toBe("completed");
    });

    it("leaves a never-started period alone when its admission is discharged", async () => {
      // `complete` is legal only from `active`. A period still `pending` when the admission ends never
      // ran, and stamping it `completed` would record an election that never happened.
      const a = await activate();
      const pending = (
        await admin.query(
          `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind)
           VALUES ($1,$2,2,'ninety_day') RETURNING id`,
          [ORG_A, a.admissionId],
        )
      ).rows[0].id as string;
      await svc.discharge(
        ORG_A,
        a.admissionId,
        {
          reason: "moved_out_of_service_area",
          dischargeDate: new Date().toISOString().slice(0, 10),
          narrative: "relocated out of the service area",
          dischargeOrder: dischargeOrderBy(MD),
        },
        USER,
      );
      const rows = await admin.query(
        "SELECT status, actual_end_at FROM election_period WHERE id = ANY($1)",
        [[a.periodId, pending]],
      );
      const byId = new Map(rows.rows.map((r, i) => [i, r]));
      expect(rows.rows.filter((r) => r.status === "completed")).toHaveLength(1);
      expect(rows.rows.filter((r) => r.status === "pending")).toHaveLength(1);
      void byId;
    });
  });

  describe("R-F2F-04 — 42 CFR 418.22(a)(4), the recert face-to-face", () => {
    it("refuses to activate a sequence-3 period with no attested F2F", async () => {
      const a = await activate();
      const { cti } = await recertPeriod(a.admissionId, 3);
      await expect(svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER)).rejects.toMatchObject({
        code: "F2F_REQUIRED_FOR_RECERT",
        statusCode: 409,
      });
    });

    it("activates the same period once the F2F is attested", async () => {
      const a = await activate();
      const { periodId, cti } = await recertPeriod(a.admissionId, 3);
      await attestF2f(periodId);
      const signed = await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
      expect(signed.state).toBe("signed");
      await runToRecertStart(a.admissionId);
      const { rows } = await admin.query("SELECT status FROM election_period WHERE id=$1", [
        periodId,
      ]);
      expect(rows[0].status).toBe("active");
    });

    it("does NOT require an F2F for period 2 — the rule starts at the third period", async () => {
      const a = await activate();
      const { periodId, cti } = await recertPeriod(a.admissionId, 2);
      const signed = await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
      expect(signed.state).toBe("signed");
      await runToRecertStart(a.admissionId);
      const { rows } = await admin.query("SELECT status FROM election_period WHERE id=$1", [
        periodId,
      ]);
      expect(rows[0].status).toBe("active");
    });

    it("does not accept a merely SCHEDULED face-to-face as attested", async () => {
      const a = await activate();
      const { periodId, cti } = await recertPeriod(a.admissionId, 4);
      await admin.query(
        `INSERT INTO face_to_face_encounter (organization_id, election_period_id, performed_by_user_id,
                                             performer_role, encounter_date, status)
         VALUES ($1,$2,$3,'hospice_md', now()::date, 'scheduled')`,
        [ORG_A, periodId, MD],
      );
      await expect(svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER)).rejects.toMatchObject({
        code: "F2F_REQUIRED_FOR_RECERT",
      });
    });
  });

  describe("R-EL-04 — the curative-care acknowledgment", () => {
    it("refuses to sign an election statement whose waiver was declined", async () => {
      const a = await admit();
      const es = await svc.draftElectionStatement(ORG_A, a.admissionId, a.periodId, {
        ...DRAFT,
        waiverAcknowledged: false,
      });
      await expect(svc.signElection(ORG_A, es.id, es.version, USER, SIGN)).rejects.toMatchObject({
        code: "CURATIVE_CARE_ACK_REQUIRED",
        statusCode: 422,
      });
      // ...and the period stays where it was, rather than half-advancing.
      const { rows } = await admin.query("SELECT status FROM election_period WHERE id=$1", [
        a.periodId,
      ]);
      expect(rows[0].status).toBe("pending");
    });

    it("reads the acknowledgment from the PERSISTED draft, not from the sign request", async () => {
      // The signing call carries a name and a role and nothing else — there is deliberately no field on
      // it that could supply the acknowledgment the patient was or was not shown.
      const a = await admit();
      const es = await svc.draftElectionStatement(ORG_A, a.admissionId, a.periodId, {
        ...DRAFT,
        waiverAcknowledged: false,
      });
      await admin.query(
        "UPDATE election_statement SET curative_care_acknowledgment = true WHERE id=$1",
        [es.id],
      );
      const signed = await svc.signElection(ORG_A, es.id, es.version, USER, SIGN);
      expect(signed.state).toBe("signed");
    });
  });

  describe("R-EL-01 — representative signing authority", () => {
    it("refuses a representative-signed election with no active DPOA consent", async () => {
      const a = await admit();
      const es = await svc.draftElectionStatement(ORG_A, a.admissionId, a.periodId, DRAFT);
      await expect(
        svc.signElection(ORG_A, es.id, es.version, USER, {
          signingPatientName: "Rep Resentative",
          // `legal_representative` is the WIRE vocabulary (`ElectionSignSchema`); `representative` is the
          // COLUMN enum, and `SIGNER_KIND_BY_ROLE` exists to map between them. This case used to pass the
          // column value, which is not a key of that map — so `signerKind` was `undefined` and R-EL-01 was
          // skipped entirely (F-089). `apps/backend/tsconfig.json` includes only `src`, so nothing objected.
          signingRole: "legal_representative",
        }),
      ).rejects.toMatchObject({ code: "REPRESENTATIVE_AUTHORITY_MISSING", statusCode: 403 });
    });

    it("allows it once M39 reports an active dpoa_healthcare consent", async () => {
      const a = await admit();
      dpoaPatients.add(a.patientId);
      const es = await svc.draftElectionStatement(ORG_A, a.admissionId, a.periodId, DRAFT);
      const signed = await svc.signElection(ORG_A, es.id, es.version, USER, {
        signingPatientName: "Rep Resentative",
        signingRole: "legal_representative",
      });
      expect(signed.state).toBe("signed");
    });

    it("never reaches the consent port for a PATIENT-signed election", async () => {
      // The unbound-port service denies every representative signature; a patient signature must be
      // unaffected, or binding M39 would become a prerequisite for ordinary admissions.
      const a = await admit();
      const es = await svcNoDpoa.draftElectionStatement(ORG_A, a.admissionId, a.periodId, DRAFT);
      const signed = await svcNoDpoa.signElection(ORG_A, es.id, es.version, USER, SIGN);
      expect(signed.state).toBe("signed");
    });

    it("DENIES rather than allows when no consent port is bound at all", async () => {
      const a = await admit();
      dpoaPatients.add(a.patientId); // would pass if the port were consulted; it is not bound here
      const es = await svcNoDpoa.draftElectionStatement(ORG_A, a.admissionId, a.periodId, DRAFT);
      await expect(
        svcNoDpoa.signElection(ORG_A, es.id, es.version, USER, {
          signingPatientName: "Rep Resentative",
          signingRole: "legal_representative",
        }),
      ).rejects.toMatchObject({ code: "REPRESENTATIVE_AUTHORITY_MISSING" });
    });
  });

  describe("R-EL-02 / the overlap guard — one election at a time", () => {
    /**
     * A PRIOR admission for this patient, discharged, whose election period was never completed —
     * seeded directly, because it is the only shape in which these two guards can fire (F-089).
     *
     * Both cases used to build a second CONCURRENT admission through `admit(patientId)`, and died in
     * the helper rather than in the machine they name. They have never passed, and could not have:
     * a patient cannot hold two open admissions in an org at ALL. `acceptReferral` runs the
     * `createAdmission` transition first, whose `hasOtherOpenAdmission` guard refuses it, and beneath
     * that `admission_patient_open_idx` (0026) is a DATABASE unique index on (organization_id,
     * patient_id) WHERE status NOT IN ('discharged','bereavement','closed'). Two layers, neither of
     * which the election machine is behind.
     *
     * What `concurrentElectionFacts` actually asks is narrower than "concurrent admission" and is
     * what makes the guards live code: it looks for a non-`completed` election period on a DIFFERENT
     * admission of the same patient. A properly discharged admission completes its period — which is
     * why the re-election case below passes — so this fires exactly when a prior election was left
     * open: a discharge that did not complete the period, an import, a repair. Then a re-election is
     * refused, as PATIENT_ALREADY_ELECTED when the stale period sits at another provider entity and
     * as ELECTION_PERIOD_OVERLAP when it sits at this one (`checkNoConcurrentElection` runs first,
     * and only it is provider-entity-sensitive).
     */
    async function seedStalePriorElection(patientId: string, providerEntityId: string) {
      const admissionId = (
        await admin.query(
          `INSERT INTO admission (organization_id, patient_id, provider_entity_id, status)
           VALUES ($1,$2,$3,'discharged') RETURNING id`,
          [ORG_A, patientId, providerEntityId],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind, status)
         VALUES ($1,$2,1,'ninety_day','active')`,
        [ORG_A, admissionId],
      );
      return admissionId;
    }

    it("refuses to elect a patient who is already elected at another provider entity", async () => {
      const patientId = randomUUID();
      await seedStalePriorElection(patientId, PROVIDER_ENTITY_2);

      const second = await admit(patientId);
      const es = await svc.draftElectionStatement(
        ORG_A,
        second.admissionId,
        second.periodId,
        DRAFT,
      );
      await expect(svc.signElection(ORG_A, es.id, es.version, USER, SIGN)).rejects.toMatchObject({
        code: "PATIENT_ALREADY_ELECTED",
        statusCode: 409,
      });
    });

    it("refuses a second concurrent election at the SAME hospice as an overlap", async () => {
      const patientId = randomUUID();
      await seedStalePriorElection(patientId, PROVIDER_ENTITY);
      const second = await admit(patientId);
      const es = await svc.draftElectionStatement(
        ORG_A,
        second.admissionId,
        second.periodId,
        DRAFT,
      );
      await expect(svc.signElection(ORG_A, es.id, es.version, USER, SIGN)).rejects.toMatchObject({
        code: "ELECTION_PERIOD_OVERLAP",
        statusCode: 409,
      });
    });

    // …and the outer gate those two step around is asserted here, so stepping around it cannot
    // quietly become a way of not testing it. This is the refusal the old versions actually got.
    it("the referral path refuses a second OPEN admission before the election machine is reached", async () => {
      const patientId = randomUUID();
      await activate(patientId);
      await expect(admit(patientId)).rejects.toMatchObject({ code: "PATIENT_ALREADY_ELECTED" });
    });

    it("allows a re-election once the prior admission has been discharged", async () => {
      const patientId = randomUUID();
      const first = await activate(patientId);
      await svc.discharge(
        ORG_A,
        first.admissionId,
        {
          reason: "moved_out_of_service_area",
          dischargeDate: new Date().toISOString().slice(0, 10),
          narrative: "relocated out of the service area",
          dischargeOrder: dischargeOrderBy(MD),
        },
        USER,
      );
      const second = await admit(patientId);
      const es = await svc.draftElectionStatement(
        ORG_A,
        second.admissionId,
        second.periodId,
        DRAFT,
      );
      const signed = await svc.signElection(ORG_A, es.id, es.version, USER, SIGN);
      expect(signed.state).toBe("signed");
    });

    it("does not treat a LATER period of the SAME admission as an overlap", async () => {
      // Sequential benefit periods on one admission are the normal case; counting them would refuse
      // every recertification.
      const a = await activate();
      const { periodId } = await recertPeriod(a.admissionId, 2);
      const es = await svc.draftElectionStatement(ORG_A, a.admissionId, periodId, DRAFT);
      const signed = await svc.signElection(ORG_A, es.id, es.version, USER, SIGN);
      expect(signed.state).toBe("signed");
    });
  });

  describe("R-AC-01's `election_signed` precondition", () => {
    it("is not satisfied by a merely DRAFTED election statement", async () => {
      // The gate asked whether a statement EXISTS, with no status filter, so a draft satisfied "signed"
      // and the precondition could not fail for the reason it names.
      const a = await admit();
      const nor = await svc.acknowledgeNor(
        ORG_A,
        a.admissionId,
        { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
        USER,
      );
      await svc.draftElectionStatement(ORG_A, a.admissionId, a.periodId, DRAFT); // drafted, NOT signed
      await admin.query(
        `INSERT INTO certification_of_terminal_illness (organization_id, election_period_id, hospice_md_id,
           attending_md_id, terminal_diagnosis_icd10, narrative, period_start, period_end,
           hospice_md_signed_at, attending_md_signed_at)
         VALUES ($1,$2,$3,$3,'C34.90','Terminal', now()::date, now()::date + 90, now(), now())`,
        [ORG_A, a.periodId, MD],
      );
      await expect(svc.activateAdmission(ORG_A, a.admissionId, nor.version)).rejects.toMatchObject({
        statusCode: 412,
      });
      const detail = await svc.getAdmission(ORG_A, a.admissionId);
      expect(detail?.activationGate?.missing).toContain("election_signed");
    });
  });
});
