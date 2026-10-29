/**
 * Over the 800-line soft ceiling on purpose: every HOPE write route is exercised against one booted app and seeded org, so it stays together.
 *
 * S04 (clinical workflow audit 2026-10-28, CW-CL-03) -- HOPE admission / follow-up deadlines, the admin
 * override and the iQIES hand-off, proven on real Postgres through the FULL route stack.
 *
 * Mounts `registerHopeRoutes` over the REAL Drizzle backend (`createDbHopeBackend`, NOBYPASSRLS
 * `chartwarden_app`, the real catalog-validating outbox) behind the real M1 middleware + Authorization
 * Contract, with a header-auth shim, so the 403 / 422 / 409 below come from `LATE_OVERRIDE_GATE`,
 * `requireOverrideJustification` and the §4.4 capture gate, not from a stub. Proves:
 *   - on-time capture is not late and writes no override audit; a grace-span capture needs a typed reason;
 *   - an unauthorized override (`hope.timepoint.write` only) is a 403 on BOTH override-bearing routes and
 *     leaves no row and no audit; a client cannot smuggle the flag as a non-boolean, nor ride it on a route
 *     that has no override;
 *   - every timepoint write route (create, SFV, edit, answers, completion date, sign, correct, skip) 403s a
 *     read-only caller;
 *   - the SERVER clock decides: a stale in-window `targetDate` cannot beat a lapsed deadline, and the
 *     permitted override still needs a justification (422) and the late reason (400);
 *   - a justified override lands a critical, append-only `hope.late_deadline_override` audit event naming
 *     the actor membership, the reason and the record (the app role cannot UPDATE or DELETE it);
 *   - a failed / unacknowledged iQIES submission is never `accepted`: packaging, upload, a silent or
 *     unrecognised report and a mixed report all stay short of accepted, a rejection surfaces on the batch,
 *     the outbox and the compliance rate, and the results route needs `hope.submission.manage`.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m10:s04-override:live
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
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { importHopeSpec } from "../../../scripts/db/import-hope-spec";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { buildServer } from "../src/bootstrap/index";
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
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG = "11111111-1111-1111-1111-111111111111";
const ORG_USER = (n: number): string => `33333333-3333-3333-3333-${n.toString().padStart(12, "0")}`;
const READ_KEYS = ["hope.schedule.read", "hope.timepoint.read", "hope.sfv.read"];
const WRITE_KEYS = ["hope.timepoint.write", "hope.timepoint.sign", "hope.timepoint.correct"];
const OVERRIDE_KEY = "hope.admin.late_deadline_override";
const QUIET_DATA = { J: { J2051: { entries: [{ symptomCode: "pain", severity: "mild" }] } } };
const TRIGGER_DATA = { J: { J2051: { entries: [{ symptomCode: "pain", severity: "moderate" }] } } };
const SFV_DATA = {
  J: {
    J2053: Object.fromEntries(
      ["A", "B", "C", "D", "E", "F", "G", "H"].map((l) => [`J2053${l}`, "1"]),
    ),
  },
};
const WINDOW = {
  opensAt: "2026-06-10T00:00:00.000Z",
  closesAt: "2026-06-14T23:59:59.999Z",
  lateDeadlineAt: "2026-06-21T23:59:59.999Z",
};
const IN_WINDOW_DATE = "2026-06-12T12:00:00.000Z";
const CLOCK_ON_TIME = new Date("2026-06-13T12:00:00.000Z");
const CLOCK_GRACE = new Date("2026-06-17T12:00:00.000Z");
const CLOCK_EXPIRED = new Date("2026-06-30T12:00:00.000Z");
const JUSTIFICATION = "EHR outage during the window; approved by the compliance lead";
const OVERRIDE_AUDIT = "hope.late_deadline_override";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  // x-test-user is the MEMBERSHIP id (actorOf reads it); the session user id is the distinct Better Auth id.
  const uid = request.headers["x-test-uid"];
  request.context.userId = typeof uid === "string" ? uid : user;
  request.context.attributes.membershipId = user;
  request.context.organizationId = ORG;
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.providerEntityIds = [];
}

describe.skipIf(!DB_URL)("S04 HOPE deadline override + iQIES hand-off — LIVE Postgres", () => {
  let admin: Client;
  let appClient: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbHopeBackend>;
  let app: FastifyInstance;
  let liveNow = CLOCK_ON_TIME;
  let provider = "";
  let location = "";
  let seq = 0;
  const patientOf: Record<string, string> = {};
  const member = { rn: "", admin: "", viewer: "", compliance: "" };
  const userOf: Record<string, string> = {};
  const as = (m: string, roles = "rn") => ({
    "x-test-user": m,
    "x-test-uid": userOf[m] as string,
    "x-test-roles": roles,
  });
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
  async function newMember(n: number): Promise<string> {
    const userId = ORG_USER(n);
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [userId, `s04-${n}@x.test`]);
    const m = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userId, ORG],
      )
    ).rows[0].id as string;
    userOf[m] = userId;
    return m;
  }

  /** A real active admission (M6 reader resolves it) with its own patient. */
  async function admitted(): Promise<string> {
    seq += 1;
    const adm = uuid("77000000", seq);
    const patientId = `44444444-4444-4444-8444-${adm.slice(-12)}`;
    patientOf[adm] = patientId;
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
    return adm;
  }
  async function seedSchedule(adm: string, rfaKind = "01_admission"): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO hope_timepoint_schedule (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, rfa_kind, window_opens_at, window_closes_at, late_deadline_at, alert_cadence, generated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}'::jsonb,'auto_admission') RETURNING id`,
        [
          ORG,
          provider,
          location,
          patientOf[adm],
          adm,
          rfaKind,
          WINDOW.opensAt,
          WINDOW.closesAt,
          WINDOW.lateDeadlineAt,
        ],
      )
    ).rows[0].id as string;
  }
  /** An admission with an open 01_admission window. */
  async function admissionWithWindow(): Promise<string> {
    const adm = await admitted();
    await seedSchedule(adm);
    return adm;
  }

  const timepointBody = (over: Record<string, unknown> = {}) => ({
    rfaKind: "01_admission",
    targetDate: IN_WINDOW_DATE,
    authorDiscipline: "RN",
    data: QUIET_DATA,
    ...over,
  });
  const postTimepoint = (
    adm: string,
    headers: Record<string, string>,
    over: Record<string, unknown> = {},
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/admissions/${adm}/hope/timepoints`,
      headers,
      payload: timepointBody(over),
    });
  const codeOf = (res: { json(): { error?: { code?: string } } }) => res.json().error?.code;
  const countRows = async (table: string, adm: string): Promise<number> =>
    (await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE admission_id=$1`, [adm]))
      .rows[0].n as number;
  const overrideAudits = async (): Promise<
    { severity: string; resource_id: string; context: Record<string, unknown> }[]
  > =>
    (
      await admin.query(
        "SELECT severity, resource_id, context FROM audit_event WHERE event_type=$1",
        [OVERRIDE_AUDIT],
      )
    ).rows;
  const overrideAuditsFor = async (id: string) =>
    (await overrideAudits()).filter((a) => a.resource_id === id);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await importHopeSpec({ databaseUrl: DB_URL });
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'s04-seed@x.test')`, [ORG_USER(1)]);
    member.rn = await newMember(2);
    member.admin = await newMember(3);
    member.viewer = await newMember(4);
    member.compliance = await newMember(5);
    provider = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end,
                                      addresses, iqies_facility_id)
         VALUES ($1,'CCN-S04','S04','NPI-S04','enc','12-31',
                 '[{"line1":"1 St","city":"Town","state":"OR","postalCode":"97000"}]'::jsonb,'FACS04') RETURNING id`,
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
    handle = createDbClient({ connectionString: appUrl });
    appClient = new Client({ connectionString: appUrl });
    await appClient.connect();
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M10_OUTBOX_EVENTS]));
    const outbox: HopeWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m10" }),
    };
    svc = createDbHopeBackend(handle.db, outbox, () => liveNow);
  }, 120_000);

  afterAll(async () => {
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    await app?.close();
    await appClient?.end();
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    liveNow = CLOCK_ON_TIME;
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    __resetSeamsForTest();
    registerSeam(
      "AdmissionStatusReader",
      createAdmissionStatusReader(createDrizzleAdmissionReaderStore(handle.db)),
    );
    registerPatientSeams({ db: handle.db });
    const grant = (userId: string, permissionKeys: string[]) => ({
      orgId: ORG,
      userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
    });
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        grant(userOf[member.rn] as string, [...READ_KEYS, ...WRITE_KEYS, "hope.schedule.skip"]),
        grant(userOf[member.admin] as string, [...READ_KEYS, ...WRITE_KEYS, OVERRIDE_KEY]),
        grant(userOf[member.viewer] as string, READ_KEYS),
        grant(userOf[member.compliance] as string, [
          "hope.submission.read",
          "hope.submission.manage",
        ]),
      ]).store,
    );
    const registry = createPredicateRegistry();
    for (const [name, fn] of Object.entries(
      buildHopeAbacPredicates({
        resolver: svc,
        isInCaseload: async () => true,
        resolveAdmissionPatient: async (_o, id) =>
          patientOf[id] ? { patientId: patientOf[id] as string } : null,
      }),
    ))
      registry.register(name, fn);
    registerAbacRegistry(registry);
    await app?.close();
    app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    registerHopeRoutes(app, { service: svc, caseloadPatientIds: async () => [] });
    await app.ready();
  });

  describe("on-time and late capture", () => {
    it("an on-time capture is not late and writes no override audit", async () => {
      const adm = await admissionWithWindow();
      liveNow = CLOCK_ON_TIME;
      const res = await postTimepoint(adm, as(member.rn));
      expect(res.statusCode).toBe(201);
      const row = res.json<{ id: string; wasLate: boolean }>();
      expect(row.wasLate).toBe(false);
      expect(await overrideAuditsFor(row.id)).toHaveLength(0);
    });

    it("a grace-span capture needs a typed late reason, is stored late, and still needs no override", async () => {
      const adm = await admissionWithWindow();
      liveNow = CLOCK_GRACE;
      const missing = await postTimepoint(adm, as(member.rn));
      expect(missing.statusCode).toBe(400);
      expect(codeOf(missing)).toBe("M10_LATE_REASON_REQUIRED");
      expect(await countRows("hope_assessment", adm)).toBe(0);
      const ok = await postTimepoint(adm, as(member.rn), {
        lateCompletionReasonCode: "hospitalization",
      });
      expect(ok.statusCode).toBe(201);
      const row = ok.json<{ id: string; wasLate: boolean }>();
      expect(row.wasLate).toBe(true);
      expect(await overrideAuditsFor(row.id)).toHaveLength(0);
    });
  });

  describe("unauthorized override", () => {
    it("a hope.timepoint.write holder cannot self-declare adminOverride past the deadline (403, nothing written)", async () => {
      const adm = await admissionWithWindow();
      liveNow = CLOCK_EXPIRED;
      const before = (await overrideAudits()).length;
      const res = await postTimepoint(adm, as(member.rn), {
        adminOverride: true,
        adminOverrideJustification: JUSTIFICATION,
        lateCompletionReasonCode: "admin_override",
      });
      expect(res.statusCode).toBe(403);
      expect(await countRows("hope_assessment", adm)).toBe(0);
      expect((await overrideAudits()).length).toBe(before);
    });

    it("without the flag the same late write is a 409 M10_TIMEPOINT_EXPIRED", async () => {
      const adm = await admissionWithWindow();
      liveNow = CLOCK_EXPIRED;
      const res = await postTimepoint(adm, as(member.rn), { lateCompletionReasonCode: "pto" });
      expect(res.statusCode).toBe(409);
      expect(codeOf(res)).toBe("M10_TIMEPOINT_EXPIRED");
      expect(await countRows("hope_assessment", adm)).toBe(0);
    });

    it("the SFV route has the same gate: an RN's adminOverride is a 403 and the SFV stays open", async () => {
      const adm = await admissionWithWindow();
      const draft = await svc.recordTimepoint(ORG, member.rn, adm, {
        rfaKind: "01_admission",
        targetDate: IN_WINDOW_DATE,
        authorDiscipline: "RN",
        data: TRIGGER_DATA,
      });
      await patchTrigger(draft.id);
      await admin.query(
        `UPDATE symptom_follow_up_visit SET due_at='2026-05-01T00:00:00Z' WHERE triggering_assessment_id=$1`,
        [draft.id],
      );
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/admissions/${adm}/hope/sfv`,
        headers: as(member.rn),
        payload: {
          triggeringAssessmentId: draft.id,
          targetDate: new Date().toISOString(),
          authorDiscipline: "RN",
          data: SFV_DATA,
          adminOverride: true,
          adminOverrideJustification: JUSTIFICATION,
        },
      });
      expect(res.statusCode).toBe(403);
      expect(await sfvStatus(draft.id)).toBe("open");
    });

    it("a non-boolean adminOverride (string or number) is a 403 for a non-holder, never coerced into the override", async () => {
      const adm = await admissionWithWindow();
      liveNow = CLOCK_EXPIRED;
      for (const flag of ["true", 1, "yes"]) {
        const res = await postTimepoint(adm, as(member.rn), {
          adminOverride: flag,
          adminOverrideJustification: JUSTIFICATION,
          lateCompletionReasonCode: "admin_override",
        });
        // Real defect fixed in hope-routes.ts: parse() coerces "true"/1 to true AFTER the gate; the gate now reads the raw value.
        expect(res.statusCode).toBe(403);
      }
      expect(await countRows("hope_assessment", adm)).toBe(0);
    });

    it("the flag rides no other write route: an edit carrying adminOverride changes nothing and audits nothing", async () => {
      const adm = await admissionWithWindow();
      const draft = await svc.recordTimepoint(ORG, member.rn, adm, {
        rfaKind: "01_admission",
        targetDate: IN_WINDOW_DATE,
        authorDiscipline: "RN",
        data: QUIET_DATA,
      });
      const before = (await overrideAudits()).length;
      await app.inject({
        method: "PUT",
        url: `/api/v1/hope/assessments/${draft.id}`,
        headers: as(member.rn),
        payload: {
          data: QUIET_DATA,
          adminOverride: true,
          adminOverrideJustification: JUSTIFICATION,
        },
      });
      expect((await overrideAudits()).length).toBe(before);
    });

    it("every timepoint write route refuses a read-only caller (403) and writes nothing", async () => {
      const adm = await admissionWithWindow();
      const draft = await svc.recordTimepoint(ORG, member.rn, adm, {
        rfaKind: "01_admission",
        targetDate: IN_WINDOW_DATE,
        authorDiscipline: "RN",
        data: QUIET_DATA,
      });
      const schedule = (
        await admin.query("SELECT id FROM hope_timepoint_schedule WHERE admission_id=$1", [adm])
      ).rows[0].id as string;
      const A = `/api/v1/hope/assessments/${draft.id}`;
      const attempts: [string, string, object][] = [
        ["POST", `/api/v1/admissions/${adm}/hope/timepoints`, timepointBody()],
        [
          "POST",
          `/api/v1/admissions/${adm}/hope/sfv`,
          {
            triggeringAssessmentId: draft.id,
            targetDate: IN_WINDOW_DATE,
            authorDiscipline: "RN",
            data: SFV_DATA,
          },
        ],
        ["PUT", A, { data: QUIET_DATA }],
        [
          "PATCH",
          `${A}/answers`,
          { ifVersion: 1, changes: [{ itemCode: "J2050A", action: "set", value: "1" }] },
        ],
        ["PATCH", `${A}/huv/completion-date`, { completionDate: "2026-06-12" }],
        ["POST", `${A}/sign`, {}],
        [
          "POST",
          `${A}/correct`,
          {
            correctionReason: "typo in the pain entry",
            ifVersion: 1,
            targetDate: IN_WINDOW_DATE,
            authorDiscipline: "RN",
            data: QUIET_DATA,
          },
        ],
        ["POST", `${A}/inactivations`, { reason: "entered on the wrong patient chart" }],
        ["POST", `/api/v1/hope/schedules/${schedule}/skip`, { reasonCode: "patient_declined" }],
      ];
      for (const [method, url, payload] of attempts) {
        const res = await app.inject({
          method: method as "POST",
          url,
          headers: as(member.viewer),
          payload,
        });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
      const { rows } = await admin.query(
        "SELECT status, version FROM hope_assessment WHERE id=$1",
        [draft.id],
      );
      expect(rows[0]).toMatchObject({ status: "draft" });
      expect(
        (await admin.query("SELECT status FROM hope_timepoint_schedule WHERE id=$1", [schedule]))
          .rows[0].status,
      ).toBe("open");
      expect(await countRows("hope_assessment", adm)).toBe(1);
    });
  });

  describe("server clock is authoritative", () => {
    it("a late filer cannot send an in-window targetDate and be recorded on time (409)", async () => {
      const adm = await admissionWithWindow();
      liveNow = CLOCK_EXPIRED;
      const res = await postTimepoint(adm, as(member.rn), { targetDate: IN_WINDOW_DATE });
      expect(res.statusCode).toBe(409);
      expect(await countRows("hope_assessment", adm)).toBe(0);
    });

    it("a stale in-window targetDate in the grace span cannot yield was_late=false", async () => {
      const adm = await admissionWithWindow();
      liveNow = CLOCK_GRACE;
      const res = await postTimepoint(adm, as(member.rn), { lateCompletionReasonCode: "pto" });
      expect(res.statusCode).toBe(201);
      expect(res.json<{ wasLate: boolean }>().wasLate).toBe(true);
    });

    it("a client-supplied clock header or body field cannot move the server's judgement", async () => {
      const adm = await admissionWithWindow();
      liveNow = CLOCK_EXPIRED;
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/admissions/${adm}/hope/timepoints`,
        headers: {
          ...as(member.rn),
          date: CLOCK_ON_TIME.toUTCString(),
          "x-now": CLOCK_ON_TIME.toISOString(),
        },
        payload: timepointBody({ now: CLOCK_ON_TIME.toISOString(), wasLate: false, late: false }),
      });
      expect(res.statusCode).toBe(409);
      expect(await countRows("hope_assessment", adm)).toBe(0);
    });
  });

  describe("justified override", () => {
    it("the permitted admin without a justification is a 422, and nothing is written", async () => {
      const adm = await admissionWithWindow();
      liveNow = CLOCK_EXPIRED;
      const res = await postTimepoint(adm, as(member.admin), {
        adminOverride: true,
        lateCompletionReasonCode: "admin_override",
      });
      expect(res.statusCode).toBe(422);
      expect(await countRows("hope_assessment", adm)).toBe(0);
    });

    it("a too-short justification is refused", async () => {
      const adm = await admissionWithWindow();
      liveNow = CLOCK_EXPIRED;
      const res = await postTimepoint(adm, as(member.admin), {
        adminOverride: true,
        adminOverrideJustification: "because",
        lateCompletionReasonCode: "admin_override",
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(await countRows("hope_assessment", adm)).toBe(0);
    });

    it("an override still demands the typed late reason (400)", async () => {
      const adm = await admissionWithWindow();
      liveNow = CLOCK_EXPIRED;
      const res = await postTimepoint(adm, as(member.admin), {
        adminOverride: true,
        adminOverrideJustification: JUSTIFICATION,
      });
      expect(res.statusCode).toBe(400);
      expect(codeOf(res)).toBe("M10_LATE_REASON_REQUIRED");
    });

    it("a justified override past the deadline is stored late and audited critical, attributed and append-only", async () => {
      const adm = await admissionWithWindow();
      liveNow = CLOCK_EXPIRED;
      const res = await postTimepoint(adm, as(member.admin), {
        adminOverride: true,
        adminOverrideJustification: JUSTIFICATION,
        lateCompletionReasonCode: "admin_override",
      });
      expect(res.statusCode).toBe(201);
      const row = res.json<{ id: string; wasLate: boolean }>();
      expect(row.wasLate).toBe(true);
      const audits = await overrideAuditsFor(row.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.severity).toBe("critical");
      expect(audits[0]?.context).toMatchObject({
        justification: JUSTIFICATION,
        byMembershipId: member.admin,
        rfaKind: "01_admission",
      });
      // The app role can only append: it can neither rewrite the reason nor delete the event.
      await expect(
        appClient.query("UPDATE audit_event SET context='{}'::jsonb WHERE event_type=$1", [
          OVERRIDE_AUDIT,
        ]),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        appClient.query("DELETE FROM audit_event WHERE event_type=$1", [OVERRIDE_AUDIT]),
      ).rejects.toThrow(/permission denied/i);
      expect(await overrideAuditsFor(row.id)).toHaveLength(1);
    });

    it("an admin who does not need the override leaves no override audit (it records only a lifted cutoff)", async () => {
      const adm = await admissionWithWindow();
      liveNow = CLOCK_ON_TIME;
      const res = await postTimepoint(adm, as(member.admin), {
        adminOverride: true,
        adminOverrideJustification: JUSTIFICATION,
      });
      expect(res.statusCode).toBe(201);
      expect(await overrideAuditsFor(res.json<{ id: string }>().id)).toHaveLength(0);
    });

    it("a past-due SFV: an RN is refused (409), the admin with a justification completes it and it is audited", async () => {
      const adm = await admissionWithWindow();
      const draft = await svc.recordTimepoint(ORG, member.rn, adm, {
        rfaKind: "01_admission",
        targetDate: IN_WINDOW_DATE,
        authorDiscipline: "RN",
        data: TRIGGER_DATA,
      });
      await patchTrigger(draft.id);
      await admin.query(
        `UPDATE symptom_follow_up_visit SET due_at='2026-05-01T00:00:00Z' WHERE triggering_assessment_id=$1`,
        [draft.id],
      );
      const sfvBody = (over: object = {}) => ({
        triggeringAssessmentId: draft.id,
        targetDate: IN_WINDOW_DATE,
        authorDiscipline: "RN",
        data: SFV_DATA,
        ...over,
      });
      const post = (headers: Record<string, string>, over: object = {}) =>
        app.inject({
          method: "POST",
          url: `/api/v1/admissions/${adm}/hope/sfv`,
          headers,
          payload: sfvBody(over),
        });
      const refused = await post(as(member.rn));
      expect(refused.statusCode).toBe(409);
      expect(codeOf(refused)).toBe("M10_SFV_PAST_DUE");
      expect(await sfvStatus(draft.id)).toBe("open");
      const noReason = await post(as(member.admin), { adminOverride: true });
      expect(noReason.statusCode).toBe(422);
      expect(await sfvStatus(draft.id)).toBe("open");
      const ok = await post(as(member.admin), {
        adminOverride: true,
        adminOverrideJustification: JUSTIFICATION,
      });
      expect(ok.statusCode).toBe(201);
      expect(await sfvStatus(draft.id)).toBe("completed");
      const audits = await overrideAuditsFor(ok.json<{ id: string }>().id);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.severity).toBe("critical");
      expect(audits[0]?.context).toMatchObject({
        justification: JUSTIFICATION,
        byMembershipId: member.admin,
      });
    });
  });

  describe("failed iQIES submission / reconciliation", () => {
    const pkgB64 = Buffer.from("PK-fake-zip-bytes").toString("base64");
    async function signedAssessment(): Promise<string> {
      seq += 1;
      const id = uuid("90000000", seq);
      await admin.query(
        `INSERT INTO hope_assessment (id, organization_id, provider_entity_id, location_id, patient_id,
           admission_id, rfa_kind, status, data, target_date, signed_at, created_by_membership_id,
           signed_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6,'01_admission','signed','{}'::jsonb,'2026-06-01',now(),$7,$7)`,
        [id, ORG, provider, location, uuid("91000000", seq), uuid("92000000", seq), member.rn],
      );
      return id;
    }
    async function batch(status: string, assessments: string[]): Promise<string> {
      seq += 1;
      const id = uuid("93000000", seq);
      await admin.query(
        `INSERT INTO hope_submission (id, organization_id, provider_entity_id, submission_period, status,
           package_filename, package_sha256, item_count, acceptance_report)
         VALUES ($1,$2,$3,'2026-06',$4,'batch.zip',$5,$6,$7::jsonb)`,
        [
          id,
          ORG,
          provider,
          status,
          "a".repeat(64),
          assessments.length,
          JSON.stringify({ packageContentBase64: pkgB64 }),
        ],
      );
      for (const a of assessments)
        await admin.query(
          `INSERT INTO hope_submission_item (organization_id, hope_submission_id, hope_assessment_id) VALUES ($1,$2,$3)`,
          [ORG, id, a],
        );
      return id;
    }
    const status = async (id: string) =>
      (await admin.query("SELECT status FROM hope_submission WHERE id=$1", [id])).rows[0]
        .status as string;
    const postResults = (id: string, headers: Record<string, string>, results: object[]) =>
      app.inject({
        method: "POST",
        url: `/api/v1/hope/submissions/${id}/results`,
        headers,
        payload: { reportReference: "FVR-S04", results },
      });

    it("packaging and upload alone never reach accepted (no external acknowledgment yet)", async () => {
      const a = await signedAssessment();
      const b = await batch("exported", [a]);
      const up = await app.inject({
        method: "POST",
        url: `/api/v1/hope/submissions/${b}/mark-uploaded`,
        headers: as(member.compliance, "compliance_officer"),
        payload: {},
      });
      expect(up.statusCode).toBe(200);
      expect(await status(b)).toBe("submitted_pending_result");
      const packaged = await batch("packaged", [await signedAssessment()]);
      expect(await status(packaged)).toBe("packaged");
    });

    it("a rejection is surfaced on the batch, the findings and the outbox, and is never labeled accepted", async () => {
      const a = await signedAssessment();
      const b = await batch("submitted_pending_result", [a]);
      const res = await postResults(b, as(member.compliance, "compliance_officer"), [
        { assessmentId: a, status: "rejected", code: "-3010", message: "bad item" },
      ]);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "rejected", rejectedCount: 1, acceptedCount: 0 });
      expect(await status(b)).toBe("rejected");
      const detail = await svc.getSubmission(ORG, b);
      expect(detail.items[0]).toMatchObject({ status: "rejected", resolution: "needs_correction" });
      expect(detail.findings).toEqual([
        expect.objectContaining({ severity: "error", code: "-3010", assessmentId: a }),
      ]);
      const { rows } = await admin.query(
        "SELECT event_type FROM outbox_event WHERE payload->>'submissionId'=$1 ORDER BY event_type",
        [b],
      );
      expect(rows.map((r) => r.event_type)).toContain("m10.hope.submission_rejected");
      // The failed batch is counted as a non-acceptance on the compliance posture.
      const dash = await svc.complianceDashboard(ORG, provider);
      expect(dash.submissionAcceptanceCounts.accepted).toBe(0);
      expect(dash.submissionAcceptanceCounts.total).toBeGreaterThan(0);
    });

    it("an unrecognised or empty report row leaves the batch pending: never guessed accepted", async () => {
      const a = await signedAssessment();
      const b = await batch("submitted_pending_result", [a]);
      const res = await postResults(b, as(member.compliance, "compliance_officer"), [
        { assessmentId: a, status: "received, pending review" },
      ]);
      expect(res.statusCode).toBe(200);
      expect(await status(b)).toBe("submitted_pending_result");
      const silent = await postResults(b, as(member.compliance, "compliance_officer"), []);
      expect(silent.statusCode).toBeLessThan(500);
      expect(await status(b)).not.toBe("accepted");
    });

    it("one acknowledged item does not accept a batch whose other item is rejected or unacknowledged", async () => {
      const [a1, a2, a3] = [
        await signedAssessment(),
        await signedAssessment(),
        await signedAssessment(),
      ];
      const mixed = await batch("submitted_pending_result", [a1, a2]);
      await postResults(mixed, as(member.compliance, "compliance_officer"), [
        { assessmentId: a1, status: "accepted" },
        { assessmentId: a2, status: "rejected", code: "-1" },
      ]);
      expect(await status(mixed)).toBe("partially_accepted");
      const partial = await batch("submitted_pending_result", [a3, await signedAssessment()]);
      await postResults(partial, as(member.compliance, "compliance_officer"), [
        { assessmentId: a3, status: "accepted" },
      ]);
      expect(await status(partial)).toBe("submitted_pending_result");
    });

    it("a result for a batch never handed to CMS is refused (409/422), and the route needs hope.submission.manage", async () => {
      const a = await signedAssessment();
      const never = await batch("packaged", [a]);
      const refused = await postResults(never, as(member.compliance, "compliance_officer"), [
        { assessmentId: a, status: "accepted" },
      ]);
      expect(codeOf(refused)).toBe("M10_SUBMISSION_RESULT_NOT_UPLOADED");
      expect(await status(never)).toBe("packaged");
      const pending = await batch("submitted_pending_result", [await signedAssessment()]);
      const denied = await postResults(pending, as(member.rn), [{ status: "accepted" }]);
      expect(denied.statusCode).toBe(403);
      expect(await status(pending)).toBe("submitted_pending_result");
    });

    it("a rejected batch is only re-queued, never flipped to accepted; a settled verdict cannot be reversed by a later report", async () => {
      const a = await signedAssessment();
      const b = await batch("submitted_pending_result", [a]);
      await postResults(b, as(member.compliance, "compliance_officer"), [
        { assessmentId: a, status: "rejected", code: "-9" },
      ]);
      const retry = await app.inject({
        method: "POST",
        url: `/api/v1/hope/submissions/${b}/retry`,
        headers: as(member.compliance, "compliance_officer"),
      });
      expect(retry.statusCode).toBeLessThan(300);
      expect(await status(b)).toBe("queued");
      const settled = await signedAssessment();
      const sb = await batch("submitted_pending_result", [settled]);
      await postResults(sb, as(member.compliance, "compliance_officer"), [
        { assessmentId: settled, status: "rejected", code: "-2" },
      ]);
      await postResults(sb, as(member.compliance, "compliance_officer"), [
        { assessmentId: settled, status: "accepted" },
      ]);
      expect(await status(sb)).toBe("rejected");
    });
  });

  /** Patch the J2050/J2051 answers that open the SFV obligation (mirrors m10-hope-write.live). */
  async function patchTrigger(id: string): Promise<void> {
    const ws = await svc.getAssessmentWorkspace(ORG, id);
    await svc.patchAssessmentAnswers(ORG, member.rn, id, {
      ifVersion: ws.assessment.version,
      changes: [
        { itemCode: "J2050A", action: "set", value: "1" },
        { itemCode: "J2050B", action: "set", value: IN_WINDOW_DATE.slice(0, 10) },
        { itemCode: "J2051A", action: "set", value: "2" },
      ],
    });
  }
  async function sfvStatus(triggeringAssessmentId: string): Promise<string> {
    return (
      await admin.query(
        "SELECT status FROM symptom_follow_up_visit WHERE triggering_assessment_id=$1",
        [triggeringAssessmentId],
      )
    ).rows[0].status as string;
  }
});
