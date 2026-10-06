/**
 * FY2027 — LIVE Postgres proof of the 42 CFR 418.24(c)/(d) election statement addendum, as the real NOBYPASSRLS
 * `wardenx_app` role, with the REAL catalog-validating M6 outbox publisher and admissions built through the
 * production write service (referral → NOR → election → CTI → activation).
 *
 *   · activation of an election effective >= 2026-10-01 opens draft v1 + the 5-day `election_addendum_initial`
 *     window (due = effective date + 5 calendar days) and emits `m6.election_addendum.drafted`
 *   · draft() pre-fills from the sources (identity, diagnoses, M7-shaped non-covered items)
 *   · furnish refuses an incomplete addendum, then closes the window and emits the render request
 *   · a refusal without a reason is refused; a signature settles the version
 *   · openAddendumUpdateWindow opens v2 + the 3-day `election_addendum_update` window; an unchanged signed
 *     plan-of-care diff is a no-op
 *   · the overdue scan alerts exactly once (`m6.election_addendum.overdue`)
 *   · a death discharge settles the open draft as `not_required` and closes the window
 *   · the M23 snapshot reflects the record; M7's real problem reader returns the unrelated problem only
 *   · RLS: org B sees none of org A's addendum rows and cannot write one
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m6:election-addendum:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient, organizationTimezone } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { NonCoveredItemSnapshot } from "@wardenx/types";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import {
  createElectionAddendumService,
  electionAddendumComplianceForOrg,
  initialAddendumDue,
} from "../src/modules/06-admission/election-addendum/index";
import { runElectionAddendumOverdueScanCron } from "../src/modules/06-admission/jobs/cron-workers";
import { createUnrelatedProblemItemsReader } from "../src/modules/07-care-plan/seams/addendum-sources";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
import { validatingM6Outbox } from "./_m6-outbox";

const NARRATIVE_OK =
  "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care. The prognosis of six months or less is supported by serial decline in functional status, nutritional intake and symptom burden.";
const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative: NARRATIVE_OK,
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-1111111ea01a";
const ORG_B = "22222222-2222-2222-2222-2222222ea01b";
const USER = "33333333-3333-3333-3333-3333333ea01a";
const MD = "55555555-5555-5555-5555-5555555ea01a";
const ATTENDING = "77777777-7777-7777-7777-7777777ea01a";
const PROVIDER_ENTITY = "88888888-8888-8888-8888-8888888ea01a";
const SIGN = { signingPatientName: "Test Patient", signingRole: "patient" } as const;

describe.skipIf(!DB_URL)(
  "FY2027 election statement addendum (42 CFR 418.24(c)/(d)) — LIVE Postgres (wardenx_app role)",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let svc: ReturnType<typeof createDbAdmissionRouteService>;
    let addendum: ReturnType<typeof createElectionAddendumService>;
    let reportedItems: NonCoveredItemSnapshot[] = [];

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

    async function activate(org = ORG_A) {
      const patientId = randomUUID();
      const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
        hospicePhysicianId: MD,
        organizationId: org,
        actorUserId: USER,
        patientId,
      });
      const periodId = (await svc.listElectionPeriods(org, admissionId))?.[0]?.id as string;
      const nor = await svc.acknowledgeNor(
        org,
        admissionId,
        { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
        USER,
      );
      const es = await svc.draftElectionStatement(org, admissionId, periodId, {
        electedProviderEntityId: PROVIDER_ENTITY,
        electedAttendingPhysicianId: ATTENDING,
        waiverAcknowledged: true,
      });
      await svc.signElection(org, es.id, es.version, USER, SIGN);
      const cti = await svc.draftCti(
        org,
        {
          electionPeriodId: periodId,
          hospiceMedicalDirectorId: MD,
          attendingPhysicianId: ATTENDING,
          ...CTI_CLINICAL,
          isRecert: false,
        },
        USER,
      );
      await svc.signCtiHospiceMd(org, cti.id, cti.version, USER);
      await svc.activateAdmission(org, admissionId, nor.version);
      return { admissionId, patientId };
    }

    const windows = async (admissionId: string) =>
      (
        await admin.query(
          `SELECT window_kind AS kind, status, must_complete_by AS "due", close_reason AS "closeReason"
             FROM compliance_window
            WHERE admission_id=$1 AND window_kind::text LIKE 'election_addendum%'
            ORDER BY created_at`,
          [admissionId],
        )
      ).rows as { kind: string; status: string; due: Date; closeReason: string | null }[];
    const events = async (name: string, admissionId: string) =>
      (
        await admin.query(
          `SELECT payload FROM outbox_event WHERE event_type=$1 AND payload->>'admissionId'=$2`,
          [name, admissionId],
        )
      ).rows.map((r) => r.payload as Record<string, unknown>);

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name)
         VALUES ($1,'org-ea-a','A','A'), ($2,'org-ea-b','B','B')`,
        [ORG_A, ORG_B],
      );
      await admin.query(
        `INSERT INTO "user" (id,email) VALUES ($1,'ea@x.test'), ($2,'ea-md@x.test'), ($3,'ea-att@x.test')`,
        [USER, MD, ATTENDING],
      );
      await admin.query(
        `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,$2,'Example Hospice','341234','1111111111','\\x00','12-31')`,
        [PROVIDER_ENTITY, ORG_A],
      );
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
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
      addendum = createElectionAddendumService({
        db: handle.db,
        outbox: validatingM6Outbox(),
        sources: {
          nonCoveredItems: { listForAdmission: async () => reportedItems },
          diagnoses: {
            diagnosesForAdmission: async () => ({
              terminal: [{ icd10Code: "C34.90", description: "Lung cancer" }],
              related: [],
            }),
          },
          patientIdentity: async () => ({ name: "Test Patient", mrn: "MRN-EA-1" }),
        },
      });
    }, 240_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("activation opens draft v1 and the 5-day initial window (effective date + 5 calendar days)", async () => {
      const { admissionId } = await activate();
      const ov = await addendum.overview(ORG_A, admissionId);
      expect(ov?.required).toBe(true);
      expect(ov?.current).toMatchObject({ versionNumber: 1, trigger: "initial", status: "draft" });
      expect(ov?.current?.hospiceName).toBe("Example Hospice");
      const tz = await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        organizationTimezone(tx as never, ORG_A),
      );
      const due = initialAddendumDue(ov?.electionEffectiveDate as string, tz);
      expect(ov?.current?.dueAt).toBe(due.dueAt);
      const [w] = await windows(admissionId);
      expect(w).toMatchObject({ kind: "election_addendum_initial", status: "open" });
      expect(w?.due.toISOString()).toBe(due.dueAt);
      expect(await events("m6.election_addendum.drafted", admissionId)).toHaveLength(1);
    });

    it("draft → furnish → refusal guard → signature, through the real publisher", async () => {
      const { admissionId } = await activate();
      reportedItems = [
        {
          source: "problem",
          sourceId: randomUUID(),
          category: "condition",
          description: "Condition A",
          reason: "Unrelated to the terminal illness",
          determinedAt: new Date().toISOString(),
          determinedByUserId: null,
        },
      ];
      const ov = await addendum.draft(ORG_A, admissionId, USER);
      const draft = ov.current;
      expect(draft?.patientName).toBe("Test Patient");
      expect(draft?.medicalRecordNumber).toBe("MRN-EA-1");
      expect(draft?.items).toHaveLength(1);
      expect(draft?.terminalDiagnosis).toEqual([
        { icd10Code: "C34.90", description: "Lung cancer" },
      ]);

      // (c)(6): a list without a clinical explanation cannot be furnished.
      await expect(
        addendum.furnish(
          ORG_A,
          admissionId,
          draft?.id as string,
          draft?.version as number,
          { method: "paper" },
          USER,
        ),
      ).rejects.toThrow(/clinical explanation/);
      const edited = await addendum.updateDraft(
        ORG_A,
        admissionId,
        draft?.id as string,
        draft?.version as number,
        { clinicalExplanation: "This condition is managed by your own doctor." },
        USER,
      );
      const furnished = await addendum.furnish(
        ORG_A,
        admissionId,
        edited.id,
        edited.version,
        { method: "paper" },
        USER,
      );
      expect(furnished.status).toBe("furnished");
      expect((await windows(admissionId))[0]).toMatchObject({
        status: "closed",
        closeReason: "furnished",
      });
      const [render] = await events("m6.election_addendum.furnished", admissionId);
      expect((render?.renderPayload as { title: string }).title).toBe(
        "Patient Notification of Hospice Non-Covered Items, Services, and Drugs",
      );

      await expect(
        addendum.recordRefusal(
          ORG_A,
          admissionId,
          furnished.id,
          furnished.version,
          { reason: "no" },
          USER,
        ),
      ).rejects.toThrow(/418.24\(c\)\(9\)/);
      const signed = await addendum.recordSignature(
        ORG_A,
        admissionId,
        furnished.id,
        furnished.version,
        { signerKind: "beneficiary" },
        USER,
      );
      expect(signed.status).toBe("signed");
      expect(await events("m6.election_addendum.acknowledged", admissionId)).toHaveLength(1);
      const snap = await electionAddendumComplianceForOrg(handle.db, ORG_A, admissionId);
      expect(snap).toMatchObject({ anySigned: true, versionCount: 1, leftCareReason: null });

      // 418.24(d)(2): a plan-of-care change opens v2 + the 3-day window; an unchanged diff does not.
      const same = await addendum.openAddendumUpdateWindow(
        ORG_A,
        admissionId,
        new Date(),
        "m7.care_plan.version_signed",
        {
          requireDiff: true,
        },
      );
      expect(same.outcome).toBe("unchanged");
      reportedItems = [];
      const changed = await addendum.openAddendumUpdateWindow(
        ORG_A,
        admissionId,
        new Date(),
        "m7.problem.resolved",
      );
      expect(changed.outcome).toBe("update_opened");
      const ov2 = await addendum.overview(ORG_A, admissionId);
      expect(ov2?.current).toMatchObject({
        versionNumber: 2,
        trigger: "poc_change",
        status: "draft",
      });
      expect(ov2?.current?.items).toEqual([]);
      expect(ov2?.openWindows.map((w) => w.kind)).toEqual(["election_addendum_update"]);
      // A second change while the draft is open is absorbed by it (no v3).
      const again = await addendum.openAddendumUpdateWindow(
        ORG_A,
        admissionId,
        new Date(),
        "m7.problem.added",
      );
      expect(again.outcome).toBe("draft_refreshed");
    });

    it("the overdue scan alerts exactly once; a death discharge settles the draft as not_required", async () => {
      const { admissionId } = await activate();
      await admin.query(
        `UPDATE compliance_window SET must_complete_by = now() - interval '1 hour'
          WHERE admission_id=$1 AND window_kind='election_addendum_initial'`,
        [admissionId],
      );
      const deps = {
        connection: {} as never,
        db: handle.db,
        outbox: validatingM6Outbox(),
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      };
      expect(await runElectionAddendumOverdueScanCron(deps)).toBeGreaterThanOrEqual(1);
      await runElectionAddendumOverdueScanCron(deps);
      const overdue = await events("m6.election_addendum.overdue", admissionId);
      expect(overdue).toHaveLength(1);
      expect(overdue[0]).toMatchObject({ windowKind: "election_addendum_initial" });

      await svc.discharge(
        ORG_A,
        admissionId,
        {
          reason: "death",
          dischargeDate: new Date().toISOString().slice(0, 10),
          narrative: "Patient died at home, family present.",
          deathCertifierId: MD,
        } as never,
        USER,
      );
      const ov = await addendum.overview(ORG_A, admissionId);
      expect(ov?.current).toMatchObject({
        status: "not_required",
        signatureNotRequiredReason: "death",
      });
      expect(ov?.openWindows).toEqual([]);
      expect(await events("m6.election_addendum.not_required", admissionId)).toHaveLength(1);
      const snap = await electionAddendumComplianceForOrg(handle.db, ORG_A, admissionId);
      expect(snap).toMatchObject({ anyExemptionDocumented: true, leftCareReason: "death" });
    });

    it("M7's problem reader returns active, non-Part-2 unrelated problems only", async () => {
      const { admissionId, patientId } = await activate();
      const planId = randomUUID();
      await admin.query(
        `INSERT INTO care_plan (id, organization_id, patient_id, admission_id, initial_due_at) VALUES ($1,$2,$3,$4, now() + interval '5 days')`,
        [planId, ORG_A, patientId, admissionId],
      );
      await admin.query(
        `INSERT INTO problem (organization_id, care_plan_id, description, kind, sud_related, status, icd10_code) VALUES
           ($1,$2,'Unrelated condition','unrelated',false,'active','E11.9'),
           ($1,$2,'Part 2 condition','unrelated',true,'active',NULL),
           ($1,$2,'Resolved condition','unrelated',false,'resolved',NULL),
           ($1,$2,'Terminal condition','terminal',false,'active','C34.90')`,
        [ORG_A, planId],
      );
      const items = await createUnrelatedProblemItemsReader(handle.db).listForAdmission(
        ORG_A,
        admissionId,
      );
      expect(items.map((i) => i.description)).toEqual(["Unrelated condition (E11.9)"]);
      // Cross-tenant: org B's context sees nothing of org A's plan.
      expect(
        await createUnrelatedProblemItemsReader(handle.db).listForAdmission(ORG_B, admissionId),
      ).toEqual([]);
    });

    it("RLS: org B can neither read nor write org A's addendum rows", async () => {
      const { admissionId, patientId } = await activate();
      const asB = await withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, (tx) =>
        tx.execute(sql`SELECT id FROM election_addendum WHERE admission_id = ${admissionId}`),
      );
      expect(asB.rows).toEqual([]);
      expect(await addendum.overview(ORG_B, admissionId)).toBeNull();
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, (tx) =>
          tx.execute(sql`INSERT INTO election_addendum
              (organization_id, patient_id, admission_id, version_number, trigger, triggered_at)
              VALUES (${ORG_A}, ${patientId}, ${admissionId}, 9, 'initial', now())`),
        ),
      ).rejects.toThrow();
      const { rows } = await admin.query(
        "SELECT count(*)::int AS n FROM election_addendum WHERE admission_id=$1",
        [admissionId],
      );
      expect(rows[0].n).toBe(1);
    });
  },
);
