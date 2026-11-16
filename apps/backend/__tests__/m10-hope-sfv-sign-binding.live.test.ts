import { createHash } from "node:crypto";
/**
 * R-01 + R-05 (HOPE current-state audit, docs/implementation/05-hope-current-state-audit.md) -- SFV completion
 * is bound to the URL admission, and a HOPE record signature is an attested, step-up-gated, human act.
 * Proven on real Postgres through the FULL route stack.
 *
 * Mounts `registerHopeRoutes` over the REAL Drizzle backend (`createDbHopeBackend`, NOBYPASSRLS `chartwarden_app`,
 * the real catalog-validating outbox) behind the real M1 middleware + Authorization Contract, with a header-auth
 * shim that models a per-user caseload (so `hope.scope` actually discriminates) and a fresh/stale step-up. Proves:
 *   - R-01: a caseload clinician who knows ANOTHER admission's triggering-assessment id cannot complete that SFV
 *     through their own admission: 409 M10_SFV_NO_TRIGGER, byte-for-byte the answer for an unknown id (no
 *     existence oracle; an already-completed foreign SFV never says ALREADY_COMPLETED), and NOTHING is written
 *     (no RFA-04 row, SFV still open, victim draft answers untouched, no sfv_completed outbox row). The
 *     legitimate pair writes the SFV's own patient + admission. Two parallel completions yield one 201, one
 *     409 ALREADY_COMPLETED and exactly one signed RFA-04.
 *   - R-05 (POST /sign AND POST /admissions/:id/hope/sfv): no attestation -> 422 and the draft keeps its
 *     status/version; a stale step-up -> 403 STEP_UP_REQUIRED (break-glass does not satisfy it); a caller
 *     denied by scope or discipline is never told to step up; an AI principal is 403; and the signature
 *     lands an explicit, PHI-free audit event naming the attestation (and its wording version), the signing
 *     membership and the step-up operation the route REQUIRED.
 *   - Review follow-ups: the workflow state lists only the URL admission's SFVs (a re-admitted patient can
 *     complete the SFV its workspace shows); a completion with no J2053 content, a past-due one without an
 *     override, and a repeat one all leave NO RFA-04 row and NO audit row; a `missed` SFV completes exactly
 *     once under a valid override; the SFV status writers never revert a completed SFV; the service refuses an
 *     unattested signature and a coerced `"true"`; two parallel signs of one draft are one 200 and one 409.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m10:sfv-sign-binding:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
  setBreakGlassChecker,
} from "@chartwarden/auth";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  type AdmissionSummary,
  HOPE_ATTESTATION_VERSION,
  HOPE_SFV_ATTESTATION_STATEMENT,
  HOPE_SIGN_ATTESTATION_STATEMENT,
} from "@chartwarden/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { importHopeSpec } from "../../../scripts/db/import-hope-spec";
import { __resetSeamsForTest, buildServer, registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import {
  createAdmissionStatusReader,
  createDrizzleAdmissionReaderStore,
} from "../src/modules/06-admission/index";
import {
  type HopeWriteOutboxPort,
  M10_OUTBOX_EVENTS,
  buildHopeAbacPredicates,
  createDbHopeBackend,
  registerHopeRoutes,
} from "../src/modules/10-hope/index";
import { updateSfvStatus } from "../src/modules/10-hope/jobs/cron-store";
import {
  runHopeWindowWatchdogCron,
  runSfvWatchdogCron,
} from "../src/modules/10-hope/jobs/cron-workers";
import { awaitParked } from "./_hope-busy-within";
import { answerHopeForSign } from "./_hope-sign-ready";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const ORG_USER = (n: number): string => `33333333-3333-3333-3333-${n.toString().padStart(12, "0")}`;
const READ_KEYS = ["hope.schedule.read", "hope.timepoint.read", "hope.sfv.read"];
const WRITE_KEYS = ["hope.timepoint.write", "hope.timepoint.sign", "hope.timepoint.correct"];
const QUIET_DATA = { J: { J2051: { entries: [{ symptomCode: "pain", severity: "mild" }] } } };
const TRIGGER_DATA = { J: { J2051: { entries: [{ symptomCode: "pain", severity: "moderate" }] } } };
const SFV_DATA = {
  J: {
    J2053: Object.fromEntries(
      ["A", "B", "C", "D", "E", "F", "G", "H"].map((l) => [`J2053${l}`, "1"]),
    ),
  },
};
/**
 * Final readiness reads the required CMS sections off the draft's `data` payload (`presentSections`, wired in
 * 65759182), so a draft only signs once every section the comprehensive instrument requires carries
 * something. The canonical answers fill the items; this fills the sections. (J keeps a mild, non-triggering J2051.)
 */
const COMPREHENSIVE_DATA = {
  ...Object.fromEntries(
    ["A", "B", "C", "D", "E", "F", "G", "H", "I", "K", "M", "N", "O", "Q", "X", "Z"].map((s) => [
      s,
      { documented: "1" },
    ]),
  ),
  ...QUIET_DATA,
};
const BOGUS_TRIGGER = "99999999-9999-4999-8999-999999999999";
const today = (): string => new Date().toISOString().slice(0, 10);
const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const SIGN_AUDIT = "hope.timepoint_signed";
const SFV_AUDIT = "hope.sfv_completed";
const SIGN_AUDIT_KEYS = [
  "attestationConfirmed",
  "attestationVersionSupplied",
  "byMembershipId",
  // The request's own correlation id (a client can choose it): a trace hint in the context, never the row's correlation_id.
  "clientCorrelationId",
  "rfaKind",
  "serverCurrentAttestationStatementSha256",
  "serverCurrentAttestationVersion",
  "stepUpRequiredOperation",
  "version",
];
const LATE_OVERRIDE_AUDIT = "hope.late_deadline_override";
const OVERRIDE_KEY = "hope.admin.late_deadline_override";
const OVERRIDE_REASON = "Documented late completion after the visit window had closed.";
const daysFromNow = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString();

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  // x-test-user is the MEMBERSHIP id (actorOf reads it); the session user id is the distinct Better Auth id,
  // which is what the caseload seam keys on.
  const uid = request.headers["x-test-uid"];
  request.context.userId = typeof uid === "string" ? uid : user;
  request.context.attributes.membershipId = user;
  request.context.organizationId = ORG;
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.providerEntityIds = [];
  request.context.attributes.stepUpRecent = request.headers["x-test-step-up"] === "true";
  const actorKind = request.headers["x-test-actor-kind"];
  if (typeof actorKind === "string") request.context.attributes.actorKind = actorKind;
}

describe.skipIf(!DB_URL)(
  "R-01 / R-05 HOPE SFV binding + signature ceremony — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let appDbUrl = "";
    let svc: ReturnType<typeof createDbHopeBackend>;
    let app: FastifyInstance;
    let provider = "";
    let location = "";
    let seq = 0;
    const patientOf: Record<string, string> = {};
    const userOf: Record<string, string> = {};
    const rolesOf: Record<string, string> = {};
    /** session user id -> the patients on that clinician's caseload (what `hope.scope` resolves through). */
    const caseload = new Map<string, Set<string>>();
    const member = { victim: "", attacker: "", orgwide: "", chaplain: "" };
    const as = (m: string, over: Record<string, string> = {}): Record<string, string> => ({
      "x-test-user": m,
      "x-test-uid": userOf[m] as string,
      "x-test-roles": rolesOf[m] ?? "rn",
      "x-test-step-up": "true",
      ...over,
    });
    const STALE = { "x-test-step-up": "false" };
    const uuid = (prefix: string, n: number): string =>
      `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

    async function resetSchema(): Promise<void> {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const r of LIVE_DROP_ROLES)
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
    }
    async function applyMigrations(): Promise<void> {
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
    async function newMember(n: number, roles: string): Promise<string> {
      const userId = ORG_USER(n);
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [
        userId,
        `r01r05-${n}@x.test`,
      ]);
      const m = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [userId, ORG],
        )
      ).rows[0].id as string;
      userOf[m] = userId;
      rolesOf[m] = roles;
      return m;
    }
    const grantCaseload = (m: string, patientId: string): void => {
      const uid = userOf[m] as string;
      caseload.set(uid, new Set([...(caseload.get(uid) ?? []), patientId]));
    };

    /** A real active admission (M6 reader resolves it) with its own patient, or a RE-admission of `readmitPatient`. */
    async function admitted(readmitPatient?: string): Promise<string> {
      seq += 1;
      const adm = uuid("77000000", seq);
      const patientId = readmitPatient ?? `44444444-4444-4444-8444-${adm.slice(-12)}`;
      patientOf[adm] = patientId;
      if (!readmitPatient)
        await admin.query(
          `INSERT INTO patient (id, organization_id, provider_entity_id, location_id, mrn,
         legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
       VALUES ($1,$2,$3,$4,$5,'Test','Patient','1950-01-01','F','active')`,
          [patientId, ORG, provider, location, `MRN-${patientId.slice(-12)}`],
        );
      await admin.query(
        `INSERT INTO admission (id, organization_id, provider_entity_id, location_id, patient_id,
         admitted_by_physician_id, status, admission_at, activated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active','2026-06-01'::date,'2026-06-01'::date)`,
        [adm, ORG, provider, location, patientId, ORG_USER(1)],
      );
      await admin.query(
        `INSERT INTO hope_timepoint_schedule (organization_id, provider_entity_id, location_id, patient_id,
         admission_id, rfa_kind, window_opens_at, window_closes_at, late_deadline_at, alert_cadence, generated_by)
       VALUES ($1,$2,$3,$4,$5,'01_admission',$6,$7,$8,'{}'::jsonb,'auto_admission')`,
        [
          ORG,
          provider,
          location,
          patientId,
          adm,
          new Date(Date.now() - 1_000).toISOString(),
          new Date(Date.now() + 5 * 86_400_000).toISOString(),
          new Date(Date.now() + 10 * 86_400_000).toISOString(),
        ],
      );
      return adm;
    }

    const recordDraft = (adm: string, author: string, data: Record<string, unknown>) =>
      svc.recordTimepoint(ORG, author, adm, {
        rfaKind: "01_admission",
        targetDate: new Date().toISOString(),
        authorDiscipline: "RN",
        data,
      });

    /** An admission whose Admission draft has a fired J2051 trigger, so a real open SFV exists. */
    async function openSfv(owner = member.victim, readmitPatient?: string) {
      const adm = await admitted(readmitPatient);
      grantCaseload(owner, patientOf[adm] as string);
      const draft = await recordDraft(adm, owner, TRIGGER_DATA);
      const ws = await svc.getAssessmentWorkspace(ORG, draft.id);
      await svc.patchAssessmentAnswers(ORG, owner, draft.id, {
        ifVersion: ws.assessment.version,
        changes: [
          { itemCode: "J2050A", action: "set", value: "1" },
          { itemCode: "J2050B", action: "set", value: today() },
          { itemCode: "J2051A", action: "set", value: "2" },
        ],
      });
      const sfvId = (
        await admin.query(
          "SELECT id FROM symptom_follow_up_visit WHERE triggering_assessment_id=$1",
          [draft.id],
        )
      ).rows[0].id as string;
      return { adm, patientId: patientOf[adm] as string, draftId: draft.id, sfvId };
    }
    /** A sign-ready (no J2051) Admission draft on a fresh admission. */
    async function signReadyDraft(owner = member.victim) {
      const adm = await admitted();
      grantCaseload(owner, patientOf[adm] as string);
      const draft = await recordDraft(adm, owner, COMPREHENSIVE_DATA);
      await answerHopeForSign(
        { svc, orgId: ORG, membershipId: owner, answerDate: today() },
        draft.id,
      );
      const version = (await svc.getAssessment(ORG, draft.id)).version;
      return { adm, id: draft.id, version };
    }

    const sfvBody = (triggeringAssessmentId: string, over: Record<string, unknown> = {}) => ({
      triggeringAssessmentId,
      targetDate: new Date().toISOString(),
      authorDiscipline: "RN",
      data: SFV_DATA,
      attestationConfirmed: true,
      ...over,
    });
    const postSfv = (
      adm: string,
      headers: Record<string, string>,
      triggeringAssessmentId: string,
      over: Record<string, unknown> = {},
    ) =>
      app.inject({
        method: "POST",
        url: `/api/v1/admissions/${adm}/hope/sfv`,
        headers,
        payload: sfvBody(triggeringAssessmentId, over),
      });
    const postSign = (
      id: string,
      headers: Record<string, string>,
      payload: Record<string, unknown>,
    ) =>
      app.inject({ method: "POST", url: `/api/v1/hope/assessments/${id}/sign`, headers, payload });

    type ErrorRes = { statusCode: number; json(): { error?: { code?: string; message?: string } } };
    const codeOf = (res: ErrorRes) => res.json().error?.code;
    /** The caller-visible shape of an error: status + code + message with every uuid masked. */
    const shapeOf = (res: ErrorRes) => ({
      status: res.statusCode,
      code: codeOf(res),
      message: (res.json().error?.message ?? "").replace(/[0-9a-f-]{36}/g, "<id>"),
    });
    /**
     * The text of every statement a FRESH app-role backend sends while `run` executes. The spy goes on pg's Client BEFORE
     * the probe pool opens its connections: `createDbClient` binds each client's `query` when it connects, so a spy
     * installed after the suite's own pool is warm would never see its statements.
     */
    async function statementsDuring<T>(
      run: (backend: ReturnType<typeof createDbHopeBackend>) => Promise<T>,
    ): Promise<{ out: T; sql: string[] }> {
      const sql: string[] = [];
      const original = Client.prototype.query;
      const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
        this: Client,
        ...args: unknown[]
      ) {
        const first = args[0] as string | { text?: string } | undefined;
        sql.push(typeof first === "string" ? first : (first?.text ?? ""));
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      } as never);
      const probe = createDbClient({ connectionString: appDbUrl, max: 1 });
      try {
        const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M10_OUTBOX_EVENTS]));
        const backend = createDbHopeBackend(
          probe.db,
          { publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m10" }) },
          () => new Date("2026-06-01T00:00:00.000Z"),
        );
        return { out: await run(backend), sql };
      } finally {
        spy.mockRestore();
        await probe.close();
      }
    }
    const q = async <T extends Record<string, unknown>>(
      sql: string,
      params: unknown[],
    ): Promise<T[]> => (await admin.query(sql, params)).rows as T[];
    const sfvRow = async (id: string) =>
      (
        await q<{ status: string; completing_assessment_id: string | null }>(
          "SELECT status, completing_assessment_id FROM symptom_follow_up_visit WHERE id=$1",
          [id],
        )
      )[0];
    /** The SFV's `due_at` exactly as the watchdog's snapshot carries it (read through a JS Date, ms precision). */
    const dueAtIso = async (id: string): Promise<string> =>
      (
        await q<{ due_at: Date }>("SELECT due_at FROM symptom_follow_up_visit WHERE id=$1", [id])
      )[0]?.due_at.toISOString() as string;
    const rfa04Count = async (): Promise<number> =>
      (
        await q<{ n: number }>(
          "SELECT count(*)::int AS n FROM hope_assessment WHERE rfa_kind='04_sfv' AND status='signed'",
          [],
        )
      )[0]?.n as number;
    const sfvCompletedEvents = async (sfvId: string): Promise<number> =>
      (
        await q<{ n: number }>(
          "SELECT count(*)::int AS n FROM outbox_event WHERE aggregate_id=$1 AND event_type='m10.hope.sfv_completed'",
          [sfvId],
        )
      )[0]?.n as number;
    const sfvAnswers = (assessmentId: string) =>
      q(
        `SELECT i.item_code, a.state, a.value FROM hope_assessment_answer a
         JOIN hope_spec_item i ON i.id = a.spec_item_id
        WHERE a.hope_assessment_id=$1 AND i.item_code ~ '^J205[23]' ORDER BY i.item_code`,
        [assessmentId],
      );
    const auditsFor = (eventType: string, resourceId: string) =>
      q<{
        actor_user_id: string | null;
        outcome: string;
        request_id: string | null;
        context: Record<string, unknown>;
      }>(
        "SELECT actor_user_id, outcome, request_id, context FROM audit_event WHERE event_type=$1 AND resource_id=$2",
        [eventType, resourceId],
      );
    /** Every row of an audit event type (a refused completion has no resource id to look up by). */
    const auditCount = async (eventType: string): Promise<number> =>
      (
        await q<{ n: number }>("SELECT count(*)::int AS n FROM audit_event WHERE event_type=$1", [
          eventType,
        ])
      )[0]?.n as number;
    const assessmentRow = async (id: string) =>
      (
        await q<{ status: string; version: number }>(
          "SELECT status, version FROM hope_assessment WHERE id=$1",
          [id],
        )
      )[0];

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await importHopeSpec({ databaseUrl: DB_URL });
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
        [ORG, ORG_B],
      );
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'r01r05-seed@x.test')`, [
        ORG_USER(1),
      ]);
      member.victim = await newMember(2, "rn");
      member.attacker = await newMember(3, "rn");
      member.orgwide = await newMember(4, "rn,medical_director");
      member.chaplain = await newMember(5, "chaplain");
      provider = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end,
                                      addresses, iqies_facility_id)
         VALUES ($1,'CCN-R01R05','R01R05','NPI-R01R05','enc','12-31',
                 '[{"line1":"1 St","city":"Town","state":"OR","postalCode":"97000"}]'::jsonb,'FACR01') RETURNING id`,
          [ORG],
        )
      ).rows[0].id as string;
      location = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [provider],
        )
      ).rows[0].id as string;
      const appUrl = await appRoleConnectionString(admin, DB_URL as string);
      appDbUrl = appUrl;
      handle = createDbClient({ connectionString: appUrl });
      const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M10_OUTBOX_EVENTS]));
      const outbox: HopeWriteOutboxPort = {
        publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m10" }),
      };
      // A fixed clock BEFORE every fixture window (as m10-hope-write): the answer engine picks the spec version
      // effective at the server clock, and the capture gate judges lateness on the later of this and `targetDate`.
      svc = createDbHopeBackend(handle.db, outbox, () => new Date("2026-06-01T00:00:00.000Z"));
    }, 120_000);

    afterAll(async () => {
      resetAuthorizationContract();
      resetRbacEngine();
      resetAbacRegistry();
      await app?.close();
      await handle?.close();
      if (admin) await admin.end();
    });

    beforeEach(async () => {
      resetAuthorizationContract();
      resetRbacEngine();
      resetAbacRegistry();
      __resetSeamsForTest();
      caseload.clear();
      registerSeam(
        "AdmissionStatusReader",
        createAdmissionStatusReader(createDrizzleAdmissionReaderStore(handle.db)),
      );
      registerPatientSeams({ db: handle.db });
      registerEffectivePermissionResolver(
        createInMemoryEffectivePermissionStore(
          Object.values(member).map((m) => ({
            orgId: ORG,
            userId: userOf[m] as string,
            grants: [
              {
                roleKey: "seed",
                enabled: true,
                expiresAt: null,
                permissionKeys: [
                  ...READ_KEYS,
                  ...WRITE_KEYS,
                  ...(m === member.orgwide ? [OVERRIDE_KEY] : []),
                ],
              },
            ],
          })),
        ).store,
      );
      const registry = createPredicateRegistry();
      for (const [name, fn] of Object.entries(
        buildHopeAbacPredicates({
          resolver: svc,
          isInCaseload: async ({ userId, patientId }) =>
            caseload.get(userId)?.has(patientId) === true,
          resolveAdmissionPatient: async (_o, id) =>
            patientOf[id] ? { patientId: patientOf[id] as string } : null,
        }),
      ))
        registry.register(name, fn);
      registry.register(
        "step_up_recent",
        async (context) => context.attributes.stepUpRecent === true,
      );
      registerAbacRegistry(registry);
      await app?.close();
      app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
      registerHopeRoutes(app, { service: svc, caseloadPatientIds: async () => [] });
      await app.ready();
    });

    describe("R-01 — SFV completion is bound to the URL admission", () => {
      it("a caseload clinician cannot complete another admission's SFV: 409 NO_TRIGGER, no RFA-04, SFV change, answer or completed event", async () => {
        const victim = await openSfv();
        const own = await admitted(); // the attacker's own admission (P2/A2)
        grantCaseload(member.attacker, patientOf[own] as string);
        const answersBefore = await sfvAnswers(victim.draftId);
        const rfa04Before = await rfa04Count();

        const res = await postSfv(own, as(member.attacker), victim.draftId);

        expect(res.statusCode).toBe(409);
        expect(codeOf(res)).toBe("M10_SFV_NO_TRIGGER");
        expect(res.body).not.toContain(victim.patientId); // the victim's patient id is never disclosed
        expect(await rfa04Count()).toBe(rfa04Before);
        expect(await sfvRow(victim.sfvId)).toEqual({
          status: "open",
          completing_assessment_id: null,
        });
        expect(await sfvAnswers(victim.draftId)).toEqual(answersBefore);
        expect(await sfvCompletedEvents(victim.sfvId)).toBe(0);
      });

      it("answers a foreign SFV id exactly like a random one — completed or not (no existence oracle)", async () => {
        const victim = await openSfv();
        const own = await admitted();
        grantCaseload(member.attacker, patientOf[own] as string);
        const bogus = await postSfv(own, as(member.attacker), BOGUS_TRIGGER);
        const foreignOpen = await postSfv(own, as(member.attacker), victim.draftId);
        expect(shapeOf(foreignOpen)).toEqual(shapeOf(bogus));
        expect(shapeOf(bogus).code).toBe("M10_SFV_NO_TRIGGER");

        // The owner completes it; the foreign caller must STILL not learn that it exists / is completed.
        expect((await postSfv(victim.adm, as(member.victim), victim.draftId)).statusCode).toBe(201);
        const foreignDone = await postSfv(own, as(member.attacker), victim.draftId);
        expect(shapeOf(foreignDone)).toEqual(shapeOf(bogus));
        // …while the owning admission is told the truth.
        const again = await postSfv(victim.adm, as(member.victim), victim.draftId);
        expect(codeOf(again)).toBe("M10_SFV_ALREADY_COMPLETED");
      });

      it("an SFV id from another organization gives the same result and leaves that org's SFV untouched", async () => {
        const own = await admitted();
        grantCaseload(member.attacker, patientOf[own] as string);
        const foreignTrigger = uuid("88000000", 1);
        const foreignSfv = (
          await admin.query(
            `INSERT INTO symptom_follow_up_visit (organization_id, patient_id, admission_id,
             triggering_assessment_id, triggered_at, due_at, status, alert_cadence)
           VALUES ($1,$2,$3,$4,now(),now() + interval '2 days','open','{}'::jsonb) RETURNING id`,
            [ORG_B, uuid("88000000", 2), uuid("88000000", 3), foreignTrigger],
          )
        ).rows[0].id as string;
        const res = await postSfv(own, as(member.attacker), foreignTrigger);
        const bogus = await postSfv(own, as(member.attacker), BOGUS_TRIGGER);
        expect(shapeOf(res)).toEqual(shapeOf(bogus));
        expect(shapeOf(res).status).toBe(409);
        expect(await sfvRow(foreignSfv)).toEqual({
          status: "open",
          completing_assessment_id: null,
        });
      });

      it("a caller who can reach every admission (org-wide role) still gets 409 for a mismatched pair", async () => {
        const victim = await openSfv();
        const other = await admitted();
        const res = await postSfv(other, as(member.orgwide), victim.draftId);
        expect(res.statusCode).toBe(409);
        expect(codeOf(res)).toBe("M10_SFV_NO_TRIGGER");
        expect((await sfvRow(victim.sfvId))?.status).toBe("open");
      });

      it("the legitimate pair completes (201) and the signed RFA-04 carries the SFV's own admission and patient", async () => {
        const victim = await openSfv();
        const res = await postSfv(victim.adm, as(member.victim), victim.draftId);
        expect(res.statusCode).toBe(201);
        const row = (
          await q<{ admission_id: string; patient_id: string; status: string; rfa_kind: string }>(
            "SELECT admission_id, patient_id, status, rfa_kind FROM hope_assessment WHERE id=$1",
            [res.json<{ id: string }>().id],
          )
        )[0];
        expect(row).toEqual({
          admission_id: victim.adm,
          patient_id: victim.patientId,
          status: "signed",
          rfa_kind: "04_sfv",
        });
        expect(await sfvRow(victim.sfvId)).toEqual({
          status: "completed",
          completing_assessment_id: res.json<{ id: string }>().id,
        });
        expect(await sfvCompletedEvents(victim.sfvId)).toBe(1);
      });

      it("two parallel completions: exactly one 201, the other 409 ALREADY_COMPLETED, exactly one signed RFA-04", async () => {
        const victim = await openSfv();
        const [a, b] = await Promise.all([
          postSfv(victim.adm, as(member.victim), victim.draftId),
          postSfv(victim.adm, as(member.victim), victim.draftId),
        ]);
        expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
        const loser = a.statusCode === 409 ? a : b;
        expect(codeOf(loser)).toBe("M10_SFV_ALREADY_COMPLETED");
        const rows = await q(
          "SELECT id FROM hope_assessment WHERE rfa_kind='04_sfv' AND admission_id=$1 AND status='signed'",
          [victim.adm],
        );
        expect(rows).toHaveLength(1);
        expect(await sfvCompletedEvents(victim.sfvId)).toBe(1);
      });

      it("a non-UUID triggeringAssessmentId is a 422, never a 500 from the uuid cast", async () => {
        const own = await admitted();
        grantCaseload(member.attacker, patientOf[own] as string);
        for (const bad of ["not-a-uuid", "1", "' OR 1=1 --"]) {
          const res = await postSfv(own, as(member.attacker), bad);
          expect(res.statusCode, bad).toBe(422);
        }
      });
    });

    describe("R-05 — POST /hope/assessments/:id/sign", () => {
      for (const [label, extra] of [
        ["an absent attestation", {}],
        ["an explicitly unconfirmed attestation", { attestationConfirmed: false }],
      ] as const) {
        it(`${label} is a 422, the draft keeps its status and version, and a valid retry then signs`, async () => {
          const d = await signReadyDraft();
          const res = await postSign(d.id, as(member.victim), { ifVersion: d.version, ...extra });
          expect(res.statusCode).toBe(422);
          expect(await assessmentRow(d.id)).toEqual({ status: "draft", version: d.version });
          expect(await auditsFor(SIGN_AUDIT, d.id)).toHaveLength(0);
          const retry = await postSign(d.id, as(member.victim), {
            ifVersion: d.version,
            attestationConfirmed: true,
          });
          expect(retry.statusCode).toBe(200);
          expect((await assessmentRow(d.id))?.status).toBe("signed");
        });
      }

      it("a stale step-up is 403 STEP_UP_REQUIRED and the row is unchanged; a fresh step-up signs", async () => {
        const d = await signReadyDraft();
        const body = { ifVersion: d.version, attestationConfirmed: true };
        const stale = await postSign(d.id, as(member.victim, STALE), body);
        expect(stale.statusCode).toBe(403);
        expect(codeOf(stale)).toBe("STEP_UP_REQUIRED");
        expect(await assessmentRow(d.id)).toEqual({ status: "draft", version: d.version });
        expect((await postSign(d.id, as(member.victim), body)).statusCode).toBe(200);
      });

      it("an active break-glass grant does not satisfy the step-up", async () => {
        const d = await signReadyDraft();
        setBreakGlassChecker(() => ({ eventId: "bg-1" }));
        const res = await postSign(d.id, as(member.victim, STALE), {
          ifVersion: d.version,
          attestationConfirmed: true,
        });
        expect(res.statusCode).toBe(403);
        expect(codeOf(res)).toBe("STEP_UP_REQUIRED");
        expect((await assessmentRow(d.id))?.status).toBe("draft");
      });

      it("a caller denied by caseload or by discipline is refused without being told to step up", async () => {
        const d = await signReadyDraft();
        const body = { ifVersion: d.version, attestationConfirmed: true };
        grantCaseload(member.chaplain, patientOf[d.adm] as string);
        const outOfScope = await postSign(d.id, as(member.attacker, STALE), body);
        expect(outOfScope.statusCode).toBe(404);
        const wrongDiscipline = await postSign(d.id, as(member.chaplain, STALE), body);
        expect(wrongDiscipline.statusCode).toBe(403);
        expect(codeOf(wrongDiscipline)).not.toBe("STEP_UP_REQUIRED");
        expect((await assessmentRow(d.id))?.status).toBe("draft");
      });

      it("an AI principal cannot sign (403)", async () => {
        const d = await signReadyDraft();
        const res = await postSign(d.id, as(member.victim, { "x-test-actor-kind": "ai_agent" }), {
          ifVersion: d.version,
          attestationConfirmed: true,
        });
        expect(res.statusCode).toBe(403);
        expect((await assessmentRow(d.id))?.status).toBe("draft");
      });

      it("a signature lands one PHI-free audit event naming the attestation and the signing membership", async () => {
        const d = await signReadyDraft();
        const res = await postSign(d.id, as(member.victim), {
          ifVersion: d.version,
          attestationConfirmed: true,
        });
        expect(res.statusCode).toBe(200);
        const audits = await auditsFor(SIGN_AUDIT, d.id);
        expect(audits).toHaveLength(1);
        const [event] = audits;
        expect(event?.outcome).toBe("success");
        expect(event?.context).toMatchObject({
          attestationConfirmed: true,
          byMembershipId: member.victim,
          rfaKind: "01_admission",
          stepUpRequiredOperation: "hope.timepoint.sign",
          serverCurrentAttestationVersion: HOPE_ATTESTATION_VERSION,
          serverCurrentAttestationStatementSha256: sha256Hex(HOPE_SIGN_ATTESTATION_STATEMENT),
          // The client named no version, so the row does not claim it saw the wording.
          attestationVersionSupplied: false,
          version: d.version + 1,
        });
        expect(Object.keys(event?.context ?? {}).sort()).toEqual(SIGN_AUDIT_KEYS);
        // The HTTP request id rides in the row's own column, so the signature ties to its request.
        expect(event?.request_id).toEqual(expect.stringMatching(/\S/));
        expect(JSON.stringify(event?.context)).not.toContain(patientOf[d.adm] as string);
      });
    });

    describe("R-05 — POST /admissions/:admissionId/hope/sfv (the second signing path)", () => {
      for (const [label, over] of [
        ["an absent attestation", { attestationConfirmed: undefined }],
        ["an explicitly unconfirmed attestation", { attestationConfirmed: false }],
      ] as const) {
        it(`${label} is a 422 and the SFV stays open; a valid retry then completes`, async () => {
          const s = await openSfv();
          const res = await postSfv(s.adm, as(member.victim), s.draftId, over);
          expect(res.statusCode).toBe(422);
          expect(await sfvRow(s.sfvId)).toEqual({ status: "open", completing_assessment_id: null });
          expect(await sfvCompletedEvents(s.sfvId)).toBe(0);
          expect((await postSfv(s.adm, as(member.victim), s.draftId)).statusCode).toBe(201);
        });
      }

      it("a stale step-up is 403 STEP_UP_REQUIRED (also under break-glass) and the SFV stays open", async () => {
        const s = await openSfv();
        const stale = await postSfv(s.adm, as(member.victim, STALE), s.draftId);
        expect(stale.statusCode).toBe(403);
        expect(codeOf(stale)).toBe("STEP_UP_REQUIRED");
        setBreakGlassChecker(() => ({ eventId: "bg-1" }));
        const underGlass = await postSfv(s.adm, as(member.victim, STALE), s.draftId);
        expect(underGlass.statusCode).toBe(403);
        expect(codeOf(underGlass)).toBe("STEP_UP_REQUIRED");
        expect(await sfvRow(s.sfvId)).toEqual({ status: "open", completing_assessment_id: null });
      });

      it("a caller denied by caseload or by discipline is refused without being told to step up", async () => {
        const s = await openSfv();
        const outOfScope = await postSfv(s.adm, as(member.attacker, STALE), s.draftId);
        expect(outOfScope.statusCode).toBe(404);
        grantCaseload(member.chaplain, s.patientId);
        const wrongDiscipline = await postSfv(s.adm, as(member.chaplain, STALE), s.draftId);
        expect(wrongDiscipline.statusCode).toBe(403);
        expect(codeOf(wrongDiscipline)).not.toBe("STEP_UP_REQUIRED");
        expect((await sfvRow(s.sfvId))?.status).toBe("open");
      });

      it("an AI principal cannot complete an SFV (403)", async () => {
        const s = await openSfv();
        const res = await postSfv(
          s.adm,
          as(member.victim, { "x-test-actor-kind": "ai_agent" }),
          s.draftId,
        );
        expect(res.statusCode).toBe(403);
        expect((await sfvRow(s.sfvId))?.status).toBe("open");
      });

      it("the completion lands one PHI-free audit event naming the attestation and the signing membership", async () => {
        const s = await openSfv();
        const res = await postSfv(s.adm, as(member.victim), s.draftId);
        expect(res.statusCode).toBe(201);
        const completionId = res.json<{ id: string }>().id;
        const audits = await auditsFor(SFV_AUDIT, completionId);
        expect(audits).toHaveLength(1);
        const [event] = audits;
        expect(event?.context).toMatchObject({
          attestationConfirmed: true,
          byMembershipId: member.victim,
          rfaKind: "04_sfv",
          stepUpRequiredOperation: "hope.sfv.record",
          serverCurrentAttestationVersion: HOPE_ATTESTATION_VERSION,
          serverCurrentAttestationStatementSha256: sha256Hex(HOPE_SFV_ATTESTATION_STATEMENT),
          attestationVersionSupplied: false,
          sfvId: s.sfvId,
        });
        expect(event?.request_id).toEqual(expect.stringMatching(/\S/));
        expect(Object.keys(event?.context ?? {}).sort()).toEqual(
          [...SIGN_AUDIT_KEYS, "sfvId"].sort(),
        );
        expect(JSON.stringify(event?.context)).not.toContain(s.patientId);
      });
    });

    describe("the workflow state lists only the URL admission's own SFVs", () => {
      it("a re-admitted patient: each admission's state carries its own SFV, and the re-admission's SFV completes through it", async () => {
        const first = await openSfv();
        // One OPEN admission per patient (admission_patient_open_idx): the first episode ends, then the
        // SAME patient is admitted again.
        await admin.query(
          "UPDATE admission SET status='discharged', discharged_at=now() WHERE id=$1",
          [first.adm],
        );
        const second = await openSfv(member.victim, first.patientId);
        expect(second.patientId).toBe(first.patientId);

        const firstState = await svc.getWorkflowState(ORG, first.adm);
        const secondState = await svc.getWorkflowState(ORG, second.adm);
        expect(firstState.sfvs.map((x) => x.id)).toEqual([first.sfvId]);
        expect(secondState.sfvs.map((x) => x.id)).toEqual([second.sfvId]);

        // The capture workspace posts the SFV it was shown to the admission it is open on: it must work.
        const shown = secondState.sfvs[0];
        const res = await postSfv(
          second.adm,
          as(member.victim),
          shown?.triggeringAssessmentId ?? "",
        );
        expect(res.statusCode).toBe(201);
        expect((await sfvRow(second.sfvId))?.status).toBe("completed");
        expect((await sfvRow(first.sfvId))?.status).toBe("open"); // the first admission's SFV is untouched
      });
    });

    describe("a refused or repeated completion writes nothing (no RFA-04, no audit row)", () => {
      /** Counters that must not move across a refusal, read around it. */
      const snapshot = async () => ({
        rfa04: await rfa04Count(),
        completed: await auditCount(SFV_AUDIT),
        override: await auditCount(LATE_OVERRIDE_AUDIT),
      });

      for (const [label, data] of [
        ["no J2053 content at all", { J: {} }],
        ["a J2051-only payload", TRIGGER_DATA],
        [
          "a J2053 block missing J2053H",
          {
            J: {
              J2053: Object.fromEntries(
                ["A", "B", "C", "D", "E", "F", "G"].map((l) => [`J2053${l}`, "1"]),
              ),
            },
          },
        ],
      ] as const) {
        it(`${label} is a 422 M10_SFV_COMPLETION_INCOMPLETE and the SFV stays open`, async () => {
          const s = await openSfv();
          const before = await snapshot();
          const res = await postSfv(s.adm, as(member.victim), s.draftId, { data });
          expect(res.statusCode).toBe(422);
          expect(codeOf(res)).toBe("M10_SFV_COMPLETION_INCOMPLETE");
          expect(await snapshot()).toEqual(before);
          expect(await sfvRow(s.sfvId)).toEqual({ status: "open", completing_assessment_id: null });
          expect(await sfvCompletedEvents(s.sfvId)).toBe(0);
          expect((await postSfv(s.adm, as(member.victim), s.draftId)).statusCode).toBe(201);
        });
      }

      it("past due WITHOUT an override is a 409 M10_SFV_PAST_DUE: no RFA-04, no audit row, and the SFV stays open", async () => {
        const s = await openSfv();
        const before = await snapshot();
        const res = await postSfv(s.adm, as(member.victim), s.draftId, {
          targetDate: daysFromNow(10),
        });
        expect(res.statusCode).toBe(409);
        expect(codeOf(res)).toBe("M10_SFV_PAST_DUE");
        expect(await snapshot()).toEqual(before);
        expect(await sfvRow(s.sfvId)).toEqual({ status: "open", completing_assessment_id: null });
      });

      it("a repeat completion is a 409 M10_SFV_ALREADY_COMPLETED and adds no RFA-04 and no audit row", async () => {
        const s = await openSfv();
        expect((await postSfv(s.adm, as(member.victim), s.draftId)).statusCode).toBe(201);
        const before = await snapshot();
        const again = await postSfv(s.adm, as(member.victim), s.draftId);
        expect(again.statusCode).toBe(409);
        expect(codeOf(again)).toBe("M10_SFV_ALREADY_COMPLETED");
        expect(await snapshot()).toEqual(before);
        expect(await sfvCompletedEvents(s.sfvId)).toBe(1);
      });

      it("a `missed` SFV refuses a late completion without an override and completes exactly once with a valid one", async () => {
        const s = await openSfv();
        await admin.query("UPDATE symptom_follow_up_visit SET status='missed' WHERE id=$1", [
          s.sfvId,
        ]);
        const late = { targetDate: daysFromNow(10) };
        const before = await snapshot();
        const refused = await postSfv(s.adm, as(member.orgwide), s.draftId, late);
        expect(codeOf(refused)).toBe("M10_SFV_PAST_DUE");
        expect(await snapshot()).toEqual(before);

        const override = {
          ...late,
          adminOverride: true,
          adminOverrideJustification: OVERRIDE_REASON,
        };
        const done = await postSfv(s.adm, as(member.orgwide), s.draftId, override);
        expect(done.statusCode).toBe(201);
        expect((await sfvRow(s.sfvId))?.status).toBe("completed");
        const after = await snapshot();
        expect(after).toEqual({
          rfa04: before.rfa04 + 1,
          completed: before.completed + 1,
          override: before.override + 1,
        });
        // The override event keeps the typed reason: the only record, in an immutable trail, of why the due date was lifted.
        const completingId = (await sfvRow(s.sfvId))?.completing_assessment_id as string;
        const overrideAudits = await auditsFor(LATE_OVERRIDE_AUDIT, completingId);
        expect(overrideAudits).toHaveLength(1);
        expect(overrideAudits[0]?.context).toMatchObject({ justification: OVERRIDE_REASON });
        // A repeat of the same valid override is the ALREADY_COMPLETED refusal: still exactly once.
        const repeat = await postSfv(s.adm, as(member.orgwide), s.draftId, override);
        expect(codeOf(repeat)).toBe("M10_SFV_ALREADY_COMPLETED");
        expect(await snapshot()).toEqual(after);
        expect(await sfvCompletedEvents(s.sfvId)).toBe(1);
      });
    });

    describe("the SFV status writers never revert a completed SFV", () => {
      const flip = (
        sfvId: string,
        from: "open" | "overdue",
        to: "overdue" | "missed",
        snapshotDueAt: string,
      ) =>
        withOrgContext(handle.db, { organizationId: ORG, userId: "" }, async (tx) =>
          updateSfvStatus(tx as unknown as DbClient, { sfvId, from, to, snapshotDueAt }),
        );

      it("the watchdog's status flip leaves a completed SFV completed and reports the lost race", async () => {
        const s = await openSfv();
        expect((await postSfv(s.adm, as(member.victim), s.draftId)).statusCode).toBe(201);
        const due = await dueAtIso(s.sfvId);
        expect(await flip(s.sfvId, "open", "overdue", due)).toBe(false);
        expect(await flip(s.sfvId, "overdue", "missed", due)).toBe(false);
        const row = await sfvRow(s.sfvId);
        expect(row?.status).toBe("completed");
        expect(row?.completing_assessment_id).not.toBeNull();
      });

      it("the same flip still decays an open SFV (the guard is not a blanket refusal)", async () => {
        const s = await openSfv();
        expect(await flip(s.sfvId, "open", "overdue", await dueAtIso(s.sfvId))).toBe(true);
        expect((await sfvRow(s.sfvId))?.status).toBe("overdue");
      });

      it("a flip planned from a status the row no longer has misses (the exact status, not the family)", async () => {
        const s = await openSfv();
        const due = await dueAtIso(s.sfvId);
        expect(await flip(s.sfvId, "open", "overdue", due)).toBe(true);

        // A second tick planned the same open -> overdue from the same snapshot: the row is `overdue` now.
        expect(await flip(s.sfvId, "open", "overdue", due)).toBe(false);
        expect((await sfvRow(s.sfvId))?.status).toBe("overdue");
        // overdue -> missed is its own transition and still goes through.
        expect(await flip(s.sfvId, "overdue", "missed", due)).toBe(true);
        expect((await sfvRow(s.sfvId))?.status).toBe("missed");
      });

      it("a flip planned from an older due date than the row now has misses (no false escalation)", async () => {
        const s = await openSfv();
        const planned = await dueAtIso(s.sfvId);
        // A reconcile moves the due date LATER after the watchdog's snapshot: against the new date the SFV
        // is not overdue, so the decay planned from the old one must not be applied.
        await admin.query(
          "UPDATE symptom_follow_up_visit SET due_at = due_at + interval '1 day' WHERE id=$1",
          [s.sfvId],
        );
        expect(await flip(s.sfvId, "open", "missed", planned)).toBe(false);
        expect((await sfvRow(s.sfvId))?.status).toBe("open");
      });

      it("matches a due date stored with sub-millisecond precision (the snapshot went through a JS Date that truncates, .123987 -> .123, where rounding would give .124)", async () => {
        const s = await openSfv();
        await admin.query(
          "UPDATE symptom_follow_up_visit SET due_at = date_trunc('second', now()) + interval '2 days 123987 microseconds' WHERE id=$1",
          [s.sfvId],
        );
        expect(await flip(s.sfvId, "open", "overdue", await dueAtIso(s.sfvId))).toBe(true);
      });
    });

    describe("two overlapping SFV watchdog ticks", () => {
      it("announce one flip once, count the lost race, and emit their alerts only after the transaction committed", async () => {
        const s = await openSfv();
        const due = new Date(await dueAtIso(s.sfvId));
        const published: { eventName: string; sfvId: unknown }[] = [];
        const emitted: { eventType: string; committedStatus: string }[] = [];
        let released = false;
        // The first tick to hold the row (it has flipped it, and publishes next) waits until the OTHER tick is parked
        // on that row lock: by then both ticks have read the same snapshot, which says `open`.
        const holdUntilOtherTickParked = async (): Promise<void> => {
          if (released) return;
          await vi.waitFor(
            async () => {
              const parked = await q(
                `SELECT 1 FROM pg_stat_activity
                  WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
                    AND query ILIKE 'update "symptom_follow_up_visit"%'`,
                [],
              );
              expect(parked.length).toBeGreaterThan(0);
            },
            { timeout: 10_000, interval: 25 },
          );
          released = true;
        };
        const deps = {
          connection: {} as never,
          db: handle.db,
          now: () => new Date(due.getTime() + 3_600_000),
          activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
          outbox: {
            publish: async (
              _tx: unknown,
              e: { eventName: string; payload: { sfvId?: unknown } },
            ) => {
              if (e.payload.sfvId === s.sfvId)
                published.push({ eventName: e.eventName, sfvId: s.sfvId });
              await holdUntilOtherTickParked();
            },
          },
          alerts: {
            emit: async (
              _org: string,
              a: { eventType: string; payload: Record<string, unknown> },
            ) => {
              if (a.payload.workflowItemId === s.sfvId) {
                // Past the commit: the flip is visible to an independent connection (inside the tick's own tx it would read `open`).
                const committedStatus = (await sfvRow(s.sfvId))?.status as string;
                emitted.push({ eventType: a.eventType, committedStatus });
              }
              return { alertId: "alert-1", resolvedRecipientCount: 0 };
            },
          },
        };
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          await Promise.all([
            runSfvWatchdogCron(deps as unknown as Parameters<typeof runSfvWatchdogCron>[0]),
            runSfvWatchdogCron(deps as unknown as Parameters<typeof runSfvWatchdogCron>[0]),
          ]);
          const lost = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("lost"));
          expect(lost.length).toBeGreaterThan(0);
          expect(lost.join("\n")).toContain(ORG);
          expect(lost.join("\n")).toContain(s.sfvId);
        } finally {
          warn.mockRestore();
        }

        expect((await sfvRow(s.sfvId))?.status).toBe("overdue");
        expect(published).toEqual([{ eventName: "m10.hope.sfv_overdue", sfvId: s.sfvId }]);
        // Every tick re-plans its alerts from the committed state, so each of the two emits it; the real emitter absorbs
        // the repeat on (org, correlationId). What matters here: every emission is the overdue alert, and by then the
        // flip was committed (inside a tick's own transaction it would read `open`).
        expect(emitted.length).toBeGreaterThan(0);
        expect(
          emitted.every(
            (e) => e.eventType === "m10.hope.sfv_overdue" && e.committedStatus === "overdue",
          ),
        ).toBe(true);
      });
    });

    describe("durable watchdog alert delivery", () => {
      type TickDeps = Parameters<typeof runSfvWatchdogCron>[0];
      /** An emitter that behaves like the real one: a repeat of a delivered (org, correlationId) is absorbed. */
      function dedupingEmitter(
        failWhen: (org: string, a: { payload: Record<string, unknown> }) => boolean,
      ) {
        const delivered = new Map<string, number>();
        const calls: string[] = [];
        return {
          delivered,
          calls,
          emit: async (
            org: string,
            a: { eventType: string; correlationId: string; payload: Record<string, unknown> },
          ) => {
            calls.push(a.correlationId);
            if (failWhen(org, a)) throw new Error("emitter unavailable for Jane Doe");
            const key = `${org}|${a.correlationId}`;
            delivered.set(key, (delivered.get(key) ?? 0) + (delivered.has(key) ? 0 : 1));
            return { alertId: key, resolvedRecipientCount: 0 };
          },
        };
      }
      const depsOf = (
        orgs: string[],
        now: Date,
        emit: ReturnType<typeof dedupingEmitter>["emit"],
        published: { eventName: string; id: unknown }[] = [],
      ): TickDeps =>
        ({
          connection: {} as never,
          db: handle.db,
          now: () => now,
          activeOrgs: {
            listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })),
          },
          outbox: {
            publish: async (
              _tx: unknown,
              e: { eventName: string; payload: Record<string, unknown> },
            ) => {
              published.push({
                eventName: e.eventName,
                id: e.payload.sfvId ?? e.payload.scheduleId,
              });
            },
          },
          alerts: { emit },
        }) as unknown as TickDeps;
      /** Put the admission's schedule's late deadline in the past, so the watchdog expires it on the REAL clock. */
      const expireOnRealClock = (scheduleId: string) =>
        admin.query(
          `UPDATE hope_timepoint_schedule SET window_opens_at = now() - interval '20 days',
             window_closes_at = now() - interval '15 days', late_deadline_at = now() - interval '1 day' WHERE id=$1`,
          [scheduleId],
        );
      const keyOf = (corr: string): string => `${ORG}|${corr}`;

      it("a failed alert emit is retried by the next tick and delivered exactly once, never lost with the tick that saw the flip", async () => {
        const s = await openSfv();
        const due = new Date(await dueAtIso(s.sfvId));
        const now = new Date(due.getTime() + 3_600_000);
        const corr = `${ORG}:m10.hope.sfv_overdue:${s.sfvId}:overdue`;
        let failedOnce = false;
        const emitter = dedupingEmitter((_org, a) => {
          if (a.payload.workflowItemId !== s.sfvId || failedOnce) return false;
          failedOnce = true;
          return true;
        });
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          // Tick 1: the flip commits, then the emit for THIS SFV fails: the tick throws (the job-failure alert fires).
          await expect(runSfvWatchdogCron(depsOf([ORG], now, emitter.emit))).rejects.toThrow(
            /failed for 1 of 1/,
          );
          expect((await sfvRow(s.sfvId))?.status).toBe("overdue");
          expect(emitter.delivered.has(keyOf(corr))).toBe(false);
          const logged = error.mock.calls.map((c) => String(c[0])).join("\n");
          expect(logged).toContain(corr);
          expect(logged).not.toContain("Jane Doe"); // ids and the error class only

          // Tick 2: nothing transitions (the SFV is already overdue), yet the alert is delivered.
          await runSfvWatchdogCron(depsOf([ORG], now, emitter.emit));
          expect(emitter.delivered.get(keyOf(corr))).toBe(1);

          // Tick 3: re-emitted and absorbed: still exactly one delivery.
          await runSfvWatchdogCron(depsOf([ORG], now, emitter.emit));
        } finally {
          error.mockRestore();
        }
        expect(emitter.delivered.get(keyOf(corr))).toBe(1);
        expect(emitter.calls.filter((c) => c === corr).length).toBeGreaterThanOrEqual(3);
      });

      it("a failure in one org does not stop the others, and the run throws once at the end", async () => {
        // Real-clock fixtures: a tick's replay window is measured from its `now`, and `updated_at` is written by the real clock.
        const s = await openSfv();
        await admin.query(
          "UPDATE symptom_follow_up_visit SET due_at = now() - interval '3 hours' WHERE id=$1",
          [s.sfvId],
        );
        const orgB = (
          await admin.query(
            `INSERT INTO symptom_follow_up_visit (organization_id, patient_id, admission_id,
             triggering_assessment_id, triggered_at, due_at, status, alert_cadence)
           VALUES ($1,$2,$3,$4,now() - interval '9 days',now() - interval '8 days','open','{}'::jsonb) RETURNING id`,
            [ORG_B, uuid("66000000", 1), uuid("66000000", 2), uuid("66000000", 3)],
          )
        ).rows[0].id as string;
        const emitter = dedupingEmitter((org) => org === ORG); // every ORG emit fails
        const published: { eventName: string; id: unknown }[] = [];
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          await expect(
            runSfvWatchdogCron(depsOf([ORG, ORG_B], new Date(), emitter.emit, published)),
          ).rejects.toThrow(/failed for 1 of 2/);
          const logged = error.mock.calls.map((c) => String(c[0])).join("\n");
          // The FAILURE lines name only the failing org (ORG_B is delivered; a zero-recipient notice about it is a different line).
          const failures = logged.split("\n").filter((line) => line.includes("could not emit"));
          expect(failures.join("\n")).toContain(ORG);
          expect(failures.join("\n")).not.toContain(ORG_B);
        } finally {
          error.mockRestore();
        }

        // ORG_B came AFTER the failing org and was still processed: its SFV decayed and its alert was delivered.
        expect(
          (
            await q<{ status: string }>("SELECT status FROM symptom_follow_up_visit WHERE id=$1", [
              orgB,
            ])
          )[0]?.status,
        ).toBe("missed");
        expect([...emitter.delivered.keys()].some((k) => k.startsWith(`${ORG_B}|`))).toBe(true);
        expect((await sfvRow(s.sfvId))?.status).toBe("overdue");
      });

      it("a sign that wins the race with the window watchdog is never overwritten completed -> expired, and nothing is announced", async () => {
        const adm = await admitted();
        const scheduleId = (
          await q<{ id: string }>("SELECT id FROM hope_timepoint_schedule WHERE admission_id=$1", [
            adm,
          ])
        )[0]?.id as string;
        await expireOnRealClock(scheduleId);
        const emitter = dedupingEmitter(() => false);
        const published: { eventName: string; id: unknown }[] = [];
        const holder = new Client({ connectionString: DB_URL });
        await holder.connect();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        let tick: Promise<void> | undefined;
        try {
          await holder.query("BEGIN");
          await holder.query("SELECT 1 FROM hope_timepoint_schedule WHERE id=$1 FOR UPDATE", [
            scheduleId,
          ]);
          tick = runHopeWindowWatchdogCron(depsOf([ORG], new Date(), emitter.emit, published));
          await vi.waitFor(
            async () => {
              const parked = await q(
                `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
                   AND wait_event_type = 'Lock' AND query ILIKE 'update "hope_timepoint_schedule"%'`,
                [],
              );
              expect(parked.length).toBeGreaterThan(0);
            },
            { timeout: 10_000, interval: 25 },
          );
          // The sign: the schedule completes while the watchdog is parked on its planned open -> expired write.
          await holder.query("UPDATE hope_timepoint_schedule SET status='completed' WHERE id=$1", [
            scheduleId,
          ]);
          await holder.query("COMMIT");
          await tick;
          const lost = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("lost"));
          expect(lost.join("\n")).toContain(scheduleId);
        } finally {
          await holder.query("ROLLBACK").catch(() => undefined);
          await holder.end();
          await tick?.catch(() => undefined);
          warn.mockRestore();
        }

        expect(
          (
            await q<{ status: string }>("SELECT status FROM hope_timepoint_schedule WHERE id=$1", [
              scheduleId,
            ])
          )[0]?.status,
        ).toBe("completed");
        expect(published.filter((e) => e.id === scheduleId)).toEqual([]);
        expect(emitter.calls.filter((c) => c.includes(scheduleId))).toEqual([]);
      });

      it("the window watchdog's expired alert is retried by the next tick too, and delivered exactly once", async () => {
        const adm = await admitted();
        const scheduleId = (
          await q<{ id: string }>("SELECT id FROM hope_timepoint_schedule WHERE admission_id=$1", [
            adm,
          ])
        )[0]?.id as string;
        await expireOnRealClock(scheduleId);
        const corr = `${ORG}:m10.hope.timepoint_expired:${scheduleId}:window_expired`;
        let failedOnce = false;
        const emitter = dedupingEmitter((_org, a) => {
          if (a.payload.workflowItemId !== scheduleId || failedOnce) return false;
          failedOnce = true;
          return true;
        });
        const now = new Date();
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          await expect(runHopeWindowWatchdogCron(depsOf([ORG], now, emitter.emit))).rejects.toThrow(
            /failed for 1 of 1/,
          );
          expect(emitter.delivered.has(keyOf(corr))).toBe(false);

          await runHopeWindowWatchdogCron(depsOf([ORG], now, emitter.emit));
        } finally {
          error.mockRestore();
        }
        expect(
          (
            await q<{ status: string }>("SELECT status FROM hope_timepoint_schedule WHERE id=$1", [
              scheduleId,
            ])
          )[0]?.status,
        ).toBe("expired");
        expect(emitter.delivered.get(keyOf(corr))).toBe(1);
      });
    });

    describe("service-level attestation, strict body, patient binding, parallel signs", () => {
      it("signTimepoint and recordSfv refuse an unattested direct call (422): the draft stays a draft with no sign audit row, and the SFV stays open", async () => {
        const d = await signReadyDraft();
        await expect(svc.signTimepoint(ORG, member.victim, d.id)).rejects.toMatchObject({
          code: "M10_ATTESTATION_REQUIRED",
        });
        await expect(
          svc.signTimepoint(ORG, member.victim, d.id, { ifVersion: d.version }),
        ).rejects.toMatchObject({ code: "M10_ATTESTATION_REQUIRED" });
        expect(await assessmentRow(d.id)).toEqual({ status: "draft", version: d.version });
        expect(await auditsFor(SIGN_AUDIT, d.id)).toHaveLength(0);

        const s = await openSfv();
        await expect(
          svc.recordSfv(ORG, member.victim, s.adm, {
            triggeringAssessmentId: s.draftId,
            targetDate: new Date().toISOString(),
            authorDiscipline: "RN",
            data: SFV_DATA,
          }),
        ).rejects.toMatchObject({ code: "M10_ATTESTATION_REQUIRED" });
        expect(await sfvRow(s.sfvId)).toEqual({ status: "open", completing_assessment_id: null });
      });

      it('a coerced attestation ("true", 1) is a 422 on both signing routes: the draft stays a draft and the SFV stays open', async () => {
        const d = await signReadyDraft();
        const s = await openSfv();
        for (const coerced of ["true", 1]) {
          const sign = await postSign(d.id, as(member.victim), {
            ifVersion: d.version,
            attestationConfirmed: coerced,
          });
          expect(sign.statusCode).toBe(422);
          expect(codeOf(sign)).toBe("M10_ATTESTATION_REQUIRED");
          const sfv = await postSfv(s.adm, as(member.victim), s.draftId, {
            attestationConfirmed: coerced,
          });
          expect(sfv.statusCode).toBe(422);
          expect(codeOf(sfv)).toBe("M10_ATTESTATION_REQUIRED");
        }
        expect(await assessmentRow(d.id)).toEqual({ status: "draft", version: d.version });
        expect(await sfvRow(s.sfvId)).toEqual({ status: "open", completing_assessment_id: null });
      });

      it("an SFV whose patient is not the admission's answers exactly like an unknown one (409 NO_TRIGGER)", async () => {
        const own = await admitted();
        grantCaseload(member.attacker, patientOf[own] as string);
        const mispairedTrigger = uuid("88000000", 9);
        const mispaired = (
          await admin.query(
            `INSERT INTO symptom_follow_up_visit (organization_id, patient_id, admission_id,
             triggering_assessment_id, triggered_at, due_at, status, alert_cadence)
           VALUES ($1,$2,$3,$4,now(),now() + interval '2 days','open','{}'::jsonb) RETURNING id`,
            [ORG, uuid("88000000", 8), own, mispairedTrigger],
          )
        ).rows[0].id as string;
        const rfa04Before = await rfa04Count();
        const res = await postSfv(own, as(member.attacker), mispairedTrigger);
        const bogus = await postSfv(own, as(member.attacker), BOGUS_TRIGGER);
        expect(shapeOf(res)).toEqual(shapeOf(bogus));
        expect(shapeOf(res).status).toBe(409);
        expect(await rfa04Count()).toBe(rfa04Before);
        expect(await sfvRow(mispaired)).toEqual({ status: "open", completing_assessment_id: null });
      });

      it("two parallel signs of one draft: exactly one 200 and one 409 (never a 404), one audit row", async () => {
        const d = await signReadyDraft();
        const body = { ifVersion: d.version, attestationConfirmed: true };
        const [a, b] = await Promise.all([
          postSign(d.id, as(member.victim), body),
          postSign(d.id, as(member.victim), body),
        ]);
        expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
        const loser = a.statusCode === 409 ? a : b;
        expect(codeOf(loser)).toBe("M10_CORRECTION_TARGET_NOT_SIGNED");
        expect((await assessmentRow(d.id))?.status).toBe("signed");
        expect(await auditsFor(SIGN_AUDIT, d.id)).toHaveLength(1);
      });
    });

    describe("SFV completion guards: seam outage, CMS-allowed values, locked write, audit facts", () => {
      const withJ2053 = (over: Record<string, unknown>) => ({
        J: { J2053: { ...SFV_DATA.J.J2053, ...over } },
      });
      const answerValues = async (assessmentId: string): Promise<Record<string, unknown>> =>
        Object.fromEntries((await sfvAnswers(assessmentId)).map((a) => [a.item_code, a.value]));

      it("a thrown seam read is a retryable 503, never 'no SFV obligation', and is logged without PHI", async () => {
        const s = await openSfv();
        const rfa04Before = await rfa04Count();
        const real = createAdmissionStatusReader(createDrizzleAdmissionReaderStore(handle.db));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          registerSeam("AdmissionStatusReader", {
            ...real,
            getAdmissionSummary: async () => {
              throw new Error("connection reset while reading Jane Doe's admission");
            },
          });
          const own = await postSfv(s.adm, as(member.victim), s.draftId);
          const bogus = await postSfv(s.adm, as(member.victim), BOGUS_TRIGGER);

          // A 5xx, so the idempotency plugin releases the key (a 422 would be cached for 24 hours).
          expect(own.statusCode).toBe(503);
          expect(codeOf(own)).toBe("DEGRADED");
          // Keyed on the URL admission only: a real and a made-up triggering id see the same refusal.
          expect(shapeOf(own)).toEqual(shapeOf(bogus));
          const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
          expect(logged).toContain(s.adm);
          expect(logged).not.toContain("Jane Doe");
          expect(own.body).not.toContain("Jane Doe");
          expect(await rfa04Count()).toBe(rfa04Before);
          expect(await sfvRow(s.sfvId)).toEqual({ status: "open", completing_assessment_id: null });
          expect(await sfvCompletedEvents(s.sfvId)).toBe(0);

          // The outage is transient: once the seam answers again the same request completes the SFV.
          registerSeam("AdmissionStatusReader", real);
          expect((await postSfv(s.adm, as(member.victim), s.draftId)).statusCode).toBe(201);
        } finally {
          registerSeam("AdmissionStatusReader", real);
          warn.mockRestore();
        }
      });

      it.each([
        ["another organization's admission", { organizationId: ORG_B }],
        ["an admission with no patient", { patientId: undefined }],
      ])(
        "%s from the seam is a data gap: 422 M10_ADMISSION_PROJECTION_GAP, not a 503",
        async (_l, over) => {
          const s = await openSfv();
          const real = createAdmissionStatusReader(createDrizzleAdmissionReaderStore(handle.db));
          const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
          try {
            registerSeam("AdmissionStatusReader", {
              ...real,
              getAdmissionSummary: async (org, id) =>
                ({ ...(await real.getAdmissionSummary(org, id)), ...over }) as AdmissionSummary,
            });
            const res = await postSfv(s.adm, as(member.victim), s.draftId);

            expect(res.statusCode).toBe(422);
            expect(codeOf(res)).toBe("M10_ADMISSION_PROJECTION_GAP");
          } finally {
            registerSeam("AdmissionStatusReader", real);
            warn.mockRestore();
          }
          expect(await sfvRow(s.sfvId)).toEqual({ status: "open", completing_assessment_id: null });
        },
      );

      it.each([
        ["an arbitrary string", { J2053A: "SECRET-FREE-TEXT" }],
        ["an out-of-range number", { J2053D: 99999 }],
        ["the skip-pattern caret", { J2053H: "^" }],
      ])(
        "%s in J2053 is a 422 INCOMPLETE and writes nothing (RFA-04, answers, audit, event)",
        async (_l, over) => {
          const s = await openSfv();
          const answersBefore = await sfvAnswers(s.draftId);
          const rfa04Before = await rfa04Count();
          const completedAudits = await auditCount(SFV_AUDIT);

          const res = await postSfv(s.adm, as(member.victim), s.draftId, { data: withJ2053(over) });

          expect(res.statusCode).toBe(422);
          expect(codeOf(res)).toBe("M10_SFV_COMPLETION_INCOMPLETE");
          expect(res.body).not.toContain("SECRET-FREE-TEXT");
          expect(res.body).toContain(Object.keys(over)[0] as string);
          expect(await rfa04Count()).toBe(rfa04Before);
          expect(await sfvRow(s.sfvId)).toEqual({ status: "open", completing_assessment_id: null });
          expect(await sfvAnswers(s.draftId)).toEqual(answersBefore);
          expect(await auditCount(SFV_AUDIT)).toBe(completedAudits);
          expect(await sfvCompletedEvents(s.sfvId)).toBe(0);
        },
      );

      it("every CMS option (0-3, 9, and a numeric 3) completes and lands as a derived answer", async () => {
        const s = await openSfv();
        const res = await postSfv(s.adm, as(member.victim), s.draftId, {
          data: withJ2053({ J2053A: "0", J2053B: 3, J2053C: "2", J2053D: "9" }),
        });

        expect(res.statusCode).toBe(201);
        expect(await answerValues(s.draftId)).toMatchObject({
          J2053A: "0",
          J2053B: "3",
          J2053C: "2",
          J2053D: "9",
        });
      });

      it("the review self-heal never writes an invalid J2053 value of an earlier completion", async () => {
        const s = await openSfv();
        expect((await postSfv(s.adm, as(member.victim), s.draftId)).statusCode).toBe(201);
        const rfa04 = (
          await q<{ id: string }>(
            "SELECT id FROM hope_assessment WHERE rfa_kind='04_sfv' AND admission_id=$1",
            [s.adm],
          )
        )[0]?.id as string;
        // A completion recorded before the values were checked: corrupt its stored payload (a trigger-free
        // superuser edit, the only way to fabricate that legacy state) and clear the derived answers.
        const rewrite = async (value: string): Promise<void> => {
          await admin.query("BEGIN");
          await admin.query("SET LOCAL session_replication_role = replica");
          await admin.query(
            "UPDATE hope_assessment SET data = jsonb_set(data, '{J,J2053,J2053A}', to_jsonb($2::text)) WHERE id=$1",
            [rfa04, value],
          );
          await admin.query(
            `DELETE FROM hope_assessment_answer a USING hope_spec_item i
              WHERE a.spec_item_id = i.id AND a.hope_assessment_id=$1 AND i.item_code ~ '^J205[23]'`,
            [s.draftId],
          );
          await admin.query("COMMIT");
        };

        await rewrite("not-a-cms-code");
        await svc.getAssessmentReview(ORG, s.draftId);
        expect(await sfvAnswers(s.draftId)).toEqual([]);

        await rewrite("2");
        await svc.getAssessmentReview(ORG, s.draftId);
        expect(await answerValues(s.draftId)).toMatchObject({ J2052A: "1", J2053A: "2" });
      });

      it("the completion locks its triggering draft: a racing sign that commits first is never written over", async () => {
        const s = await openSfv();
        const answersBefore = await sfvAnswers(s.draftId);
        const racer = new Client({ connectionString: DB_URL });
        await racer.connect();
        try {
          // A parallel sign holds the draft row (it locks FOR UPDATE, then flips the status).
          await racer.query("BEGIN");
          await racer.query("SELECT id FROM hope_assessment WHERE id=$1 FOR UPDATE", [s.draftId]);
          const completing = postSfv(s.adm, as(member.victim), s.draftId);
          await vi.waitFor(
            async () => {
              const parked = await q(
                `SELECT 1 FROM pg_stat_activity
                  WHERE wait_event_type = 'Lock' AND query ILIKE '%from "hope_assessment"%for update%'`,
                [],
              );
              expect(parked.length).toBeGreaterThan(0);
            },
            { timeout: 10_000, interval: 50 },
          );
          await racer.query("SET LOCAL session_replication_role = replica");
          await racer.query(
            "UPDATE hope_assessment SET status='signed', signed_at=now(), signed_by_membership_id=$2 WHERE id=$1",
            [s.draftId, member.victim],
          );
          await racer.query("COMMIT");

          expect((await completing).statusCode).toBe(201);
        } finally {
          await racer.query("ROLLBACK").catch(() => undefined);
          await racer.end();
        }
        expect((await sfvRow(s.sfvId))?.status).toBe("completed");
        // The draft was signed first, so the completion left its answers alone.
        expect(await sfvAnswers(s.draftId)).toEqual(answersBefore);
      });

      it("the signature audit rows carry the caller's address, user agent, actor kind and the stored resource id", async () => {
        const d = await signReadyDraft();
        const s = await openSfv();
        const reqFacts = { "user-agent": "cw-live-test/1.0" };
        const signRes = await app.inject({
          method: "POST",
          // The URL id in upper case: the audit row must still carry the STORED (lower-case) id.
          url: `/api/v1/hope/assessments/${d.id.toUpperCase()}/sign`,
          headers: { ...as(member.victim), ...reqFacts },
          remoteAddress: "203.0.113.7",
          payload: { ifVersion: d.version, attestationConfirmed: true },
        });
        expect(signRes.statusCode).toBe(200);
        const sfvRes = await app.inject({
          method: "POST",
          url: `/api/v1/admissions/${s.adm}/hope/sfv`,
          headers: { ...as(member.victim), ...reqFacts },
          remoteAddress: "203.0.113.7",
          payload: sfvBody(s.draftId),
        });
        expect(sfvRes.statusCode).toBe(201);

        const facts = (eventType: string) =>
          q<{
            actor_kind: string;
            source_ip: string | null;
            user_agent: string | null;
            correlation_id: string;
            resource_id: string;
          }>(
            "SELECT actor_kind::text, source_ip, user_agent, correlation_id, resource_id::text FROM audit_event WHERE event_type=$1",
            [eventType],
          );
        const [signAudit] = (await facts(SIGN_AUDIT)).filter((r) => r.resource_id === d.id);
        expect(signAudit).toMatchObject({
          actor_kind: "user",
          source_ip: "203.0.113.7",
          user_agent: "cw-live-test/1.0",
          // Always the server's own key for the row (never a client value): the signed record's id.
          correlation_id: `hope-signature:${d.id}`,
        });
        const sfvAudits = (await facts(SFV_AUDIT)).filter(
          (r) => r.resource_id === sfvRes.json().id,
        );
        expect(sfvAudits).toHaveLength(1);
        expect(sfvAudits[0]).toMatchObject({
          actor_kind: "user",
          source_ip: "203.0.113.7",
          user_agent: "cw-live-test/1.0",
        });
      });
    });

    describe("the review self-heal and the completion: lock order, no-op reviews, version bump", () => {
      /** A completed SFV on a draft whose derived J2052/J2053 answers are then gone (what a heal has to rewrite). */
      async function completedSfvWithoutAnswers() {
        const s = await openSfv();
        expect((await postSfv(s.adm, as(member.victim), s.draftId)).statusCode).toBe(201);
        await clearSfvAnswers(s.draftId);
        return s;
      }
      const answerValuesOf = async (assessmentId: string): Promise<Record<string, unknown>> =>
        Object.fromEntries((await sfvAnswers(assessmentId)).map((a) => [a.item_code, a.value]));
      const clearSfvAnswers = async (draftId: string): Promise<void> => {
        await admin.query(
          `DELETE FROM hope_assessment_answer a USING hope_spec_item i
            WHERE a.spec_item_id = i.id AND a.hope_assessment_id=$1 AND i.item_code ~ '^J205[23]'`,
          [draftId],
        );
      };
      /** The backend parked on a lock whose SQL is the SFV row `FOR UPDATE` (a second connection holds that row). */
      const parkedOnSfvRowLock = async (): Promise<number> => {
        let pid = 0;
        await vi.waitFor(
          async () => {
            const parked = await q<{ pid: number }>(
              `SELECT pid FROM pg_stat_activity
                WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
                  AND query ILIKE '%from "symptom_follow_up_visit"%for update%'`,
              [],
            );
            expect(parked.length).toBeGreaterThan(0);
            pid = parked[0]?.pid as number;
          },
          { timeout: 10_000, interval: 50 },
        );
        return pid;
      };
      /** Row-level lock modes a backend holds on the assessment / answer tables (a read holds only AccessShare). */
      const writeLocksHeldBy = (pid: number) =>
        q<{ relname: string; mode: string }>(
          `SELECT c.relname, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
            WHERE l.pid=$1 AND l.granted AND l.locktype='relation'
              AND l.mode IN ('RowShareLock','RowExclusiveLock') AND c.relname LIKE 'hope_assessment%'`,
          [pid],
        );
      const holdRows = async (...sqls: string[]): Promise<Client> => {
        const holder = new Client({ connectionString: DB_URL });
        await holder.connect();
        await holder.query("BEGIN");
        for (const sql of sqls) await holder.query(sql);
        return holder;
      };

      it("the self-heal takes the SFV row lock FIRST and holds no assessment or answer lock while it waits", async () => {
        const s = await completedSfvWithoutAnswers();
        const holder = await holdRows(
          `SELECT 1 FROM symptom_follow_up_visit WHERE id='${s.sfvId}' FOR UPDATE`,
        );
        try {
          const review = svc.getAssessmentReview(ORG, s.draftId);
          const pid = await parkedOnSfvRowLock();

          // The patch path takes the SFV row before any answer, then the assessment row last; the heal must
          // queue behind the SAME row first, never hold the assessment or an answer while it waits.
          expect(await writeLocksHeldBy(pid)).toEqual([]);
          await holder.query("ROLLBACK");
          await review;
        } finally {
          await holder.query("ROLLBACK").catch(() => undefined);
          await holder.end();
        }
        expect(Object.keys(await answerValuesOf(s.draftId))).toEqual(
          expect.arrayContaining(["J2052A", "J2053A", "J2053H"]),
        );
      });

      it("a review of a record that is no longer a draft takes no lock and writes nothing (judged by the statements it sends)", async () => {
        const s = await completedSfvWithoutAnswers();
        await admin.query("BEGIN");
        await admin.query("SET LOCAL session_replication_role = replica");
        await admin.query(
          "UPDATE hope_assessment SET status='signed', signed_at=now(), signed_by_membership_id=$2 WHERE id=$1",
          [s.draftId, member.victim],
        );
        await admin.query("COMMIT");

        const review = await statementsDuring((backend) =>
          backend.getAssessmentReview(ORG, s.draftId),
        );

        // Not vacuous: the review did read the record and its SFV.
        expect(review.sql.some((q) => q.includes('"hope_assessment"'))).toBe(true);
        expect(review.sql.filter((q) => /for update/i.test(q))).toEqual([]);
        expect(review.sql.filter((q) => /^\s*(insert|update|delete)\b/i.test(q))).toEqual([]);
        expect(await sfvAnswers(s.draftId)).toEqual([]);
      });

      it("a second review of an already-healed draft writes nothing (answers, version and audit rows unchanged)", async () => {
        const s = await completedSfvWithoutAnswers();
        await svc.getAssessmentReview(ORG, s.draftId); // heals
        const snapshot = async () => ({
          version: (await assessmentRow(s.draftId))?.version,
          answers: await q(
            `SELECT i.item_code, a.state, a.value::text AS value, a.updated_at::text AS updated_at
               FROM hope_assessment_answer a JOIN hope_spec_item i ON i.id = a.spec_item_id
              WHERE a.hope_assessment_id=$1 AND i.item_code ~ '^J205[23]' ORDER BY i.item_code`,
            [s.draftId],
          ),
          answerAudits: (
            await q<{ n: number }>(
              "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'hope_assessment_answer'",
              [],
            )
          )[0]?.n,
        });
        const healed = await snapshot();
        expect(healed.answers.length).toBeGreaterThan(0);

        await svc.getAssessmentReview(ORG, s.draftId);
        await svc.getAssessmentReview(ORG, s.draftId);

        expect(await snapshot()).toEqual(healed);
      });

      it("a heal or a completion that changes the draft's answers bumps its version; one that changes nothing does not", async () => {
        const s = await openSfv();
        const v0 = (await assessmentRow(s.draftId))?.version as number;
        expect((await postSfv(s.adm, as(member.victim), s.draftId)).statusCode).toBe(201);
        const v1 = (await assessmentRow(s.draftId))?.version as number;
        expect(v1).toBe(v0 + 1);

        await clearSfvAnswers(s.draftId);
        await svc.getAssessmentReview(ORG, s.draftId);
        const v2 = (await assessmentRow(s.draftId))?.version as number;
        expect(v2).toBe(v1 + 1);

        await svc.getAssessmentReview(ORG, s.draftId);
        expect((await assessmentRow(s.draftId))?.version).toBe(v2);
      });

      it("a signer who reviewed the draft before the completion wrote its answers loses with 409 and must review again", async () => {
        const s = await openSfv();
        const reviewedAt = (await assessmentRow(s.draftId))?.version as number;
        expect((await postSfv(s.adm, as(member.victim), s.draftId)).statusCode).toBe(201);

        const stale = await postSign(s.draftId, as(member.victim), {
          ifVersion: reviewedAt,
          attestationConfirmed: true,
        });
        expect(stale.statusCode).toBe(409);
        expect(stale.json().error.message).toMatch(/version is stale/);

        const fresh = await postSign(s.draftId, as(member.victim), {
          ifVersion: (await assessmentRow(s.draftId))?.version as number,
          attestationConfirmed: true,
        });
        // Past the version check, the draft is judged on its content: this fixture is not sign-ready, which is a
        // 422 validation refusal (not the 409 a stale version gets).
        expect(fresh.statusCode).toBe(422);
        expect(codeOf(fresh)).toBe("VALIDATION_FAILED");
      });
    });

    describe("signature audit forensics and canonical ids", () => {
      const auditFacts = (eventType: string, resourceId: string) =>
        q<{
          actor_user_id: string | null;
          actor_kind: string;
          user_agent: string | null;
          correlation_id: string;
          request_id: string | null;
        }>(
          `SELECT actor_user_id::text, actor_kind::text, user_agent, correlation_id, request_id
             FROM audit_event WHERE event_type=$1 AND resource_id=$2`,
          [eventType, resourceId],
        );

      it("the row names the signing session user and a SERVER-generated correlation id; the client's x-correlation-id is only a context hint", async () => {
        const d = await signReadyDraft();
        const res = await app.inject({
          method: "POST",
          url: `/api/v1/hope/assessments/${d.id}/sign`,
          headers: { ...as(member.victim), "x-correlation-id": "cw-live-corr-7f3a" },
          payload: { ifVersion: d.version, attestationConfirmed: true },
        });
        expect(res.statusCode).toBe(200);

        const [row] = await auditFacts(SIGN_AUDIT, d.id);

        expect(row?.actor_user_id).toBe(userOf[member.victim]);
        // The row is keyed on the server's own id; the client-chosen one rides in the context.
        expect(row?.correlation_id).toBe(`hope-signature:${d.id}`);
        expect(
          (
            await q<{ hint: string }>(
              "SELECT context->>'clientCorrelationId' AS hint FROM audit_event WHERE event_type=$1 AND resource_id=$2",
              [SIGN_AUDIT, d.id],
            )
          )[0]?.hint,
        ).toBe("cw-live-corr-7f3a");
        // The per-process request id stays in its own column, exactly as the read-audit rows fill it.
        expect(row?.request_id).toEqual(expect.stringMatching(/\S/));
      });

      it("the user agent is bounded to 256 characters and stripped of control characters", async () => {
        const d = await signReadyDraft();
        const long = await app.inject({
          method: "POST",
          url: `/api/v1/hope/assessments/${d.id}/sign`,
          headers: { ...as(member.victim), "user-agent": `ua-${"x".repeat(400)}` },
          payload: { ifVersion: d.version, attestationConfirmed: true },
        });
        expect(long.statusCode).toBe(200);
        const [bounded] = await auditFacts(SIGN_AUDIT, d.id);
        expect(bounded?.user_agent).toHaveLength(256);

        const s = await openSfv();
        const tabbed = await app.inject({
          method: "POST",
          url: `/api/v1/admissions/${s.adm}/hope/sfv`,
          headers: { ...as(member.victim), "user-agent": "\tcw\tagent\t" },
          payload: sfvBody(s.draftId),
        });
        expect(tabbed.statusCode).toBe(201);
        const [stripped] = await auditFacts(SFV_AUDIT, tabbed.json().id);
        expect(stripped?.user_agent).toBe("cwagent");
      });

      it("signing with the URL id in upper case announces the STORED id in the outbox event and its payload", async () => {
        const d = await signReadyDraft();
        const res = await postSign(d.id.toUpperCase(), as(member.victim), {
          ifVersion: d.version,
          attestationConfirmed: true,
        });
        expect(res.statusCode).toBe(200);

        const events = await q<{ aggregate_id: string; asserted: string }>(
          `SELECT aggregate_id::text, payload->>'assessmentId' AS asserted
             FROM outbox_event WHERE event_type='m10.hope.timepoint_signed' AND aggregate_id=$1`,
          [d.id],
        );

        expect(events).toEqual([{ aggregate_id: d.id, asserted: d.id }]);
      });

      it("a refused cross-admission completion leaves a server-side warn (ids only) and the same response as an unknown id", async () => {
        const victim = await openSfv();
        const own = await admitted();
        grantCaseload(member.attacker, patientOf[own] as string);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        let lines: string[];
        let foreign: Awaited<ReturnType<typeof postSfv>>;
        let bogus: Awaited<ReturnType<typeof postSfv>>;
        try {
          foreign = await postSfv(own, as(member.attacker), victim.draftId);
          bogus = await postSfv(own, as(member.attacker), BOGUS_TRIGGER);
          lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("no SFV"));
        } finally {
          warn.mockRestore();
        }

        expect(shapeOf(foreign)).toEqual(shapeOf(bogus));
        expect(shapeOf(foreign).code).toBe("M10_SFV_NO_TRIGGER");
        expect(lines).toHaveLength(2);
        const foreignLine = lines.find((l) => l.includes(victim.draftId)) as string;
        for (const id of [member.attacker, own, victim.draftId, ORG])
          expect(foreignLine).toContain(id);
        // Ids only: no patient, no body content.
        for (const line of lines) {
          expect(line).not.toContain(victim.patientId);
          expect(line).not.toContain("attestationConfirmed");
          expect(line).not.toContain("J2053");
        }
      });
    });

    describe("SFV completion against a triggering assessment with no frozen spec", () => {
      /** A draft the answer engine has not yet initialised (spec version + ISC unset), as a legacy row looks. */
      async function unfrozenSfv() {
        const s = await openSfv();
        await admin.query("BEGIN");
        await admin.query("SET LOCAL session_replication_role = replica");
        await admin.query(
          "UPDATE hope_assessment SET spec_version_id = NULL, isc = NULL WHERE id=$1",
          [s.draftId],
        );
        await admin.query("COMMIT");
        return s;
      }
      const j2053 = (over: Record<string, unknown>) => ({
        J: { J2053: { ...SFV_DATA.J.J2053, ...over } },
      });

      it("still judges J2053 values against the newest HA spec's options (an invalid one is a 422: no RFA-04 is inserted and the SFV stays open)", async () => {
        const s = await unfrozenSfv();
        const rfa04Before = await rfa04Count();

        const res = await postSfv(s.adm, as(member.victim), s.draftId, {
          data: j2053({ J2053A: "SECRET-FREE-TEXT" }),
        });

        expect(res.statusCode).toBe(422);
        expect(codeOf(res)).toBe("M10_SFV_COMPLETION_INCOMPLETE");
        expect(res.body).toContain("J2053A");
        expect(res.body).not.toContain("SECRET-FREE-TEXT");
        expect(await rfa04Count()).toBe(rfa04Before);
        expect(await sfvRow(s.sfvId)).toEqual({ status: "open", completing_assessment_id: null });
      });

      it.each([
        // Relative to the TRIGGERING ASSESSMENT's own target date (the date its spec is frozen by), not the server's clock.
        [
          "retired (its effective_to is before the assessment's target date)",
          (targetDay: string) => `effective_to = DATE '${targetDay}' - 1`,
        ],
        [
          "future-dated (its effective_from is after the assessment's target date)",
          (targetDay: string) => `effective_from = DATE '${targetDay}' + 1`,
        ],
      ])(
        "a spec version that is %s is never the one that judges the values: with none in force the completion is refused, no RFA-04 is inserted and the SFV stays open",
        async (_label, change) => {
          const s = await unfrozenSfv();
          const targetDay = (
            await q<{ d: string }>(
              "SELECT (target_date AT TIME ZONE 'UTC')::date::text AS d FROM hope_assessment WHERE id=$1",
              [s.draftId],
            )
          )[0]?.d as string;
          const original = (
            await q<{ effective_from: string; effective_to: string | null }>(
              "SELECT effective_from::text, effective_to::text FROM hope_spec_version ORDER BY effective_from LIMIT 1",
              [],
            )
          )[0];
          const rfa04Before = await rfa04Count();
          try {
            await admin.query(`UPDATE hope_spec_version SET ${change(targetDay)}`);

            // With no spec in force on that date there is nothing to judge the values against, and the completion is
            // REFUSED (a typed, PHI-free 422: a data fault an administrator fixes, not a server error) rather than
            // recorded unchecked: a retired / future version is never used in its place.
            const res = await postSfv(s.adm, as(member.victim), s.draftId, {
              data: j2053({ J2053A: "x" }),
            });

            expect(res.statusCode).toBe(422);
            expect(codeOf(res)).toBe("M10_SPEC_NOT_IN_FORCE");
            expect(res.body).not.toContain(targetDay);
            expect(await rfa04Count()).toBe(rfa04Before);
            expect(await sfvRow(s.sfvId)).toEqual({
              status: "open",
              completing_assessment_id: null,
            });
          } finally {
            await admin.query("UPDATE hope_spec_version SET effective_from=$1, effective_to=$2", [
              original?.effective_from,
              original?.effective_to,
            ]);
          }
        },
      );

      it("recordSfv reads the clock AFTER the SFV lock wait and the content guard, not before them", async () => {
        const s = await openSfv();
        const holder = new Client({ connectionString: DB_URL });
        await holder.connect();
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM symptom_follow_up_visit WHERE id=$1 FOR UPDATE", [
          s.sfvId,
        ]);
        const probe = createDbClient({ connectionString: appDbUrl, max: 1 });
        const clockReads: number[] = [];
        try {
          const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M10_OUTBOX_EVENTS]));
          const backend = createDbHopeBackend(
            probe.db,
            { publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m10" }) },
            () => {
              clockReads.push(Date.now());
              return new Date();
            },
          );
          const completing = backend.recordSfv(ORG, member.victim, s.adm, {
            triggeringAssessmentId: s.draftId,
            targetDate: new Date().toISOString(),
            authorDiscipline: "RN",
            data: SFV_DATA,
            attestationConfirmed: true,
          });
          // Wait until the completion is parked on the SFV row lock the holder keeps; never release it before then (a call that
          // never parked would fail the clock-order assertion below with a message about the clock).
          await awaitParked(
            async () =>
              (
                await admin.query(
                  `SELECT 1 FROM pg_stat_activity
                    WHERE datname = current_database() AND pid <> pg_backend_pid()
                      AND wait_event_type = 'Lock' AND query ILIKE '%"symptom_follow_up_visit"%'`,
                )
              ).rows.length > 0,
            "recordSfv on the symptom_follow_up_visit row",
          ).catch(async (error: unknown) => {
            await holder.query("ROLLBACK");
            await completing.catch(() => undefined); // let the call finish before the probe pool closes
            throw error;
          });
          const releasedAt = Date.now();
          await holder.query("ROLLBACK");
          await completing;

          expect(clockReads.length).toBeGreaterThan(0);
          expect(Math.min(...clockReads)).toBeGreaterThanOrEqual(releasedAt);
        } finally {
          await holder.end();
          await probe.close();
        }
      });

      it("completes with valid options, writing no answers onto a draft that has no spec to hold them", async () => {
        const s = await unfrozenSfv();

        const res = await postSfv(s.adm, as(member.victim), s.draftId, {
          data: j2053({ J2053A: "3", J2053B: "9" }),
        });

        expect(res.statusCode).toBe(201);
        expect((await sfvRow(s.sfvId))?.status).toBe("completed");
        expect(await sfvAnswers(s.draftId)).toEqual([]);
      });
    });

    describe("the attestation wording version", () => {
      const WORDING_OLD = "1999-01-01.0";

      it("a sign that names an older wording version is a 409 M10_ATTESTATION_STALE: the draft stays a draft with no sign audit row", async () => {
        const d = await signReadyDraft();
        const audits = await auditCount(SIGN_AUDIT);

        const res = await postSign(d.id, as(member.victim), {
          ifVersion: d.version,
          attestationConfirmed: true,
          attestationVersion: WORDING_OLD,
        });

        expect(res.statusCode).toBe(409);
        expect(codeOf(res)).toBe("M10_ATTESTATION_STALE");
        expect(res.json().error.message).toMatch(/reload/i);
        expect(await assessmentRow(d.id)).toEqual({ status: "draft", version: d.version });
        expect(await auditCount(SIGN_AUDIT)).toBe(audits);
      });

      it("a sign that names the current version succeeds; its audit row records the server's wording, the hash and that the client confirmed it", async () => {
        const d = await signReadyDraft();

        const res = await postSign(d.id, as(member.victim), {
          ifVersion: d.version,
          attestationConfirmed: true,
          attestationVersion: HOPE_ATTESTATION_VERSION,
        });

        expect(res.statusCode).toBe(200);
        const [event] = await auditsFor(SIGN_AUDIT, d.id);
        expect(event?.context).toMatchObject({
          serverCurrentAttestationVersion: HOPE_ATTESTATION_VERSION,
          serverCurrentAttestationStatementSha256: sha256Hex(HOPE_SIGN_ATTESTATION_STATEMENT),
          attestationVersionSupplied: true,
          suppliedAttestationVersion: HOPE_ATTESTATION_VERSION,
        });
        expect(event?.context.serverCurrentAttestationStatementSha256).toMatch(/^[0-9a-f]{64}$/);
      });

      it("a sign that names no version succeeds, and its audit row says the client did NOT confirm the wording", async () => {
        const d = await signReadyDraft();

        const res = await postSign(d.id, as(member.victim), {
          ifVersion: d.version,
          attestationConfirmed: true,
        });

        expect(res.statusCode).toBe(200);
        const [event] = await auditsFor(SIGN_AUDIT, d.id);
        expect(event?.context).toMatchObject({
          serverCurrentAttestationVersion: HOPE_ATTESTATION_VERSION,
          attestationVersionSupplied: false,
        });
        expect(event?.context).not.toHaveProperty("suppliedAttestationVersion");
      });

      it("an SFV completion that names an older wording is a 409, leaving the SFV open with no RFA-04", async () => {
        const s = await openSfv();
        const rfa04Before = await rfa04Count();

        const res = await postSfv(s.adm, as(member.victim), s.draftId, {
          attestationVersion: WORDING_OLD,
        });

        expect(res.statusCode).toBe(409);
        expect(codeOf(res)).toBe("M10_ATTESTATION_STALE");
        expect(await rfa04Count()).toBe(rfa04Before);
        expect(await sfvRow(s.sfvId)).toEqual({ status: "open", completing_assessment_id: null });
      });

      it("an SFV completion that names the current wording succeeds, hashes the SFV statement (not the sign one) and records the confirmation", async () => {
        const s = await openSfv();

        const res = await postSfv(s.adm, as(member.victim), s.draftId, {
          attestationVersion: HOPE_ATTESTATION_VERSION,
        });

        expect(res.statusCode).toBe(201);
        const [event] = await auditsFor(SFV_AUDIT, res.json().id);
        expect(event?.context).toMatchObject({
          serverCurrentAttestationVersion: HOPE_ATTESTATION_VERSION,
          serverCurrentAttestationStatementSha256: sha256Hex(HOPE_SFV_ATTESTATION_STATEMENT),
          attestationVersionSupplied: true,
          suppliedAttestationVersion: HOPE_ATTESTATION_VERSION,
        });
        expect(event?.context.serverCurrentAttestationStatementSha256).not.toBe(
          sha256Hex(HOPE_SIGN_ATTESTATION_STATEMENT),
        );
      });
    });

    describe("a real calendar date for the SFV completion", () => {
      it("a Feb 30 target date is a 422, never rolled over to Mar 2: no RFA-04 is inserted and the SFV stays open", async () => {
        const s = await openSfv();
        const rfa04Before = await rfa04Count();

        const res = await postSfv(s.adm, as(member.victim), s.draftId, {
          targetDate: "2026-02-30T00:00:00.000Z",
        });

        expect(res.statusCode).toBe(422);
        expect(res.body).not.toContain("2026-02-30");
        expect(await rfa04Count()).toBe(rfa04Before);
        expect(await sfvRow(s.sfvId)).toEqual({ status: "open", completing_assessment_id: null });
      });
    });

    describe("GET /hope/sfv filtered by triggeringAssessmentId", () => {
      const list = (query: string) =>
        app.inject({
          method: "GET",
          url: `/api/v1/hope/sfv${query}`,
          headers: as(member.orgwide),
        });

      it("returns only the SFV that assessment triggered, and an unknown id is an empty list, never a 404", async () => {
        const first = await openSfv();
        const second = await openSfv();

        const filtered = await list(`?triggeringAssessmentId=${first.draftId}`);
        const unknown = await list(`?triggeringAssessmentId=${BOGUS_TRIGGER}`);
        const unfiltered = await list("");

        expect(filtered.statusCode).toBe(200);
        expect(filtered.json().sfvs.map((x: { id: string }) => x.id)).toEqual([first.sfvId]);
        expect(unknown.statusCode).toBe(200);
        expect(unknown.json().sfvs).toEqual([]);
        // Not vacuous: without the filter both SFVs are there.
        const all = unfiltered.json().sfvs.map((x: { id: string }) => x.id);
        expect(all).toEqual(expect.arrayContaining([first.sfvId, second.sfvId]));
      });

      it("matches the uuid case-insensitively (uuid equality)", async () => {
        const only = await openSfv();

        const res = await list(`?triggeringAssessmentId=${only.draftId.toUpperCase()}`);

        expect(res.statusCode).toBe(200);
        expect(res.json().sfvs.map((x: { id: string }) => x.id)).toEqual([only.sfvId]);
      });

      it("a value that is not a uuid is a 422 validation error, not a database cast failure", async () => {
        const res = await list("?triggeringAssessmentId=not-a-uuid");

        expect(res.statusCode).toBe(422);
      });
    });

    describe("one lock order on every answer writer: SFV row, then the assessment row, then answers", () => {
      const parkedBackends = () =>
        q<{ pid: number; query: string }>(
          `SELECT pid, query FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`,
          [],
        );
      const parkedPid = async (): Promise<number> => {
        let pid = 0;
        await vi.waitFor(
          async () => {
            const parked = await parkedBackends();
            expect(parked.length).toBeGreaterThan(0);
            pid = parked[0]?.pid as number;
          },
          { timeout: 10_000, interval: 50 },
        );
        return pid;
      };
      /**
       * The WRITES a backend has already made to the assessment or answer tables: an INSERT/UPDATE/DELETE leaves a
       * RowExclusiveLock on the table (or its partition) until the transaction ends. (A `SELECT ... FOR UPDATE` leaves
       * RowShareLock on every partition, even while it waits, so it is not a write.)
       */
      const writeLocksOf = (pid: number) =>
        q<{ relname: string; mode: string }>(
          `SELECT c.relname, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
            WHERE l.pid=$1 AND l.granted AND l.locktype='relation'
              AND l.mode = 'RowExclusiveLock' AND c.relname LIKE 'hope_assessment%'`,
          [pid],
        );
      const hold = async (...sqls: string[]): Promise<Client> => {
        const holder = new Client({ connectionString: DB_URL });
        await holder.connect();
        await holder.query("BEGIN");
        for (const sql of sqls) await holder.query(sql);
        return holder;
      };
      /** A draft whose SFV is completed, whose chart-prefilled answer is missing, and whose J2052C row exists. */
      async function draftWherePrefillWrites() {
        const s = await openSfv();
        expect((await postSfv(s.adm, as(member.victim), s.draftId)).statusCode).toBe(201);
        // A chart-derived answer the draft lost: the next workspace open re-fills it, so prefill has something to write.
        await admin.query(
          `DELETE FROM hope_assessment_answer WHERE ctid IN (
             SELECT ctid FROM hope_assessment_answer WHERE hope_assessment_id=$1 AND source='patient_prefill' LIMIT 1)`,
          [s.draftId],
        );
        return s;
      }
      const j2052cItemId = async (draftId: string): Promise<string> =>
        (
          await q<{ id: string }>(
            `SELECT i.id FROM hope_spec_item i JOIN hope_assessment a ON a.spec_version_id = i.spec_version_id
              WHERE a.id=$1 AND i.item_code='J2052C'`,
            [draftId],
          )
        )[0]?.id as string;

      it("opening the workspace waits for the assessment lock BEFORE it writes any answer, so it cannot cross a heal, a patch or a sign", async () => {
        const s = await draftWherePrefillWrites();
        const j2052c = await j2052cItemId(s.draftId);
        // Stand-in for every assessment-first writer (the heal, a patch, a sign): it holds the assessment row and
        // then writes an answer row the workspace's applicability step also writes (the J2052C skip).
        const holder = await hold(
          `SELECT 1 FROM hope_assessment WHERE id='${s.draftId}' FOR UPDATE`,
        );
        let workspace: Promise<unknown> | undefined;
        try {
          workspace = svc.getAssessmentWorkspace(ORG, s.draftId);
          const pid = await parkedPid();

          // Parked on the assessment lock with NO answer written: nothing is held that the holder is about to want.
          expect(await writeLocksOf(pid)).toEqual([]);
          await holder.query(
            `UPDATE hope_assessment_answer SET updated_at = now() WHERE hope_assessment_id='${s.draftId}' AND spec_item_id='${j2052c}'`,
          );
          await holder.query("COMMIT");
          // No deadlock (40P01): the workspace resumes once the holder commits.
          await expect(workspace).resolves.toBeDefined();
        } finally {
          await holder.query("ROLLBACK").catch(() => undefined);
          await holder.end();
          await workspace?.catch(() => undefined);
        }
      });

      it("a patch of an HA draft takes the assessment lock right after the SFV lock, before it writes any answer", async () => {
        const s = await openSfv();
        const version = (await assessmentRow(s.draftId))?.version as number;
        const holder = await hold(
          `SELECT 1 FROM hope_assessment WHERE id='${s.draftId}' FOR UPDATE`,
        );
        let patch: Promise<unknown> | undefined;
        try {
          patch = svc.patchAssessmentAnswers(ORG, member.victim, s.draftId, {
            ifVersion: version,
            changes: [{ itemCode: "J2050B", action: "set", value: today() }],
          });
          const pid = await parkedPid();

          expect(await writeLocksOf(pid)).toEqual([]);
          await holder.query("COMMIT");
          await expect(patch).resolves.toBeDefined();
        } finally {
          await holder.query("ROLLBACK").catch(() => undefined);
          await holder.end();
          await patch?.catch(() => undefined);
        }
      });

      it("a patch re-judges the version on the LOCKED row: a writer that committed first makes it a 409", async () => {
        const s = await openSfv();
        const version = (await assessmentRow(s.draftId))?.version as number;
        const holder = await hold(
          `SELECT 1 FROM hope_assessment WHERE id='${s.draftId}' FOR UPDATE`,
        );
        let patch: Promise<unknown> | undefined;
        try {
          patch = svc.patchAssessmentAnswers(ORG, member.victim, s.draftId, {
            ifVersion: version,
            changes: [{ itemCode: "J2050B", action: "set", value: today() }],
          });
          await parkedPid();
          await holder.query("UPDATE hope_assessment SET version = version + 1 WHERE id=$1", [
            s.draftId,
          ]);
          await holder.query("COMMIT");

          await expect(patch).rejects.toMatchObject({ statusCode: 409 });
        } finally {
          await holder.query("ROLLBACK").catch(() => undefined);
          await holder.end();
          await patch?.catch(() => undefined);
        }
      });

      it("a review of a legacy draft with no frozen spec initialises it in its OWN transaction, so the SFV lock is still first", async () => {
        const s = await openSfv();
        await admin.query("BEGIN");
        await admin.query("SET LOCAL session_replication_role = replica");
        await admin.query(
          "UPDATE hope_assessment SET spec_version_id = NULL, isc = NULL WHERE id=$1",
          [s.draftId],
        );
        await admin.query("COMMIT");
        expect((await postSfv(s.adm, as(member.victim), s.draftId)).statusCode).toBe(201);
        const holder = await hold(
          `SELECT 1 FROM symptom_follow_up_visit WHERE id='${s.sfvId}' FOR UPDATE`,
        );
        let review: Promise<unknown> | undefined;
        try {
          review = svc.getAssessmentReview(ORG, s.draftId);
          const pid = await parkedPid();

          // Spec initialisation (an assessment UPDATE plus control answers) already COMMITTED; the heal waits on the
          // SFV row holding no assessment or answer lock (the old order held the assessment UPDATE's lock here).
          expect(await writeLocksOf(pid)).toEqual([]);
          await holder.query("ROLLBACK");
          await review;
        } finally {
          await holder.query("ROLLBACK").catch(() => undefined);
          await holder.end();
          await review?.catch(() => undefined);
        }
        const [row] = await q<{ spec_version_id: string | null }>(
          "SELECT spec_version_id FROM hope_assessment WHERE id=$1",
          [s.draftId],
        );
        expect(row?.spec_version_id).not.toBeNull();
        expect((await sfvAnswers(s.draftId)).map((a) => a.item_code)).toEqual(
          expect.arrayContaining(["J2052A"]),
        );
      });

      it("a review of an already-healed draft takes no write lock and writes nothing (judged by the statements it sends)", async () => {
        const s = await openSfv();
        expect((await postSfv(s.adm, as(member.victim), s.draftId)).statusCode).toBe(201);
        await svc.getAssessmentReview(ORG, s.draftId); // settles anything a first review would still write

        const review = await statementsDuring((backend) =>
          backend.getAssessmentReview(ORG, s.draftId),
        );

        expect(review.sql.some((query) => query.includes('"symptom_follow_up_visit"'))).toBe(true);
        expect(review.sql.filter((query) => /for update/i.test(query))).toEqual([]);
        expect(review.sql.filter((query) => /^\s*(insert|update|delete)\b/i.test(query))).toEqual(
          [],
        );
      });
    });

    describe("recording a timepoint needs a real calendar date", () => {
      const hopeRows = async (admissionId: string): Promise<number> =>
        (
          await q<{ n: number }>(
            "SELECT count(*)::int AS n FROM hope_assessment WHERE admission_id=$1",
            [admissionId],
          )
        )[0]?.n as number;

      it.each([
        ["an Apr 31 (a JS Date would roll it to May 1)", "2026-04-31T09:00:00.000Z"],
        ["a timestamp with no offset", `${today()}T09:00:00`],
      ])("refuses %s with a 422 and records nothing", async (_label, targetDate) => {
        const adm = await admitted();
        grantCaseload(member.victim, patientOf[adm] as string);

        const res = await app.inject({
          method: "POST",
          url: `/api/v1/admissions/${adm}/hope/timepoints`,
          headers: as(member.victim),
          payload: {
            rfaKind: "01_admission",
            targetDate,
            authorDiscipline: "RN",
            data: COMPREHENSIVE_DATA,
          },
        });

        expect(res.statusCode).toBe(422);
        expect(await hopeRows(adm)).toBe(0);
      });

      it("still records a draft for a valid offset timestamp", async () => {
        const adm = await admitted();
        grantCaseload(member.victim, patientOf[adm] as string);

        const res = await app.inject({
          method: "POST",
          url: `/api/v1/admissions/${adm}/hope/timepoints`,
          headers: as(member.victim),
          payload: {
            rfaKind: "01_admission",
            targetDate: new Date().toISOString().replace("Z", "+00:00"),
            authorDiscipline: "RN",
            data: COMPREHENSIVE_DATA,
          },
        });

        expect(res.statusCode).toBe(201);
        expect(await hopeRows(adm)).toBe(1);
      });
    });

    describe("the J2052B date a completion writes is never rewritten by a review", () => {
      const j2052b = async (assessmentId: string): Promise<unknown> =>
        (await sfvAnswers(assessmentId)).find((a) => a.item_code === "J2052B")?.value;
      const answerAudits = async (): Promise<number> =>
        (
          await q<{ n: number }>(
            "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'hope_assessment_answer'",
            [],
          )
        )[0]?.n as number;

      it("a western-offset evening completion keeps its calendar date through two reviews: same J2052B, same version, no audit rows", async () => {
        const s = await openSfv();
        // 8 pm on the clinic's day in UTC-7 is already the NEXT UTC day: the date written is `today`, the UTC date is not.
        const written = today();
        const res = await postSfv(s.adm, as(member.victim), s.draftId, {
          targetDate: `${written}T20:00:00-07:00`,
        });
        expect(res.statusCode).toBe(201);
        expect(await j2052b(s.draftId)).toBe(written);
        const version = (await assessmentRow(s.draftId))?.version;
        const audits = await answerAudits();

        await svc.getAssessmentReview(ORG, s.draftId);
        await svc.getAssessmentReview(ORG, s.draftId);

        expect(await j2052b(s.draftId)).toBe(written);
        expect((await assessmentRow(s.draftId))?.version).toBe(version);
        expect(await answerAudits()).toBe(audits);
      });

      it("a heal that has to rebuild a missing J2052B still derives it from the stored instant", async () => {
        const s = await openSfv();
        expect((await postSfv(s.adm, as(member.victim), s.draftId)).statusCode).toBe(201);
        await admin.query(
          `DELETE FROM hope_assessment_answer a USING hope_spec_item i
            WHERE a.spec_item_id = i.id AND a.hope_assessment_id=$1 AND i.item_code ~ '^J205[23]'`,
          [s.draftId],
        );

        await svc.getAssessmentReview(ORG, s.draftId);

        expect(await j2052b(s.draftId)).toBe(today());
      });

      /** The RFA-04 a completion inserted (the SFV row points at it). */
      const completingAssessmentOf = async (draftId: string): Promise<string> =>
        (
          await q<{ id: string }>(
            "SELECT completing_assessment_id AS id FROM symptom_follow_up_visit WHERE triggering_assessment_id = $1",
            [draftId],
          )
        )[0]?.id as string;
      const deleteSfvAnswers = (draftId: string) =>
        admin.query(
          `DELETE FROM hope_assessment_answer a USING hope_spec_item i
            WHERE a.spec_item_id = i.id AND a.hope_assessment_id=$1 AND i.item_code ~ '^J205[23]'`,
          [draftId],
        );

      it("a heal that rebuilds a deleted J2052B uses the AS-WRITTEN date of a western-offset completion, not the stored instant's UTC day", async () => {
        const s = await openSfv();
        const written = today();
        const targetDate = `${written}T20:00:00-07:00`;
        expect(
          (await postSfv(s.adm, as(member.victim), s.draftId, { targetDate })).statusCode,
        ).toBe(201);
        // What the applicability cascade does to J2052B on a still-draft admission when the trigger flips.
        await deleteSfvAnswers(s.draftId);
        // 8 pm at -07:00 is already the NEXT UTC day: the two readings of the same completion differ.
        const utcDay = new Date(targetDate).toISOString().slice(0, 10);
        expect(utcDay).not.toBe(written);

        await svc.getAssessmentReview(ORG, s.draftId);

        expect(await j2052b(s.draftId)).toBe(written);
      });

      it("a completion recorded before the date was kept (no server record in its data) still falls back to the stored instant's UTC day", async () => {
        const s = await openSfv();
        const written = today();
        const targetDate = `${written}T20:00:00-07:00`;
        expect(
          (await postSfv(s.adm, as(member.victim), s.draftId, { targetDate })).statusCode,
        ).toBe(201);
        await admin.query("UPDATE hope_assessment SET data = data - '_server' WHERE id = $1", [
          await completingAssessmentOf(s.draftId),
        ]);
        await deleteSfvAnswers(s.draftId);

        await svc.getAssessmentReview(ORG, s.draftId);

        expect(await j2052b(s.draftId)).toBe(new Date(targetDate).toISOString().slice(0, 10));
      });

      it("a client cannot choose the recorded date: its own `_server` key is overwritten by the server's", async () => {
        const s = await openSfv();
        const written = today();
        const res = await postSfv(s.adm, as(member.victim), s.draftId, {
          targetDate: `${written}T20:00:00-07:00`,
          data: { ...SFV_DATA, _server: { completedDate: "1999-01-01" } },
        });
        expect(res.statusCode).toBe(201);
        const stored = (
          await q<{ d: string }>(
            "SELECT data #>> '{_server,completedDate}' AS d FROM hope_assessment WHERE id = $1",
            [await completingAssessmentOf(s.draftId)],
          )
        )[0]?.d;
        expect(stored).toBe(written);
      });
    });
  },
);
