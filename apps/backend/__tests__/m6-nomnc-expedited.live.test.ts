/**
 * Milestone 10a — NOMNC delivery + BFCC-QIO expedited review record-keeping, LIVE Postgres as the real NOBYPASSRLS
 * `chartwarden_app` role, with the REAL catalog-validating M6 outbox publisher (never NOOP_OUTBOX), through the real
 * routes (header-shim authenticate, DB-backed RBAC, M6's admission.scope ABAC) and admissions built through the
 * production write service.
 *
 *   · record / supersede / withdraw; one ACTIVE notice per admission (service + partial unique index)
 *   · a source note is required (API refusal AND the DB CHECK); a date without a time is refused, never defaulted
 *   · a cross-tenant admission id is refused, a cross-tenant read returns nothing, a forged cross-tenant insert fails
 *   · the review state machine (open -> decided), the frozen-once-decided guard (service AND DB trigger)
 *   · the deadline guard freeze, and one unsatisfied deadline per (subject, kind)
 *   · the 15-minute scan emits each boundary once and overdue once; a satisfied deadline / decided review never alerts
 *   · the read-audit event lands; nomnc.read / nomnc.record are granted by migration 1230 to the right roles only
 *   · route 39 still discharges with a review open (nothing blocks a discharge); the hub buckets list the rows
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m6:nomnc-expedited:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createPredicateRegistry,
  registerAbacRegistry,
  registerDbEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDocumentReaderEvidenceValidator } from "../src/modules/06-admission/admission-document-validator";
import { createDrizzleDocumentReaderStore } from "../src/modules/22-documents/seams/drizzle-readers-store";
import { createDocumentReader } from "../src/modules/22-documents/seams/readers";
import { buildAdmissionAbacPredicates } from "../src/modules/06-admission/abac-predicates";
import {
  createDbAdmissionAbacResolver,
  createDbAdmissionRouteService,
} from "../src/modules/06-admission/admission-route-service-db";
import { createDbDischargeWorklistService } from "../src/modules/06-admission/discharge-worklist-service-db";
import { markAndPublish } from "../src/modules/06-admission/nomnc/scan";
import { runExpeditedDeadlineScanCron } from "../src/modules/06-admission/jobs/cron-workers";
import { type NomncService, createNomncService } from "../src/modules/06-admission/nomnc/index";
import { registerNomncRoutes } from "../src/modules/06-admission/routes/nomnc-routes";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
import { validatingM6Outbox } from "./_m6-outbox";
import { dischargeOrderBy, seedPhysicianRole } from "./_physician-signer";

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
const MIGRATION_1230 = "1230_m6_nomnc_expedited_review.sql";
const ORG_A = "11111111-1111-1111-1111-1111111a1a1a";
const ORG_B = "22222222-2222-2222-2222-2222222b1b1b";
const USER = "33333333-3333-3333-3333-3333333a1a1a";
const MD = "55555555-5555-5555-5555-5555555a1a1a";
const ATTENDING = "77777777-7777-7777-7777-7777777a1a1a";
const SIGN = { signingPatientName: "Test Patient", signingRole: "patient" } as const;
const HOUR = 3_600_000;
const PAST_DATE = "2026-01-10";

describe.skipIf(!DB_URL)(
  "Milestone 10a NOMNC / expedited review — LIVE Postgres (chartwarden_app role)",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let svc: ReturnType<typeof createDbAdmissionRouteService>;
    let nomnc: NomncService;
    let app: FastifyInstance;
    let providerA = "";
    let locationA = "";
    let reader = "";
    let recorder = "";
    let recorderB = "";

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
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort())
        await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    const one = async <T>(q: string, p: unknown[] = []): Promise<T> =>
      (await admin.query(q, p)).rows[0] as T;

    /** Insert a tenant role (or return the existing one). */
    async function roleIn(org: string, key: string): Promise<string> {
      const inserted = await admin.query<{ id: string }>(
        `INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,'clinical_staff')
         ON CONFLICT DO NOTHING RETURNING id`,
        [org, key],
      );
      return (
        inserted.rows[0]?.id ??
        (await one<{ id: string }>("SELECT id FROM role WHERE organization_id=$1 AND key=$2", [org, key]))
          .id
      );
    }
    /** A user with an active membership in `org`, bound to `roleKey`, holding `permissionKeys` via that role. */
    async function staff(org: string, roleKey: string, permissionKeys: string[]): Promise<string> {
      const userId = randomUUID();
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [userId, `${userId}@x.test`]);
      const m = await one<{ id: string }>(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userId, org],
      );
      const roleId = await roleIn(org, roleKey);
      await admin.query(
        "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
        [org, m.id, roleId],
      );
      for (const key of permissionKeys)
        await admin.query(
          `INSERT INTO role_permission (organization_id, role_id, permission_key) VALUES ($1,$2,$3)
           ON CONFLICT DO NOTHING`,
          [org, roleId, key],
        );
      return userId;
    }

    /** The §418.24 chain through the REAL write service to an ACTIVE admission, sited at provider A. */
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
        electedProviderEntityId: providerA,
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
      // The route ABAC is site-scoped; M5 sites the chart on activation in production, here it is seeded.
      await admin.query("UPDATE admission SET provider_entity_id=$2, location_id=$3 WHERE id=$1", [
        admissionId,
        providerA,
        locationA,
      ]);
      return { admissionId, patientId };
    }

    const noticeBody = (over: Record<string, unknown> = {}) => ({
      servicesEndOn: "2026-01-14",
      delivered: { date: PAST_DATE, time: "10:30" },
      recipientKind: "beneficiary",
      sourceNote: "NOMNC copy, signed page 2",
      ...over,
    });
    /** `stepUp` = a FRESH second factor on the session (the stub below reads it; the real ceremony is proven by
     *  ac-03 / gap-003). Default fresh so the rest of the suite is unchanged; the step-up test passes false. */
    const as = (userId: string, org = ORG_A, stepUp = true) => ({
      "x-test-stepup": stepUp ? "1" : "0",
      "x-test-user": userId,
      "x-test-org": org,
      "x-test-roles": "nomnc_role",
      "x-test-pe": org === ORG_A ? providerA : "",
    });
    const call = (
      method: "GET" | "POST" | "PATCH",
      url: string,
      headers: Record<string, string>,
      payload?: Record<string, unknown>,
    ) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    const codeOf = (res: { json(): { error?: { code?: string }; code?: string } }) =>
      res.json().error?.code ?? res.json().code;
    const events = async (name: string, admissionId: string) =>
      (
        await admin.query(
          `SELECT payload FROM outbox_event WHERE event_type=$1 AND payload->>'admissionId'=$2 ORDER BY created_at`,
          [name, admissionId],
        )
      ).rows.map((r) => r.payload as Record<string, unknown>);

    /** Make a typed deadline due at an exact instant (the scan reads `due_at`; admin bypasses the typed path). */
    async function dueAt(deadlineId: string, at: Date) {
      await admin.query("UPDATE expedited_deadline SET due_at=$2, last_alerted_boundary_hours=NULL, overdue_alerted_at=NULL WHERE id=$1", [
        deadlineId,
        at.toISOString(),
      ]);
    }
    const scan = (now: Date) =>
      runExpeditedDeadlineScanCron({
        db: handle.db,
        outbox: validatingM6Outbox(),
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        connection: {} as never,
        now: () => now,
      });

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-nm-a','A','A'), ($2,'org-nm-b','B','B')`,
        [ORG_A, ORG_B],
      );
      await admin.query(
        `INSERT INTO "user" (id,email) VALUES ($1,'nm@x.test'), ($2,'nm-md@x.test'), ($3,'nm-att@x.test')`,
        [USER, MD, ATTENDING],
      );
      await seedPhysicianRole(admin, ORG_A, MD);
      providerA = (
        await one<{ id: string }>(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,'341234','Example Hospice','1111111111','\\x00','12-31') RETURNING id`,
          [ORG_A],
        )
      ).id;
      locationA = (
        await one<{ id: string }>(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
             VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerA],
        )
      ).id;
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
      nomnc = createNomncService({
        db: handle.db,
        outbox: validatingM6Outbox(),
        // The REAL M22 DocumentReader (RLS-scoped through the request context) behind the shared check.
        documentValidator: createDocumentReaderEvidenceValidator(() =>
          createDocumentReader(createDrizzleDocumentReaderStore(handle.db)),
        ),
      });

      // RBAC: 'reader' holds admission.read only; 'recorder' also holds a discharge key. Migration 1230 is re-run once
      // the roles exist (as in a tenant that created them earlier) and must grant nomnc.read / nomnc.record.
      reader = await staff(ORG_A, "nomnc_reader", ["admission.read"]);
      recorder = await staff(ORG_A, "nomnc_recorder", [
        "admission.read",
        "discharge.no_longer_terminal",
      ]);
      recorderB = await staff(ORG_B, "nomnc_recorder", [
        "admission.read",
        "discharge.no_longer_terminal",
      ]);
      await admin.query(readFileSync(join(MIGRATIONS_DIR, MIGRATION_1230), "utf8"));

      resetAuthorizationContract();
      resetRbacEngine();
      registerDbEffectivePermissionResolver(handle.db);
      const registry = createPredicateRegistry();
      for (const [name, fn] of Object.entries(
        buildAdmissionAbacPredicates({
          resolver: createDbAdmissionAbacResolver(handle.db),
          isInCaseload: async () => false,
        }),
      ))
        registry.register(name, fn);
      // the M3 `step_up_recent` predicate, stubbed to the session attribute the header sets
      registry.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
      registerAbacRegistry(registry);
      app = buildServer({
        db: handle.db,
        authenticate: (request: FastifyRequest) => {
          const user = request.headers["x-test-user"];
          if (typeof user !== "string") return;
          request.context.userId = user;
          request.context.organizationId = String(request.headers["x-test-org"]);
          request.context.roles = String(request.headers["x-test-roles"] ?? "").split(",");
          const pe = String(request.headers["x-test-pe"] ?? "");
          request.context.providerEntityIds = pe ? [pe] : [];
          request.context.locationIds = [];
          request.context.attributes = {
            ...request.context.attributes,
            stepUpRecent: request.headers["x-test-stepup"] === "1",
          };
        },
        security: { rateLimitEnabled: false },
      });
      registerNomncRoutes(app, { service: nomnc });
      await app.ready();
    }, 300_000);

    afterAll(async () => {
      await app?.close();
      resetAuthorizationContract();
      resetRbacEngine();
      await handle?.close();
      if (admin) await admin.end();
    });

    it("migration 1230 grants nomnc.read to admission.read holders and nomnc.record to discharge-key holders only", async () => {
      const grants = async (userId: string) =>
        (
          await admin.query(
            `SELECT DISTINCT rp.permission_key AS k FROM role_permission rp
               JOIN membership_role mr ON mr.role_id = rp.role_id
               JOIN membership m ON m.id = mr.membership_id
              WHERE m.user_id=$1 AND rp.permission_key LIKE 'nomnc.%' ORDER BY 1`,
            [userId],
          )
        ).rows.map((r) => r.k as string);
      expect(await grants(reader)).toEqual(["nomnc.read"]);
      expect(await grants(recorder)).toEqual(["nomnc.read", "nomnc.record"]);
      // an auditor-shaped role (no admission / discharge key) gains nothing
      const auditorish = await staff(ORG_A, "external_auditor", []);
      expect(await grants(auditorish)).toEqual([]);
    });

    it("records a notice as typed, supersedes it, and holds ONE active notice per admission", async () => {
      const { admissionId, patientId } = await activate();
      // a missing source note is refused by the API...
      const noNote = await call("POST", `/api/v1/admissions/${admissionId}/nomnc`, as(recorder), noticeBody({ sourceNote: "  " }));
      expect(noNote.statusCode).toBe(422);
      expect(codeOf(noNote)).toBe("SOURCE_NOTE_REQUIRED");
      // ...and a date without a time is refused, never defaulted
      const noTime = await call("POST", `/api/v1/admissions/${admissionId}/nomnc`, as(recorder), noticeBody({ delivered: { date: PAST_DATE } }));
      expect(noTime.statusCode).toBe(422);
      expect(codeOf(noTime)).toBe("TIME_REQUIRED");

      const first = await call("POST", `/api/v1/admissions/${admissionId}/nomnc`, as(recorder), noticeBody());
      expect(first.statusCode).toBe(201);
      const n1 = first.json() as { id: string; deliveredAt: string; version: number; patientId: string };
      // 10:30 in the org zone (America/New_York, EST UTC-5) on 2026-01-10
      expect(n1.deliveredAt).toBe("2026-01-10T15:30:00.000Z");
      expect(n1.patientId).toBe(patientId);
      expect(await events("m6.nomnc.recorded", admissionId)).toHaveLength(1);

      // a second record without superseding is refused (service) ...
      const dup = await call("POST", `/api/v1/admissions/${admissionId}/nomnc`, as(recorder), noticeBody());
      expect(dup.statusCode).toBe(409);
      expect(codeOf(dup)).toBe("ACTIVE_NOTICE_EXISTS");
      // ... and the DB partial unique index holds even for a forged second ACTIVE row
      await expect(
        admin.query(
          `INSERT INTO nomnc_notice (organization_id, patient_id, admission_id, services_end_on, delivered_at, recipient_kind, source_note)
           VALUES ($1,$2,$3,'2026-01-14',now(),'beneficiary','x')`,
          [ORG_A, patientId, admissionId],
        ),
      ).rejects.toThrow(/nomnc_notice_one_active_uq/);
      // the DB CHECK refuses a blank source note independent of the API
      await expect(
        admin.query(
          `INSERT INTO nomnc_notice (organization_id, patient_id, admission_id, status, services_end_on, delivered_at, recipient_kind, source_note)
           VALUES ($1,$2,$3,'withdrawn','2026-01-14',now(),'beneficiary','  ')`,
          [ORG_A, patientId, admissionId],
        ),
      ).rejects.toThrow(/source_note/);

      // supersede
      const second = await call(
        "POST",
        `/api/v1/admissions/${admissionId}/nomnc`,
        as(recorder),
        noticeBody({ supersedesId: n1.id, delivered: { date: PAST_DATE, time: "11:05" }, servicesEndOn: "2026-01-15" }),
      );
      expect(second.statusCode).toBe(201);
      const n2 = second.json() as { id: string };
      const ov = (await call("GET", `/api/v1/admissions/${admissionId}/nomnc`, as(reader))).json() as {
        activeNotice: { id: string };
        history: { id: string; status: string; supersededById: string }[];
        prompts: { code: string }[];
      };
      expect(ov.activeNotice.id).toBe(n2.id);
      expect(ov.history).toMatchObject([{ id: n1.id, status: "superseded", supersededById: n2.id }]);
      // loud prompts: nothing typed for the appeal request, no acknowledgement, no copy
      expect(ov.prompts.map((p) => p.code).sort()).toEqual(["NO_ACKNOWLEDGEMENT", "NO_APPEAL_DEADLINE", "NO_COPY"]);

      // withdraw needs a reason; a stale ifVersion is refused
      const noReason = await call("POST", `/api/v1/admissions/${admissionId}/nomnc/${n2.id}/withdraw`, as(recorder), { ifVersion: 1, reason: " " });
      expect(codeOf(noReason)).toBe("WITHDRAW_REASON_REQUIRED");
      const stale = await call("POST", `/api/v1/admissions/${admissionId}/nomnc/${n2.id}/withdraw`, as(recorder), { ifVersion: 99, reason: "entered on the wrong chart" });
      expect(stale.statusCode).toBe(409);
      expect(codeOf(stale)).toBe("VERSION_CONFLICT");
      const ok = await call("POST", `/api/v1/admissions/${admissionId}/nomnc/${n2.id}/withdraw`, as(recorder), { ifVersion: 1, reason: "entered on the wrong chart" });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ status: "withdrawn" });
      // a withdrawn record can be followed by a fresh one
      const third = await call("POST", `/api/v1/admissions/${admissionId}/nomnc`, as(recorder), noticeBody());
      expect(third.statusCode).toBe(201);
    });

    it("a reader (nomnc.read only) can read but not record; the read-audit event lands", async () => {
      const { admissionId } = await activate();
      expect((await call("POST", `/api/v1/admissions/${admissionId}/nomnc`, as(reader), noticeBody())).statusCode).toBe(403);
      expect((await call("GET", `/api/v1/admissions/${admissionId}/nomnc`, as(reader))).statusCode).toBe(200);
      const { rows } = await admin.query(
        `SELECT resource_id::text AS id, event_type FROM audit_event
          WHERE organization_id=$1 AND resource_kind='admission' AND resource_id=$2
            AND (event_type ILIKE '%view%' OR event_type ILIKE '%read%')`,
        [ORG_A, admissionId],
      );
      // accounted against the ADMISSION whose id the path carries, never as a notice
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(
        (await admin.query(`SELECT 1 FROM audit_event WHERE organization_id=$1 AND resource_kind='nomnc_notice' AND resource_id=$2 AND event_type ILIKE '%view%'`, [ORG_A, admissionId])).rowCount,
      ).toBe(0);
      // no user, no session: never reached
      expect((await call("GET", `/api/v1/admissions/${admissionId}/nomnc`, {})).statusCode).toBeGreaterThanOrEqual(401);
    });

    it("RLS: another tenant reads nothing, cannot record on the admission, and a forged cross-tenant insert fails", async () => {
      const { admissionId, patientId } = await activate();
      await call("POST", `/api/v1/admissions/${admissionId}/nomnc`, as(recorder), noticeBody());
      // org B user, even claiming site A
      const asB = { ...as(recorderB, ORG_B), "x-test-pe": providerA };
      expect((await call("GET", `/api/v1/admissions/${admissionId}/nomnc`, asB)).statusCode).toBe(404);
      expect((await call("POST", `/api/v1/admissions/${admissionId}/nomnc`, asB, noticeBody())).statusCode).toBe(404);
      expect(await nomnc.overview(ORG_B, admissionId)).toBeNull();
      const seenByB = await withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, (tx) =>
        tx.execute(sql`SELECT id FROM nomnc_notice WHERE admission_id = ${admissionId}`),
      );
      expect(seenByB.rows).toEqual([]);
      // org B's context writing org A's admission id: RLS WITH CHECK / the parent guard refuse it
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, (tx) =>
          tx.execute(sql`INSERT INTO nomnc_notice (organization_id, patient_id, admission_id, services_end_on, delivered_at, recipient_kind, source_note)
              VALUES (${ORG_B}, ${patientId}, ${admissionId}, '2026-01-14', now(), 'beneficiary', 'x')`),
        ),
      ).rejects.toThrow();
      // and a notice of another admission is not reachable through this admission's path
      const other = await activate();
      const otherNotice = await call("POST", `/api/v1/admissions/${other.admissionId}/nomnc`, as(recorder), noticeBody());
      const wrongPath = await call("PATCH", `/api/v1/admissions/${admissionId}/nomnc/${(otherNotice.json() as { id: string }).id}`, as(recorder), { ifVersion: 1, deliveryNote: "x" });
      expect(wrongPath.statusCode).toBe(404);
    });

    it("review: opens once per notice, alerts via the real publisher, decides, and is then frozen (service and DB trigger)", async () => {
      const { admissionId, patientId } = await activate();
      const notice = (await call("POST", `/api/v1/admissions/${admissionId}/nomnc`, as(recorder), noticeBody())).json() as { id: string };
      const open = {
        qioName: "Example BFCC-QIO",
        qioReference: "REF-1",
        qioNotified: { date: PAST_DATE, time: "14:20" },
        requestedByKind: "beneficiary",
      };
      // the QIO name is required; a time is required
      expect(codeOf(await call("POST", `/api/v1/admissions/${admissionId}/nomnc/${notice.id}/expedited-review`, as(recorder), { ...open, qioNotified: { date: PAST_DATE } }))).toBe("TIME_REQUIRED");
      const opened = await call("POST", `/api/v1/admissions/${admissionId}/nomnc/${notice.id}/expedited-review`, as(recorder), open);
      expect(opened.statusCode).toBe(201);
      const review = opened.json() as { id: string; version: number; qioNotifiedAt: string; state: string };
      expect(review.state).toBe("open");
      expect(review.qioNotifiedAt).toBe("2026-01-10T19:20:00.000Z");
      expect(await events("m6.expedited_review.opened", admissionId)).toHaveLength(1);
      const again = await call("POST", `/api/v1/admissions/${admissionId}/nomnc/${notice.id}/expedited-review`, as(recorder), open);
      expect(again.statusCode).toBe(409);
      expect(codeOf(again)).toBe("REVIEW_ALREADY_OPEN");
      // the notice cannot be withdrawn while its review is open
      expect(codeOf(await call("POST", `/api/v1/admissions/${admissionId}/nomnc/${notice.id}/withdraw`, as(recorder), { ifVersion: 1, reason: "wrong" }))).toBe("REVIEW_STILL_OPEN");

      // the hub bucket lists it, with no deadline typed
      const list = await createDbDischargeWorklistService(handle.db).list(
        ORG_A,
        { bucket: "qio_review_open" },
        { patientIds: null } as never,
      );
      expect(list.items.find((i) => i.admissionId === admissionId)).toMatchObject({ nextDeadlineAt: null });

      // facts: DENC delivered / records sent are recorded as typed facts (nothing is sent)
      const facts = await call("PATCH", `/api/v1/admissions/${admissionId}/expedited-reviews/${review.id}`, as(recorder), {
        ifVersion: review.version,
        dencDelivered: { date: PAST_DATE, time: "15:00" },
        recordsSent: { date: PAST_DATE, time: "16:10" },
        recordsSentNote: "faxed",
      });
      expect(facts.statusCode).toBe(200);
      const f = facts.json() as { version: number; dencDeliveredAt: string; recordsSentAt: string };
      expect(f.dencDeliveredAt).toBe("2026-01-10T20:00:00.000Z");
      expect(f.recordsSentAt).toBe("2026-01-10T21:10:00.000Z");
      // an 'other' outcome needs a note
      expect(codeOf(await call("PATCH", `/api/v1/admissions/${admissionId}/expedited-reviews/${review.id}`, as(recorder), { ifVersion: f.version, decision: { outcome: "other", received: { date: PAST_DATE, time: "18:00" } } }))).toBe("DECISION_NOTE_REQUIRED");
      const decided = await call("PATCH", `/api/v1/admissions/${admissionId}/expedited-reviews/${review.id}`, as(recorder), {
        ifVersion: f.version,
        decision: { outcome: "discharge_reversed", received: { date: PAST_DATE, time: "18:00" } },
      });
      expect(decided.statusCode).toBe(200);
      expect(decided.json()).toMatchObject({ state: "decided", decisionOutcome: "discharge_reversed" });
      expect(await events("m6.expedited_review.decided", admissionId)).toHaveLength(1);
      const dv = (decided.json() as { version: number }).version;

      // frozen: the service refuses a fact edit and a withdraw...
      expect(codeOf(await call("PATCH", `/api/v1/admissions/${admissionId}/expedited-reviews/${review.id}`, as(recorder), { ifVersion: dv, recordsSentNote: "changed" }))).toBe("REVIEW_NOT_OPEN");
      expect(codeOf(await call("POST", `/api/v1/admissions/${admissionId}/expedited-reviews/${review.id}/withdraw`, as(recorder), { ifVersion: dv }))).toBe("REVIEW_NOT_OPEN");
      // ...and the DB trigger refuses it independent of the service (as the app role)
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
          tx.execute(sql`UPDATE expedited_review SET records_sent_note = 'tampered' WHERE id = ${review.id}`),
        ),
      ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/M6_EXPEDITED_REVIEW_FROZEN/) } });
      // a document link may still be attached after the decision
      const doc = await seedDoc(ORG_A, patientId, admissionId);
      const docOk = await call("PATCH", `/api/v1/admissions/${admissionId}/expedited-reviews/${review.id}`, as(recorder), { ifVersion: dv, decisionDocumentId: doc.documentId, decisionDocumentVersionId: doc.documentVersionId });
      expect(docOk.statusCode).toBe(200);
      // a reversal prompts
      const ov = (await call("GET", `/api/v1/admissions/${admissionId}/nomnc`, as(reader))).json() as { prompts: { code: string }[] };
      expect(ov.prompts.map((p) => p.code)).toContain("REVIEW_REVERSED");
    });

    it("deadlines: typed to the minute with a source, one unsatisfied per kind, frozen once satisfied", async () => {
      const { admissionId } = await activate();
      const notice = (await call("POST", `/api/v1/admissions/${admissionId}/nomnc`, as(recorder), noticeBody())).json() as { id: string };
      const url = `/api/v1/admissions/${admissionId}/nomnc/${notice.id}/deadlines`;
      const body = (over: Record<string, unknown> = {}) => ({
        kind: "appeal_request",
        due: { date: "2026-01-12", time: "12:00" },
        sourceNote: "printed on the NOMNC, line 3",
        ...over,
      });
      expect(codeOf(await call("POST", url, as(recorder), body({ sourceNote: "" })))).toBe("SOURCE_NOTE_REQUIRED");
      expect(codeOf(await call("POST", url, as(recorder), body({ due: { date: "2026-01-12" } })))).toBe("TIME_REQUIRED");
      expect(codeOf(await call("POST", url, as(recorder), body({ due: { date: "2026-03-08", time: "02:30" } })))).toBe("TIME_NONEXISTENT");
      // a review-only kind does not belong on a notice
      expect(codeOf(await call("POST", url, as(recorder), body({ kind: "denc_delivery" })))).toBe("DEADLINE_KIND_NOT_ALLOWED");
      const made = await call("POST", url, as(recorder), body());
      expect(made.statusCode).toBe(201);
      const d = made.json() as { id: string; dueAt: string; dueLocal: string; zone: string; status: string; version: number };
      // exactly what was typed is echoed back; the instant is the minute in the org zone (EST, UTC-5)
      expect(d.dueLocal).toBe("2026-01-12T12:00");
      expect(d.dueAt).toBe("2026-01-12T17:00:00.000Z");
      expect(d.zone).toBe("America/New_York");
      expect(codeOf(await call("POST", url, as(recorder), body()))).toBe("DEADLINE_ALREADY_RECORDED");
      // the NO_APPEAL_DEADLINE prompt is gone once it is typed
      const ov = (await call("GET", `/api/v1/admissions/${admissionId}/nomnc`, as(reader))).json() as { prompts: { code: string }[] };
      expect(ov.prompts.map((p) => p.code)).not.toContain("NO_APPEAL_DEADLINE");

      // edit (a moved deadline restarts its alert history), then satisfy
      const edited = await call("PATCH", `/api/v1/admissions/${admissionId}/expedited-deadlines/${d.id}`, as(recorder), { ifVersion: d.version, due: { date: "2026-01-12", time: "11:45" } });
      expect(edited.statusCode).toBe(200);
      expect(edited.json()).toMatchObject({ dueLocal: "2026-01-12T11:45", dueAt: "2026-01-12T16:45:00.000Z" });
      const ev = (edited.json() as { version: number }).version;
      const met = await call("PATCH", `/api/v1/admissions/${admissionId}/expedited-deadlines/${d.id}`, as(recorder), { ifVersion: ev, satisfy: true });
      expect(met.json()).toMatchObject({ status: "satisfied" });
      const mv = (met.json() as { version: number }).version;
      expect(codeOf(await call("PATCH", `/api/v1/admissions/${admissionId}/expedited-deadlines/${d.id}`, as(recorder), { ifVersion: mv, due: { date: "2026-01-13", time: "09:00" } }))).toBe("DEADLINE_SATISFIED");
      // the DB guard refuses the same edit independent of the service
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
          tx.execute(sql`UPDATE expedited_deadline SET source_note = 'tampered' WHERE id = ${d.id}`),
        ),
      ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/M6_EXPEDITED_DEADLINE_FROZEN/) } });
      // a satisfied deadline still counts as recorded (never re-flagged as missing)
      const after = (await call("GET", `/api/v1/admissions/${admissionId}/nomnc`, as(reader))).json() as { prompts: { code: string }[] };
      expect(after.prompts.map((p) => p.code)).not.toContain("NO_APPEAL_DEADLINE");
    });

    it("the 15-minute scan emits each boundary once and overdue once; a satisfied deadline or decided review never alerts", async () => {
      const { admissionId } = await activate();
      const notice = (await call("POST", `/api/v1/admissions/${admissionId}/nomnc`, as(recorder), noticeBody())).json() as { id: string };
      const review = (await call("POST", `/api/v1/admissions/${admissionId}/nomnc/${notice.id}/expedited-review`, as(recorder), {
        qioName: "Example BFCC-QIO",
        qioNotified: { date: PAST_DATE, time: "14:20" },
        requestedByKind: "unknown",
      })).json() as { id: string; version: number };
      const mk = async (kind: string) =>
        (await call("POST", `/api/v1/admissions/${admissionId}/expedited-reviews/${review.id}/deadlines`, as(recorder), {
          kind,
          due: { date: "2030-01-02", time: "09:00" },
          sourceNote: "told by the QIO on the call",
        })).json() as { id: string };
      const denc = await mk("denc_delivery");
      const records = await mk("records_to_qio");
      const T0 = new Date("2030-01-02T12:00:00.000Z");
      await dueAt(denc.id, new Date(T0.getTime() + 30 * HOUR));
      await dueAt(records.id, new Date(T0.getTime() + 30 * HOUR));
      const approaching = async () => (await events("m6.expedited_deadline.approaching", admissionId)).length;
      const overdue = async () => (await events("m6.expedited_deadline.overdue", admissionId)).length;

      await scan(T0); // 30h out: before the widest boundary
      expect(await approaching()).toBe(0);
      await scan(new Date(T0.getTime() + 7 * HOUR)); // 23h left: the 24h boundary, both deadlines
      expect(await approaching()).toBe(2);
      await scan(new Date(T0.getTime() + 8 * HOUR)); // still 24h boundary: never repeated
      expect(await approaching()).toBe(2);
      // satisfy one deadline: it never alerts again
      await call("PATCH", `/api/v1/admissions/${admissionId}/expedited-deadlines/${records.id}`, as(recorder), { ifVersion: 1, satisfy: true });
      await scan(new Date(T0.getTime() + 27 * HOUR)); // 3h left: the 4h boundary for the unsatisfied one only
      expect(await approaching()).toBe(3);
      await scan(new Date(T0.getTime() + 29.5 * HOUR)); // 0.5h left: the 1h boundary
      expect(await approaching()).toBe(4);
      const payloads = await events("m6.expedited_deadline.approaching", admissionId);
      expect(payloads.map((p) => p.boundaryHours).sort((a, b) => Number(a) - Number(b))).toEqual([1, 4, 24, 24]);
      // PHI-free: ids, kind and instants only
      expect(Object.keys(payloads[0] ?? {}).sort()).toEqual(
        ["admissionId", "boundaryHours", "dueAt", "expeditedDeadlineId", "kind", "patientId", "subject"].sort(),
      );
      await scan(new Date(T0.getTime() + 31 * HOUR)); // past due
      expect(await overdue()).toBe(1);
      await scan(new Date(T0.getTime() + 32 * HOUR));
      expect(await overdue()).toBe(1); // once

      // a decided review's deadlines stop alerting (the parent is no longer live)
      const other = await mk("qio_decision");
      await call("PATCH", `/api/v1/admissions/${admissionId}/expedited-reviews/${review.id}`, as(recorder), {
        ifVersion: review.version,
        decision: { outcome: "discharge_upheld", received: { date: PAST_DATE, time: "18:00" } },
      });
      await dueAt(other.id, new Date(T0.getTime() + 33 * HOUR + 0.5 * HOUR));
      await scan(new Date(T0.getTime() + 33 * HOUR));
      expect(await approaching()).toBe(4);
    });

    it("route 39 still discharges with a review open; the hub lists a notice with no appeal-request deadline", async () => {
      const { admissionId } = await activate();
      const notice = (await call("POST", `/api/v1/admissions/${admissionId}/nomnc`, as(recorder), noticeBody())).json() as { id: string };
      const nodl = await createDbDischargeWorklistService(handle.db).list(
        ORG_A,
        { bucket: "nomnc_no_deadline" },
        { patientIds: null } as never,
      );
      expect(nodl.items.map((i) => i.admissionId)).toContain(admissionId);
      expect(
        (await call("POST", `/api/v1/admissions/${admissionId}/nomnc/${notice.id}/expedited-review`, as(recorder), {
          qioName: "Example BFCC-QIO",
          qioNotified: { date: PAST_DATE, time: "14:20" },
          requestedByKind: "beneficiary",
        })).statusCode,
      ).toBe(201);
      const adm = await svc.getAdmission(ORG_A, admissionId);
      await svc.discharge(
        ORG_A,
        admissionId,
        {
          reason: "moved_out_of_service_area",
          dischargeDate: new Date().toISOString().slice(0, 10),
          narrative: "The patient relocated out of the service area and elects another hospice.",
          dischargeOrder: dischargeOrderBy(MD),
          ifVersion: adm?.version,
        } as never,
        USER,
      );
      const { rows } = await admin.query("SELECT status FROM admission WHERE id=$1", [admissionId]);
      expect(rows[0].status).toBe("discharged");
      // the review is a fact, left as it was
      const rv = await one<{ state: string }>("SELECT state FROM expedited_review WHERE admission_id=$1", [admissionId]);
      expect(rv.state).toBe("open");
    });


    /** Seed an M22 document (superuser) with one active version. */
    async function seedDoc(org: string, patientId: string, admissionId: string | null) {
      const documentId = (
        await admin.query(
          `INSERT INTO document (organization_id, patient_id, admission_id, retention_class, source_kind,
             aggregate_type, title, created_by_membership_id)
           VALUES ($1,$2,$3,'compliance','user_upload','nomnc','Scan',$4) RETURNING id`,
          [org, patientId, admissionId, randomUUID()],
        )
      ).rows[0].id as string;
      const documentVersionId = (
        await admin.query(
          `INSERT INTO document_version (organization_id, document_id, version_number, minio_object_key,
             mime_type, byte_size, sha256_hex, uploaded_by_kind)
           VALUES ($1,$2,'1',$3,'application/pdf','2048','abc123','system') RETURNING id`,
          [org, documentId, `uploads/nm-${documentId}.pdf`],
        )
      ).rows[0].id as string;
      await admin.query("UPDATE document SET active_version_id=$1 WHERE id=$2", [documentVersionId, documentId]);
      return { documentId, documentVersionId };
    }

    it("a linked document must be an ACTIVE version of THIS patient and admission: cross-patient and cross-tenant ids are 404 and write nothing", async () => {
      const a = await activate();
      const b = await activate(); // another patient and admission in the same org
      const created = await call("POST", `/api/v1/admissions/${a.admissionId}/nomnc`, as(recorder), noticeBody());
      const n = created.json() as { id: string; version: number };
      const own = await seedDoc(ORG_A, a.patientId, a.admissionId);
      const otherPatient = await seedDoc(ORG_A, b.patientId, b.admissionId);
      const otherTenant = await seedDoc(ORG_B, randomUUID(), null);
      const url = `/api/v1/admissions/${a.admissionId}/nomnc/${n.id}`;
      const noticeDoc = async () =>
        (await one<{ document_id: string | null }>("SELECT document_id FROM nomnc_notice WHERE id=$1", [n.id])).document_id;

      for (const bad of [otherPatient, otherTenant]) {
        const res = await call("PATCH", url, as(recorder), { ifVersion: n.version, documentId: bad.documentId, documentVersionId: bad.documentVersionId });
        expect(res.statusCode).toBe(404);
        expect(await noticeDoc()).toBeNull();
      }
      // a document id without a version is refused, not guessed
      expect((await call("PATCH", url, as(recorder), { ifVersion: n.version, documentId: own.documentId })).statusCode).toBe(422);
      // a foreign document cannot ride in on a new record either, nor on a review or a deadline
      const rec = await call("POST", `/api/v1/admissions/${b.admissionId}/nomnc`, as(recorder), noticeBody({ documentId: own.documentId, documentVersionId: own.documentVersionId }));
      expect(rec.statusCode).toBe(404);
      expect((await admin.query("SELECT 1 FROM nomnc_notice WHERE admission_id=$1", [b.admissionId])).rowCount).toBe(0);
      const dl = await call("POST", `${url}/deadlines`, as(recorder), {
        kind: "appeal_request",
        due: { date: "2026-01-12", time: "12:00" },
        sourceNote: "printed on the notice",
        noticeDocumentId: otherTenant.documentId,
        noticeDocumentVersionId: otherTenant.documentVersionId,
      });
      expect(dl.statusCode).toBe(404);
      expect((await admin.query("SELECT 1 FROM expedited_deadline WHERE nomnc_notice_id=$1", [n.id])).rowCount).toBe(0);
      const rv = (await call("POST", `${url}/expedited-review`, as(recorder), {
        qioName: "Example BFCC-QIO",
        qioNotified: { date: PAST_DATE, time: "14:20" },
        requestedByKind: "unknown",
      })).json() as { id: string; version: number };
      const badDenc = await call("PATCH", `/api/v1/admissions/${a.admissionId}/expedited-reviews/${rv.id}`, as(recorder), {
        ifVersion: rv.version,
        dencDocumentId: otherPatient.documentId,
        dencDocumentVersionId: otherPatient.documentVersionId,
      });
      expect(badDenc.statusCode).toBe(404);
      expect((await one<{ denc_document_id: string | null }>("SELECT denc_document_id FROM expedited_review WHERE id=$1", [rv.id])).denc_document_id).toBeNull();

      // the patient's own active version links
      const ok = await call("PATCH", url, as(recorder), { ifVersion: n.version, documentId: own.documentId, documentVersionId: own.documentVersionId });
      expect(ok.statusCode).toBe(200);
      expect(await noticeDoc()).toBe(own.documentId);
      // and the actor's scope still gates the admission itself: a user of another org cannot reach it at all
      const asB = { ...as(recorderB, ORG_B), "x-test-pe": providerA };
      expect((await call("PATCH", url, asB, { ifVersion: n.version + 1, documentId: own.documentId, documentVersionId: own.documentVersionId })).statusCode).toBe(404);
    });


    it("after a supersede the new notice shows NO review and one can be opened (decided and withdrawn priors); old records are frozen", async () => {
      for (const prior of ["decided", "withdrawn"] as const) {
        const { admissionId } = await activate();
        const base = `/api/v1/admissions/${admissionId}`;
        const n1 = (await call("POST", `${base}/nomnc`, as(recorder), noticeBody())).json() as { id: string };
        const rv = (await call("POST", `${base}/nomnc/${n1.id}/expedited-review`, as(recorder), {
          qioName: "Example BFCC-QIO",
          qioNotified: { date: PAST_DATE, time: "14:20" },
          requestedByKind: "unknown",
        })).json() as { id: string; version: number };
        const dl = (await call("POST", `${base}/expedited-reviews/${rv.id}/deadlines`, as(recorder), {
          kind: "qio_decision",
          due: { date: "2099-01-02", time: "09:00" },
          sourceNote: "told by the QIO",
        })).json() as { id: string };
        if (prior === "decided") {
          await call("PATCH", `${base}/expedited-reviews/${rv.id}`, as(recorder), {
            ifVersion: rv.version,
            decision: { outcome: "discharge_upheld", received: { date: PAST_DATE, time: "18:00" } },
          });
        } else {
          await call("POST", `${base}/expedited-reviews/${rv.id}/withdraw`, as(recorder), { ifVersion: rv.version });
        }
        // the closed review's unmet deadline no longer reads as running or overdue
        const mid = (await call("GET", `${base}/nomnc`, as(reader))).json() as { deadlines: { id: string; status: string }[] };
        expect(mid.deadlines.find((d) => d.id === dl.id)?.status).toBe("closed");

        const n2 = await call("POST", `${base}/nomnc`, as(recorder), noticeBody({ supersedesId: n1.id }));
        expect(n2.statusCode).toBe(201);
        const ov = (await call("GET", `${base}/nomnc`, as(reader))).json() as { review: unknown; activeNotice: { id: string }; deadlines: unknown[] };
        expect(ov.activeNotice.id).toBe((n2.json() as { id: string }).id);
        expect(ov.review).toBeNull();
        expect(ov.deadlines).toEqual([]);
        const again = await call("POST", `${base}/nomnc/${ov.activeNotice.id}/expedited-review`, as(recorder), {
          qioName: "Example BFCC-QIO",
          qioNotified: { date: PAST_DATE, time: "15:20" },
          requestedByKind: "unknown",
        });
        expect(again.statusCode).toBe(201);
        // the superseded record is history: the DB refuses any change to it
        await expect(
          withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
            tx.execute(sql`UPDATE nomnc_notice SET delivery_note = 'tampered' WHERE id = ${n1.id}`),
          ),
        ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/M6_NOMNC_FROZEN/) } });
        // a closed record's deadline can be neither edited nor marked met (typed 409), and nothing new is added to it
        const closed = await call("PATCH", `${base}/expedited-deadlines/${dl.id}`, as(recorder), { ifVersion: 1, satisfy: true });
        expect(closed.statusCode).toBe(409);
        expect(codeOf(closed)).toBe("DEADLINE_CLOSED");
        expect((await one<{ satisfied_at: Date | null }>("SELECT satisfied_at FROM expedited_deadline WHERE id=$1", [dl.id])).satisfied_at).toBeNull();
        expect(codeOf(await call("POST", `${base}/expedited-reviews/${rv.id}/deadlines`, as(recorder), {
          kind: "denc_delivery", due: { date: "2099-01-02", time: "09:00" }, sourceNote: "x",
        }))).toBe("REVIEW_NOT_OPEN");
        expect(codeOf(await call("POST", `${base}/nomnc/${n1.id}/deadlines`, as(recorder), {
          kind: "appeal_request", due: { date: "2099-01-02", time: "09:00" }, sourceNote: "x",
        }))).toBe("NOTICE_NOT_ACTIVE");
      }
    });

    it("a deadline typed already in the past does not page on the next tick; a stale scan cannot mark a moved deadline; the link records the validated VERSION", async () => {
      const { admissionId, patientId } = await activate();
      const base = `/api/v1/admissions/${admissionId}`;
      const n = (await call("POST", `${base}/nomnc`, as(recorder), noticeBody())).json() as { id: string; version: number };
      const past = await call("POST", `${base}/nomnc/${n.id}/deadlines`, as(recorder), {
        kind: "appeal_request",
        due: { date: PAST_DATE, time: "12:00" },
        sourceNote: "printed on the notice",
      });
      const pd = past.json() as { id: string; dueAt: string; status: string; version: number };
      await scan(new Date());
      expect((await events("m6.expedited_deadline.overdue", admissionId)).length).toBe(0);
      expect(pd.status).toBe("past");

      // a scan that read the old due_at cannot mark or alert after the deadline was moved
      const future = new Date(Date.now() + 3 * HOUR);
      await dueAt(pd.id, new Date(Date.now() + 100 * HOUR));
      const stale = {
        id: pd.id, dueAt: future, kind: "appeal_request", admissionId, patientId, nomncNoticeId: n.id,
        lastAlertedBoundaryHours: null, overdueAlertedAt: null, satisfiedAt: null,
      };
      const published = await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        markAndPublish(tx as never, validatingM6Outbox(), ORG_A, stale as never, { id: pd.id, kind: "approaching", boundaryHours: 4 }, new Date()),
      );
      expect(published).toBe(false);
      expect((await events("m6.expedited_deadline.approaching", admissionId)).length).toBe(0);

      // the validated document VERSION is persisted with the link
      const doc = await seedDoc(ORG_A, patientId, admissionId);
      expect((await call("PATCH", `${base}/nomnc/${n.id}`, as(recorder), { ifVersion: n.version, documentId: doc.documentId, documentVersionId: doc.documentVersionId })).statusCode).toBe(200);
      const row = await one<{ document_id: string; document_version_id: string }>("SELECT document_id, document_version_id FROM nomnc_notice WHERE id=$1", [n.id]);
      expect(row).toEqual({ document_id: doc.documentId, document_version_id: doc.documentVersionId });

      // the deadline guard checks the patient as well as the admission
      await expect(
        admin.query(
          `INSERT INTO expedited_deadline (organization_id, patient_id, admission_id, nomnc_notice_id, kind, due_at, due_local, zone, source_note)
           VALUES ($1,$2,$3,$4,'other',now(),'2099-01-01T00:00','America/New_York','x')`,
          [ORG_A, randomUUID(), admissionId, n.id],
        ),
      ).rejects.toThrow();
    });

    it("the freeze exempts only an FK action: a frozen notice's user columns can go to NULL, never to another user; the app role cannot touch them", async () => {
      const author = await staff(ORG_A, "nomnc_recorder", []);
      const { admissionId } = await activate();
      const base = `/api/v1/admissions/${admissionId}`;
      const n1 = (await call("POST", `${base}/nomnc`, as(author), noticeBody())).json() as { id: string };
      expect((await call("POST", `${base}/nomnc`, as(recorder), noticeBody({ supersedesId: n1.id }))).statusCode).toBe(201);
      const col = async () =>
        (await one<{ d: string | null; c: string | null }>("SELECT delivered_by_user_id AS d, created_by_user_id AS c FROM nomnc_notice WHERE id=$1", [n1.id]));
      expect(await col()).toEqual({ d: author, c: author });
      // rewriting who delivered / created a frozen record is refused, even for the owner (the trigger)
      for (const c of ["delivered_by_user_id", "created_by_user_id"])
        await expect(admin.query(`UPDATE nomnc_notice SET ${c}=$2 WHERE id=$1`, [n1.id, recorder])).rejects.toThrow(/M6_NOMNC_FROZEN/);
      // ... and the app role holds no UPDATE grant on either column
      for (const c of ["delivered_by_user_id", "created_by_user_id"])
        await expect(
          withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
            tx.execute(sql.raw(`UPDATE nomnc_notice SET ${c} = '${recorder}' WHERE id = '${n1.id}'`)),
          ),
        ).rejects.toThrow();
      expect(await col()).toEqual({ d: author, c: author });
      // the FK action (ON DELETE SET NULL) is the one allowed change
      await admin.query("DELETE FROM membership_role WHERE membership_id IN (SELECT id FROM membership WHERE user_id=$1)", [author]);
      await admin.query("DELETE FROM membership WHERE user_id=$1", [author]);
      await admin.query(`DELETE FROM "user" WHERE id=$1`, [author]);
      expect(await col()).toEqual({ d: null, c: null });
    });

    it("withdraw notice, withdraw review and record decision need a FRESH step-up; everything else does not", async () => {
      const { admissionId } = await activate();
      const base = `/api/v1/admissions/${admissionId}`;
      const stale = as(recorder, ORG_A, false);
      const fresh = as(recorder);
      const n = (await call("POST", `${base}/nomnc`, stale, noticeBody())).json() as { id: string; version: number };
      const rv = (await call("POST", `${base}/nomnc/${n.id}/expedited-review`, stale, {
        qioName: "Example BFCC-QIO", qioNotified: { date: PAST_DATE, time: "14:20" }, requestedByKind: "unknown",
      })).json() as { id: string; version: number };
      // reversible writes need no step-up
      const facts = await call("PATCH", `${base}/expedited-reviews/${rv.id}`, stale, { ifVersion: rv.version, recordsSentNote: "faxed" });
      expect(facts.statusCode).toBe(200);
      const v2 = (facts.json() as { version: number }).version;
      expect((await call("PATCH", `${base}/nomnc/${n.id}`, stale, { ifVersion: n.version, deliveryNote: "in person" })).statusCode).toBe(200);

      const state = async () => ({
        review: (await one<{ state: string }>("SELECT state FROM expedited_review WHERE id=$1", [rv.id])).state,
        notice: (await one<{ status: string }>("SELECT status FROM nomnc_notice WHERE id=$1", [n.id])).status,
      });
      const decision = { ifVersion: v2, decision: { outcome: "discharge_upheld", received: { date: PAST_DATE, time: "18:00" } } };
      // DECISION: stale session is refused with the standard step-up error and nothing is written
      const noDecision = await call("PATCH", `${base}/expedited-reviews/${rv.id}`, stale, decision);
      expect(noDecision.statusCode).toBe(403);
      expect(codeOf(noDecision)).toBe("STEP_UP_REQUIRED");
      expect((await state()).review).toBe("open");
      expect((await events("m6.expedited_review.decided", admissionId)).length).toBe(0);
      // WITHDRAW REVIEW
      const noWr = await call("POST", `${base}/expedited-reviews/${rv.id}/withdraw`, stale, { ifVersion: v2 });
      expect([noWr.statusCode, codeOf(noWr)]).toEqual([403, "STEP_UP_REQUIRED"]);
      expect((await state()).review).toBe("open");
      // a bad-permission caller is refused as a permission failure BEFORE step-up is considered
      const lowPriv = await call("PATCH", `${base}/expedited-reviews/${rv.id}`, as(reader, ORG_A, false), decision);
      expect(lowPriv.statusCode).toBe(403);
      expect(codeOf(lowPriv)).not.toBe("STEP_UP_REQUIRED");

      // with a fresh step-up the decision succeeds
      expect((await call("PATCH", `${base}/expedited-reviews/${rv.id}`, fresh, decision)).statusCode).toBe(200);
      expect((await state()).review).toBe("decided");

      // WITHDRAW NOTICE (the review is decided, so the notice may be withdrawn)
      const noWn = await call("POST", `${base}/nomnc/${n.id}/withdraw`, stale, { ifVersion: 3, reason: "entered on the wrong chart" });
      expect([noWn.statusCode, codeOf(noWn)]).toEqual([403, "STEP_UP_REQUIRED"]);
      expect((await state()).notice).toBe("active");
      const cur = (await one<{ version: number }>("SELECT version FROM nomnc_notice WHERE id=$1", [n.id])).version;
      expect((await call("POST", `${base}/nomnc/${n.id}/withdraw`, fresh, { ifVersion: cur, reason: "entered on the wrong chart" })).statusCode).toBe(200);
      expect((await state()).notice).toBe("withdrawn");

      // WITHDRAW REVIEW with a fresh step-up, on a second admission
      const b = await activate();
      const bb = `/api/v1/admissions/${b.admissionId}`;
      const n2 = (await call("POST", `${bb}/nomnc`, fresh, noticeBody())).json() as { id: string };
      const r2 = (await call("POST", `${bb}/nomnc/${n2.id}/expedited-review`, fresh, {
        qioName: "Example BFCC-QIO", qioNotified: { date: PAST_DATE, time: "14:20" }, requestedByKind: "unknown",
      })).json() as { id: string; version: number };
      expect((await call("POST", `${bb}/expedited-reviews/${r2.id}/withdraw`, fresh, { ifVersion: r2.version })).statusCode).toBe(200);
    });

    it("the nomnc routes are not on the auditor enrolment allowlist (an auditor session reaches none of them)", () => {
      const src = readFileSync(
        join(__dirname, "../src/bootstrap/plugins/authenticate.ts"),
        "utf8",
      );
      expect(src).not.toMatch(/nomnc|expedited-/);
    });
  },
);
