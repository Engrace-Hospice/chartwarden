/**
 * CW-AC-46 — a HOPE record is signed only by a clinician whose professional licence is active, on the signing day, in the
 * discipline the record is attributed to. Proven on real Postgres as the NOBYPASSRLS `chartwarden_app` role, over the REAL
 * M17 credential store (`membership_credential` through `registerCredentialSeam`, exactly what boot registers) and the REAL
 * catalog-validating outbox publisher (never `NOOP_OUTBOX`):
 *   - a valid licence signs (the signed row, the signature audit and the `m10.hope.timepoint_signed` outbox row land);
 *   - a missing, expired (yesterday), suspended, revoked and not-yet-effective licence are each refused 403
 *     `M10_SIGNER_LICENCE_NOT_ACTIVE`; a licence held in another discipline only is `..._WRONG_DISCIPLINE`; each leaves the
 *     draft untouched and exactly one `m10.signature.licence_refused` audit row naming the reason, the required discipline and
 *     the kinds held (ids and enums only);
 *   - the same for the SFV completion (an RFA-04 inserted already signed): LPN and LVN records sign on an `lpn` licence;
 *   - an amendment: a correction DRAFT needs no licence, its SIGNATURE does (the original stays signed until then);
 *   - a licence in another organization is no licence (RLS on the roster, and the refusal lands in the record's org);
 *   - a seam that cannot answer (throwing, deny-stub, unregistered) is a retryable 503 `M10_SIGNER_LICENCE_UNVERIFIABLE`,
 *     nothing signed, logged with the error class only and NOT audited as a refusal;
 *   - the CW-MON-01 hook: the refusals, read back through the real review reader, raise `signature.licence_refusal_burst`
 *     at the third refusal by one user, not at the second.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m10:signer-licence:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  SECURITY_RULES,
  type SignalRule,
  evaluateSignalRules,
  readSignalEvents,
} from "@chartwarden/audit";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "pg";
import {
  type MockInstance,
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { importHopeSpec } from "../../../scripts/db/import-hope-spec";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import { applyIdempotency } from "../src/bootstrap/plugins/idempotency";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { credentialReaderDenyStub } from "../src/bootstrap/seams/providers";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import {
  createAdmissionStatusReader,
  createDrizzleAdmissionReaderStore,
} from "../src/modules/06-admission/index";
import {
  HOPE_SIGNER_LICENCE_POLICY_CHANGED_EVENT,
  HOPE_SIGNER_LICENCE_REFUSED_EVENT,
} from "../src/modules/10-hope/hope-operator-audit";
import {
  type HopeWriteOutboxPort,
  M10_OUTBOX_EVENTS,
  createDbHopeBackend,
} from "../src/modules/10-hope/index";
import {
  type CredentialStore,
  createDrizzleCredentialStore,
  registerCredentialSeam,
} from "../src/modules/17-scheduling/seams/index";
import { answerHopeForSign } from "./_hope-sign-ready";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const QUIET_DATA = { J: { J2051: { entries: [{ symptomCode: "pain", severity: "mild" }] } } };
const TRIGGER_DATA = { J: { J2051: { entries: [{ symptomCode: "pain", severity: "moderate" }] } } };
const SFV_DATA = {
  J: {
    J2053: Object.fromEntries(
      ["A", "B", "C", "D", "E", "F", "G", "H"].map((l) => [`J2053${l}`, "1"]),
    ),
  },
};
const DAY_MS = 86_400_000;
const dayFromToday = (n: number): string =>
  new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);
const SIGNED_AUDIT = "hope.timepoint_signed";
const SFV_AUDIT = "hope.sfv_completed";
/** The request's own trace hint (`x-correlation-id`): a client can choose it, so it rides in the context, never as the row's correlation id. */
const CLIENT_TRACE = "licence-suite-trace";
/** The licence-refusal context keys, and no others: ids and closed enums only (plus the client's trace hint when the request has one). */
const REFUSAL_CONTEXT_KEYS = [
  "byMembershipId",
  "clientCorrelationId",
  "errorCode",
  "heldLicenceKinds",
  "licenceAsOf",
  "mode",
  "operation",
  "reason",
  "requiredDiscipline",
  "rfaKind",
];

/** A signer: a user, their membership and (optionally) licences, in one organization. */
type Signer =
  | "rn"
  | "rnLastDay"
  | "rnExpired"
  | "rnSuspended"
  | "rnRevoked"
  | "rnFuture"
  | "np"
  | "lpn"
  | "none"
  | "late"
  | "late2"
  | "prober"
  | "shadower"
  | "noneB"
  | "operator"
  | "operatorB"
  | "rnB"
  | "authorA"
  | "authorB";

describe.skipIf(!DB_URL)("CW-AC-46 HOPE signer licence at signing — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbHopeBackend>;
  let credentials: CredentialStore;
  let warn: MockInstance;
  const userOf = {} as Record<Signer, string>;
  const memberOf = {} as Record<Signer, string>;
  const providerOf: Record<string, string> = {};
  const locationOf: Record<string, string> = {};
  let admSeq = 0x77000000;
  let uuidSeq = 0;
  const uuid = (prefix: string): string =>
    `${prefix}-0000-4000-8000-${(++uuidSeq).toString(16).padStart(12, "0")}`;

  // ── seeding (as the superuser) ────────────────────────────────────────────────────────────────────────────────────────
  async function seedSigner(signer: Signer, org: string): Promise<void> {
    userOf[signer] = uuid("aaaaaaaa");
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [
      userOf[signer],
      `${signer.toLowerCase()}@licence.test`,
    ]);
    memberOf[signer] = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userOf[signer], org],
      )
    ).rows[0].id as string;
  }

  async function seedAdmission(org: string): Promise<string> {
    admSeq += 1;
    const admissionId = `77000000-0000-4000-8000-${admSeq.toString(16).padStart(12, "0")}`;
    const patientId = `44444444-4444-4444-8444-${admissionId.slice(-12)}`;
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
      [admissionId, org, providerOf[org], locationOf[org], patientId, userOf.authorA],
    );
    await admin.query(
      `INSERT INTO hope_timepoint_schedule (organization_id, provider_entity_id, location_id, patient_id,
         admission_id, rfa_kind, window_opens_at, window_closes_at, late_deadline_at, alert_cadence, generated_by)
       VALUES ($1,$2,$3,$4,$5,'01_admission',$6,$7,$8,'{}'::jsonb,'auto_admission')`,
      [
        org,
        providerOf[org],
        locationOf[org],
        patientId,
        admissionId,
        new Date(Date.now() - 1_000).toISOString(),
        new Date(Date.now() + 5 * DAY_MS).toISOString(),
        new Date(Date.now() + 10 * DAY_MS).toISOString(),
      ],
    );
    return admissionId;
  }

  const authorOf = (org: string): string => memberOf[org === ORG_A ? "authorA" : "authorB"];

  const answerForSign = (
    id: string,
    org = ORG_A,
    overrides: Record<string, string> = {},
  ): Promise<void> =>
    answerHopeForSign(
      {
        svc,
        orgId: org,
        membershipId: authorOf(org),
        answerDate: new Date().toISOString().slice(0, 10),
      },
      id,
      overrides,
    );

  /** A draft attributed to `discipline`, answered until sign-ready. Any membership may author it: only the SIGNATURE is licensed. */
  async function signable(discipline = "RN", org = ORG_A): Promise<string> {
    const admissionId = await seedAdmission(org);
    const draft = await svc.recordTimepoint(org, authorOf(org), admissionId, {
      rfaKind: "01_admission" as const,
      targetDate: new Date().toISOString(),
      authorDiscipline: discipline,
      data: QUIET_DATA,
    });
    await answerForSign(draft.id, org);
    return draft.id;
  }

  /** An open SFV (J2051 moderate on an admission draft): the admission, the triggering draft and the SFV. */
  async function openSfv(): Promise<{ admissionId: string; draftId: string; sfvId: string }> {
    const admissionId = await seedAdmission(ORG_A);
    const draft = await svc.recordTimepoint(ORG_A, authorOf(ORG_A), admissionId, {
      rfaKind: "01_admission" as const,
      targetDate: new Date().toISOString(),
      authorDiscipline: "RN",
      data: TRIGGER_DATA,
    });
    const ws = await svc.getAssessmentWorkspace(ORG_A, draft.id, { mayWrite: true });
    await svc.patchAssessmentAnswers(ORG_A, authorOf(ORG_A), draft.id, {
      ifVersion: ws.assessment.version,
      changes: [
        { itemCode: "J2050A", action: "set" as const, value: "1" },
        {
          itemCode: "J2050B",
          action: "set" as const,
          value: new Date().toISOString().slice(0, 10),
        },
        { itemCode: "J2051A", action: "set" as const, value: "2" },
      ],
    });
    const { sfvs } = await svc.listSfv(ORG_A, "open");
    const sfv = sfvs.find((s) => s.triggeringAssessmentId === draft.id);
    if (!sfv) throw new Error("the J2051 moderate answer opened no SFV");
    return { admissionId, draftId: draft.id, sfvId: sfv.id };
  }

  const sign = (signer: Signer, id: string, org = ORG_A) =>
    svc.signTimepoint(org, memberOf[signer], id, {
      attestationConfirmed: true,
      request: { actorUserId: userOf[signer], correlationId: CLIENT_TRACE },
    });

  const completeSfv = (
    signer: Signer,
    s: { admissionId: string; draftId: string },
    discipline: string,
  ) =>
    svc.recordSfv(ORG_A, memberOf[signer], s.admissionId, {
      triggeringAssessmentId: s.draftId,
      targetDate: new Date().toISOString(),
      authorDiscipline: discipline,
      data: SFV_DATA,
      attestationConfirmed: true,
      request: { actorUserId: userOf[signer], correlationId: CLIENT_TRACE },
    });

  // ── reads (as the superuser, to see what is stored; the RLS proofs below read as the app role) ───────────────────────
  const row = async (id: string) =>
    (
      await admin.query(
        "SELECT status, version, signed_at, signed_by_membership_id FROM hope_assessment WHERE id=$1",
        [id],
      )
    ).rows[0] as {
      status: string;
      version: number;
      signed_at: Date | null;
      signed_by_membership_id: string | null;
    };

  const auditRows = async (eventType: string, resourceId: string) =>
    (
      await admin.query(
        `SELECT outcome, severity, resource_kind, resource_id::text AS resource_id, actor_user_id::text AS actor_user_id,
                organization_id::text AS organization_id, correlation_id, context
           FROM audit_event WHERE event_type=$1 AND resource_id::text=$2 ORDER BY created_at`,
        [eventType, resourceId],
      )
    ).rows as {
      correlation_id: string;
      outcome: string;
      severity: string;
      resource_kind: string;
      resource_id: string;
      actor_user_id: string | null;
      organization_id: string;
      context: Record<string, unknown>;
    }[];

  const outboxEvents = async (aggregateId: string): Promise<string[]> =>
    (
      await admin.query(
        "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
        [aggregateId],
      )
    ).rows.map((r) => r.event_type as string);

  /** A draft the refused signature must leave exactly as it was. */
  async function expectUntouched(id: string, before: Awaited<ReturnType<typeof row>>) {
    const after = await row(id);
    expect(after.status).toBe("draft");
    expect(after.version).toBe(before.version);
    expect(after.signed_at).toBeNull();
    expect(after.signed_by_membership_id).toBeNull();
    expect(await auditRows(SIGNED_AUDIT, id)).toHaveLength(0);
    expect(await outboxEvents(id)).not.toContain("m10.hope.timepoint_signed");
  }

  /** The one refusal row a refused signature leaves, checked as a whole (the key set is closed: ids and enums only). */
  async function expectRefusalAudit(
    resourceId: string,
    resourceKind: string,
    signer: Signer,
    expected: Record<string, unknown>,
  ) {
    const rows = await auditRows(HOPE_SIGNER_LICENCE_REFUSED_EVENT, resourceId);
    expect(rows).toHaveLength(1);
    const [event] = rows;
    expect(event).toMatchObject({
      outcome: "denied",
      severity: "warn",
      resource_kind: resourceKind,
      actor_user_id: userOf[signer],
      organization_id: ORG_A,
    });
    expect(Object.keys(event?.context ?? {}).sort()).toEqual(REFUSAL_CONTEXT_KEYS);
    expect(event?.context).toMatchObject({
      byMembershipId: memberOf[signer],
      clientCorrelationId: CLIENT_TRACE,
      mode: "enforce", // an organization that never set a mode enforces
      ...expected,
    });
    // The row's own correlation id is server-generated: the client's hint never becomes the key rows are joined on.
    expect(event?.correlation_id).toBe(`m10-signature-licence-refused:${resourceId}`);
    // The UTC day the licence was judged on (yesterday's, were this test to straddle 00:00 UTC).
    expect([dayFromToday(0), dayFromToday(-1)]).toContain(event?.context.licenceAsOf);
  }

  const refusalOf = async (attempt: Promise<unknown>): Promise<ChartWardenError> => {
    const error = await attempt.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ChartWardenError);
    return error as ChartWardenError;
  };

  // ── setup ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  function registerBootSeams(): void {
    registerSeam(
      "AdmissionStatusReader",
      createAdmissionStatusReader(createDrizzleAdmissionReaderStore(handle.db)),
    );
    registerPatientSeams({ db: handle.db });
    // Exactly what boot registers (src/index.ts): the Drizzle store over `membership_credential`, as the app role.
    registerCredentialSeam({ store: credentials });
  }

  async function applyMigrations(): Promise<void> {
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let text = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        text = text.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        text = text.replace(/\bvector\(\d+\)/g, "text");
        text = text.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(text);
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await dropLiveRoles(admin);
    await applyMigrations();
    await importHopeSpec({ databaseUrl: DB_URL });
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    for (const org of [ORG_A, ORG_B]) {
      providerOf[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end,
                                        addresses, iqies_facility_id)
           VALUES ($1,$2,$3,$4,'enc','12-31',
                   '[{"line1":"1 St","city":"Town","state":"OR","postalCode":"97000"}]'::jsonb, $5) RETURNING id`,
          [
            org,
            `CCN-LIC-${org.slice(0, 4)}`,
            `LIC ${org.slice(0, 4)}`,
            `NPI-LIC-${org.slice(0, 4)}`,
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
    await seedSigner("authorA", ORG_A);
    await seedSigner("authorB", ORG_B);
    for (const s of [
      "rn",
      "rnLastDay",
      "rnExpired",
      "rnSuspended",
      "rnRevoked",
      "rnFuture",
      "np",
      "lpn",
      "none",
      "late",
      "late2",
      "prober",
      "shadower",
      "operator",
    ] as const)
      await seedSigner(s, ORG_A);
    await seedSigner("rnB", ORG_B);
    await seedSigner("noneB", ORG_B);
    await seedSigner("operatorB", ORG_B);

    const url = await appRoleConnectionString(admin, DB_URL as string);
    handle = createDbClient({ connectionString: url });
    credentials = createDrizzleCredentialStore(handle.db);
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M10_OUTBOX_EVENTS]));
    const outbox: HopeWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m10" }),
    };
    svc = createDbHopeBackend(handle.db, outbox);

    // The licences, granted through the REAL store as the app role (the path the management routes use).
    const grant = (
      signer: Signer,
      credentialType: "rn" | "np" | "lpn",
      effectiveAt: string,
      expiresAt: string | null,
      org = ORG_A,
    ) =>
      credentials.grant(org, {
        membershipId: memberOf[signer],
        credentialType,
        effectiveAt,
        expiresAt,
        issuingBody: "Synthetic State Board of Nursing",
        grantedByMembershipId: authorOf(org),
      });
    await grant("rn", "rn", "2020-01-01", dayFromToday(365));
    await grant("rnLastDay", "rn", "2020-01-01", dayFromToday(0)); // the last valid day is still valid
    await grant("rnExpired", "rn", "2019-01-01", dayFromToday(-1));
    await grant("rnFuture", "rn", dayFromToday(1), null);
    const suspended = await grant("rnSuspended", "rn", "2020-01-01", null);
    await admin.query("UPDATE membership_credential SET status='suspended' WHERE id=$1", [
      suspended.id,
    ]);
    const revoked = await grant("rnRevoked", "rn", "2020-01-01", null);
    await credentials.revoke(ORG_A, {
      credentialId: revoked.id,
      revokedReason: "synthetic revocation",
      revokedByMembershipId: authorOf(ORG_A),
    });
    await grant("np", "np", "2020-01-01", null);
    await grant("lpn", "lpn", "2020-01-01", null);
    await grant("rnB", "rn", "2020-01-01", null, ORG_B);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(() => {
    __resetSeamsForTest();
    registerBootSeams();
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    return () => warn.mockRestore();
  });

  // ── a valid licence signs ─────────────────────────────────────────────────────────────────────────────────────────────
  it.each([
    ["an RN licence signs an RN record", "rn", "RN"],
    ["an NP licence signs an NP record", "np", "NP"],
    ["a licence whose last valid day is today still signs", "rnLastDay", "RN"],
  ] as const)("%s", async (_name, signer, discipline) => {
    const id = await signable(discipline);
    const signed = await sign(signer, id);
    expect(signed).toMatchObject({ status: "signed", signedByMembershipId: memberOf[signer] });
    expect((await row(id)).status).toBe("signed");
    expect(await auditRows(SIGNED_AUDIT, id)).toHaveLength(1);
    expect(await auditRows(HOPE_SIGNER_LICENCE_REFUSED_EVENT, id)).toHaveLength(0);
    // The REAL catalog-validating publisher wrote the event row in the same transaction.
    expect(await outboxEvents(id)).toContain("m10.hope.timepoint_signed");
  });

  // ── no active licence: missing, expired, suspended, revoked, not yet effective ──────────────────────────────────────────
  it.each([
    ["a missing licence", "none"],
    ["an expired licence (yesterday)", "rnExpired"],
    ["a suspended licence", "rnSuspended"],
    ["a revoked licence", "rnRevoked"],
    ["a licence that is not yet effective", "rnFuture"],
  ] as const)("refuses %s: 403, typed, nothing written, one audit row", async (_name, signer) => {
    const id = await signable("RN");
    const before = await row(id);

    const refusal = await refusalOf(sign(signer, id));

    expect(refusal).toMatchObject({ code: "M10_SIGNER_LICENCE_NOT_ACTIVE", statusCode: 403 });
    expect(refusal.message).toContain("NEW Idempotency-Key");
    await expectUntouched(id, before);
    await expectRefusalAudit(id, "hope_assessment", signer, {
      errorCode: "M10_SIGNER_LICENCE_NOT_ACTIVE",
      operation: "timepoint_sign",
      reason: "no_active_licence",
      rfaKind: "01_admission",
      requiredDiscipline: "RN",
      heldLicenceKinds: [],
    });
  });

  // ── wrong discipline ────────────────────────────────────────────────────────────────────────────────────────────────────
  it.each([
    ["an NP licence cannot sign an RN-attributed record", "np", "RN", ["np"]],
    ["an RN licence cannot sign an NP-attributed record", "rn", "NP", ["rn"]],
    ["an RN licence cannot sign an MD-attributed record", "rn", "MD", ["rn"]],
  ] as const)("%s", async (_name, signer, discipline, held) => {
    const id = await signable(discipline);
    const before = await row(id);

    const refusal = await refusalOf(sign(signer, id));

    expect(refusal).toMatchObject({
      code: "M10_SIGNER_LICENCE_WRONG_DISCIPLINE",
      statusCode: 403,
    });
    await expectUntouched(id, before);
    await expectRefusalAudit(id, "hope_assessment", signer, {
      errorCode: "M10_SIGNER_LICENCE_WRONG_DISCIPLINE",
      reason: "wrong_discipline",
      requiredDiscipline: discipline,
      heldLicenceKinds: held,
    });
  });

  it("a refusal is not a verdict on the draft: once the licence is recorded (the real store), the same draft signs", async () => {
    const id = await signable("RN");
    await refusalOf(sign("late", id));
    expect((await row(id)).status).toBe("draft");

    await credentials.grant(ORG_A, {
      membershipId: memberOf.late,
      credentialType: "rn",
      effectiveAt: "2020-01-01",
      grantedByMembershipId: authorOf(ORG_A),
    });

    expect(await sign("late", id)).toMatchObject({ status: "signed" });
    expect(await auditRows(HOPE_SIGNER_LICENCE_REFUSED_EVENT, id)).toHaveLength(1);
  });

  // ── the SFV completion (an RFA-04 inserted already signed) ──────────────────────────────────────────────────────────────
  describe("SFV completion", () => {
    const sfvRows = async (admissionId: string): Promise<number> =>
      Number(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM hope_assessment WHERE admission_id=$1 AND rfa_kind='04_sfv'",
            [admissionId],
          )
        ).rows[0].n,
      );
    const sfvStatus = async (sfvId: string): Promise<string> =>
      (await admin.query("SELECT status FROM symptom_follow_up_visit WHERE id=$1", [sfvId])).rows[0]
        .status as string;

    it("refuses an unlicensed signer: no RFA-04, the SFV stays open, one audit row on the admission", async () => {
      const s = await openSfv();

      const refusal = await refusalOf(completeSfv("none", s, "RN"));

      expect(refusal).toMatchObject({ code: "M10_SIGNER_LICENCE_NOT_ACTIVE", statusCode: 403 });
      expect(await sfvRows(s.admissionId)).toBe(0);
      expect(await sfvStatus(s.sfvId)).toBe("open");
      // (The completion's signature event is keyed on the new RFA-04's id, which does not exist: look it up by the SFV.)
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM audit_event WHERE event_type=$1 AND context->>'sfvId'=$2",
            [SFV_AUDIT, s.sfvId],
          )
        ).rows[0].n,
      ).toBe(0);
      await expectRefusalAudit(s.admissionId, "admission", "none", {
        errorCode: "M10_SIGNER_LICENCE_NOT_ACTIVE",
        operation: "sfv_complete",
        reason: "no_active_licence",
        rfaKind: "04_sfv",
        requiredDiscipline: "RN",
        heldLicenceKinds: [],
      });
    });

    it("refuses an LPN-attributed completion on an RN licence (wrong discipline)", async () => {
      const s = await openSfv();

      const refusal = await refusalOf(completeSfv("rn", s, "LPN"));

      expect(refusal).toMatchObject({ code: "M10_SIGNER_LICENCE_WRONG_DISCIPLINE" });
      expect(await sfvRows(s.admissionId)).toBe(0);
      expect(await sfvStatus(s.sfvId)).toBe("open");
      await expectRefusalAudit(s.admissionId, "admission", "rn", {
        reason: "wrong_discipline",
        operation: "sfv_complete",
        requiredDiscipline: "LPN",
        heldLicenceKinds: ["rn"],
      });
    });

    it.each(["LPN", "LVN"] as const)(
      "completes a %s-attributed SFV on an lpn licence (LVN is the state title of LPN)",
      async (discipline) => {
        const s = await openSfv();

        const completed = await completeSfv("lpn", s, discipline);

        expect(completed).toMatchObject({ status: "signed", rfaKind: "04_sfv" });
        expect(await sfvStatus(s.sfvId)).toBe("completed");
        expect(await auditRows(HOPE_SIGNER_LICENCE_REFUSED_EVENT, s.admissionId)).toHaveLength(0);
      },
    );

    it("completes an RN-attributed SFV on an rn licence", async () => {
      const s = await openSfv();
      expect(await completeSfv("rn", s, "RN")).toMatchObject({ status: "signed" });
      expect(await sfvStatus(s.sfvId)).toBe("completed");
    });
  });

  // ── amendments ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("an amendment: the correction DRAFT needs no licence, its SIGNATURE does, and the original stays signed until then", async () => {
    const originalId = await signable("RN");
    await sign("rn", originalId);

    const correction = await svc.correctTimepoint(ORG_A, memberOf.none, originalId, {
      correctionReason: "corrected the payer after re-review",
      targetDate: new Date().toISOString(),
      authorDiscipline: "RN",
      data: QUIET_DATA,
    });
    await answerForSign(correction.id, ORG_A, { A1400A: "0", A1400B: "1" });
    const before = await row(correction.id);

    const refusal = await refusalOf(sign("none", correction.id));

    expect(refusal).toMatchObject({ code: "M10_SIGNER_LICENCE_NOT_ACTIVE", statusCode: 403 });
    await expectUntouched(correction.id, before);
    expect((await row(originalId)).status).toBe("signed"); // not superseded by a draft or by a refused signature
    await expectRefusalAudit(correction.id, "hope_assessment", "none", {
      reason: "no_active_licence",
      requiredDiscipline: "RN",
    });

    expect(await sign("rn", correction.id)).toMatchObject({ status: "signed" });
    expect((await row(originalId)).status).toBe("superseded");
  });

  // ── tenant isolation ──────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("cross-tenant isolation", () => {
    it("the licence roster is org-scoped: as the app role, org B sees none of org A's licences and org A sees its own", async () => {
      const count = (org: string) =>
        withOrgContext(handle.db, { organizationId: org, userId: "" }, async (tx) => {
          const { rows } = await tx.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM membership_credential WHERE membership_id = ${memberOf.rn}::uuid`,
          );
          return Number(rows[0]?.n);
        });
      expect(await count(ORG_B)).toBe(0);
      expect(await count(ORG_A)).toBe(1);
    });

    it("an org B licence is no licence in org A: refused, and the refusal lands in org A only", async () => {
      const id = await signable("RN", ORG_A);

      const refusal = await refusalOf(
        svc.signTimepoint(ORG_A, memberOf.rnB, id, {
          attestationConfirmed: true,
          request: { actorUserId: userOf.rnB },
        }),
      );

      expect(refusal).toMatchObject({ code: "M10_SIGNER_LICENCE_NOT_ACTIVE", statusCode: 403 });
      expect((await row(id)).status).toBe("draft");
      const rows = await auditRows(HOPE_SIGNER_LICENCE_REFUSED_EVENT, id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.organization_id).toBe(ORG_A);
      const visibleTo = (org: string) =>
        withOrgContext(handle.db, { organizationId: org, userId: "" }, async (tx) => {
          const { rows: seen } = await tx.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM audit_event WHERE event_type = ${HOPE_SIGNER_LICENCE_REFUSED_EVENT} AND resource_id::text = ${id}`,
          );
          return Number(seen[0]?.n);
        });
      expect(await visibleTo(ORG_B)).toBe(0);
      expect(await visibleTo(ORG_A)).toBe(1);
    });

    it("an org A licence is no licence in org B, while org B's own licensed signer signs its own record", async () => {
      const idB = await signable("RN", ORG_B);

      const refusal = await refusalOf(
        svc.signTimepoint(ORG_B, memberOf.rn, idB, { attestationConfirmed: true }),
      );
      expect(refusal).toMatchObject({ code: "M10_SIGNER_LICENCE_NOT_ACTIVE" });
      expect((await row(idB)).status).toBe("draft");

      const signed = await svc.signTimepoint(ORG_B, memberOf.rnB, idB, {
        attestationConfirmed: true,
      });
      expect(signed).toMatchObject({ status: "signed", signedByMembershipId: memberOf.rnB });
    });
  });

  // ── the seam cannot answer ──────────────────────────────────────────────────────────────────────────────────────────────
  describe("a credential seam that cannot answer fails closed", () => {
    const secret = "connection string with a secret";
    const outages: readonly (readonly [string, () => void])[] = [
      [
        "a throwing reader",
        () =>
          registerSeam("CredentialReader", {
            activeCredentialsAsOf: async () => {
              throw Object.assign(new Error(secret), { name: "M17DownError" });
            },
          }),
      ],
      ["the boot deny-stub", () => registerSeam("CredentialReader", credentialReaderDenyStub)],
      ["an unregistered seam", () => __resetSeamsForTest()],
    ];

    it.each(outages)(
      "%s: 503 M10_SIGNER_LICENCE_UNVERIFIABLE, nothing signed, logged, not audited",
      async (_name, breakSeam) => {
        const id = await signable("RN");
        const before = await row(id);
        breakSeam();

        const refusal = await refusalOf(sign("rn", id));

        expect(refusal).toMatchObject({
          code: "M10_SIGNER_LICENCE_UNVERIFIABLE",
          statusCode: 503,
        });
        await expectUntouched(id, before);
        expect(await auditRows(HOPE_SIGNER_LICENCE_REFUSED_EVENT, id)).toHaveLength(0);
        const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
        expect(logged).toContain(`membership ${memberOf.rn}`);
        expect(logged).not.toContain(secret);
      },
    );

    it("the same outage refuses an SFV completion too", async () => {
      const s = await openSfv();
      registerSeam("CredentialReader", credentialReaderDenyStub);

      const refusal = await refusalOf(completeSfv("lpn", s, "LPN"));

      expect(refusal).toMatchObject({ code: "M10_SIGNER_LICENCE_UNVERIFIABLE", statusCode: 503 });
      expect(
        (await admin.query("SELECT status FROM symptom_follow_up_visit WHERE id=$1", [s.sfvId]))
          .rows[0].status,
      ).toBe("open");
    });
  });

  // ── through the idempotency layer ──────────────────────────────────────────────────────────────────────────────────────────
  // The refusal text, the spec, the OpenAPI summary and the register all promise: the 403 is replayed on the same
  // Idempotency-Key (its audit write is a commit, so the plugin cannot release it) and the 503 is released. Proven here
  // over the real DB-backed idempotency store, the real commit tracker and the real service.
  describe("through the idempotency layer (the same Idempotency-Key)", () => {
    let app: FastifyInstance;
    let runs = 0;
    beforeAll(async () => {
      app = Fastify();
      app.decorateRequest("context", undefined as never);
      app.addHook("onRequest", async (request) => {
        const user = request.headers["x-user"];
        (request as unknown as { context: unknown }).context = {
          organizationId: ORG_A,
          userId: typeof user === "string" ? user : "",
          attributes: {},
        };
      });
      applyErrorHandler(app);
      applyIdempotency(app, createDbIdempotencyStore(handle.db));
      app.post("/sign/:id", async (request) => {
        runs += 1;
        const { id } = request.params as { id: string };
        return sign(request.headers["x-signer"] as Signer, id);
      });
      await app.ready();
    });
    afterAll(async () => {
      await app?.close();
    });

    const post = (signer: Signer, id: string, key: string) =>
      app.inject({
        method: "POST",
        url: `/sign/${id}`,
        headers: { "idempotency-key": key, "x-signer": signer, "x-user": userOf[signer] },
        payload: { attestationConfirmed: true },
      });

    it("a refusal is replayed on the same key even after the licence is recorded; a NEW key then signs", async () => {
      const id = await signable("RN");
      runs = 0;

      const first = await post("late2", id, "licence-key-403");
      expect(first.statusCode).toBe(403);
      expect(first.json().error.code).toBe("M10_SIGNER_LICENCE_NOT_ACTIVE"); // the standard error envelope
      expect(first.json().error.message).toContain("NEW Idempotency-Key");
      await credentials.grant(ORG_A, {
        membershipId: memberOf.late2,
        credentialType: "rn",
        effectiveAt: "2020-01-01",
        grantedByMembershipId: authorOf(ORG_A),
      });

      const replay = await post("late2", id, "licence-key-403");
      expect(replay.statusCode).toBe(403);
      expect(replay.json()).toEqual(first.json());
      expect(runs).toBe(1); // the handler did not run again
      expect((await row(id)).status).toBe("draft");

      const renewed = await post("late2", id, "licence-key-403-renewed");
      expect(renewed.statusCode).toBe(200);
      expect(runs).toBe(2);
      expect((await row(id)).status).toBe("signed");
    });

    it("a seam outage answers 503 and RELEASES the key: the same key runs again once the roster is readable", async () => {
      const id = await signable("RN");
      runs = 0;
      registerSeam("CredentialReader", credentialReaderDenyStub);

      const outage = await post("rn", id, "licence-key-503");
      expect(outage.statusCode).toBe(503);
      expect(outage.json().error.code).toBe("M10_SIGNER_LICENCE_UNVERIFIABLE");
      expect((await row(id)).status).toBe("draft");

      registerBootSeams(); // the real roster is back
      const retry = await post("rn", id, "licence-key-503");
      expect(retry.statusCode).toBe(200);
      expect(runs).toBe(2); // the released key ran the handler again
      expect((await row(id)).status).toBe("signed");
    });
  });

  // ── the per-organization enforcement mode (the shadow switch) ──────────────────────────────────────────────────────────────
  // enforce is the default (an organization with no row enforces); a platform operator may put an organization in shadow for the
  // rollout window with a reason; in shadow the signature goes through and the would-be refusal is an audit finding the burst
  // rule still counts; a change is audited; one organization's mode never reaches another's. Proven over the real table as the app role.
  describe("per-organization enforcement mode (enforce by default, shadow with a reason)", () => {
    const REASON = "Rollout window: back-filling the clinicians' licences before enforcing";
    const SHADOW_CONTEXT_KEYS = [
      "byMembershipId",
      "clientCorrelationId",
      "errorCode",
      "heldLicenceKinds",
      "licenceAsOf",
      "mode",
      "operation",
      "reason",
      "requiredDiscipline",
      "rfaKind",
    ];

    const putMode = (org: string, operator: Signer, mode: "enforce" | "shadow", reason?: string) =>
      svc.putSignerLicencePolicy(org, {
        mode,
        ...(reason !== undefined ? { reason } : {}),
        membershipId: memberOf[operator],
        actorUserId: userOf[operator],
        request: { actorUserId: userOf[operator], correlationId: CLIENT_TRACE },
      });
    const policyRows = async (org: string) =>
      (
        await admin.query(
          "SELECT mode, shadow_reason, configured_by_user_id::text AS configured_by FROM hope_signer_licence_policy WHERE organization_id=$1",
          [org],
        )
      ).rows as { mode: string; shadow_reason: string | null; configured_by: string }[];
    const changes = (org: string) => auditRows(HOPE_SIGNER_LICENCE_POLICY_CHANGED_EVENT, org);
    /** The rows of the policy table the app role can see under `org`'s tenant context (RLS decides). */
    const visibleRows = (org: string) =>
      withOrgContext(handle.db, { organizationId: org, userId: "" }, async (tx) => {
        const { rows } = await tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM hope_signer_licence_policy`,
        );
        return Number(rows[0]?.n);
      });

    afterAll(async () => {
      // Every later case, and the other suites' assumptions, start from the default: leave both organizations enforcing.
      await putMode(ORG_A, "operator", "enforce");
      await putMode(ORG_B, "operatorB", "enforce");
    });

    it("an organization with no setting ENFORCES: the policy reads enforce (never configured) and an unlicensed signer is refused", async () => {
      expect(await svc.getSignerLicencePolicy(ORG_A)).toEqual({
        mode: "enforce",
        reason: null,
        configuredAt: null,
      });
      expect(await policyRows(ORG_A)).toHaveLength(0);
      const id = await signable("RN");

      const refusal = await refusalOf(sign("none", id));

      expect(refusal).toMatchObject({ code: "M10_SIGNER_LICENCE_NOT_ACTIVE", statusCode: 403 });
      expect((await row(id)).status).toBe("draft");
    });

    it.each([
      ["shadow without a reason", "shadow", undefined],
      ["shadow with a blank reason", "shadow", "                              "],
      ["shadow with a reason one character too short", "shadow", "x".repeat(19)],
      ["shadow with a reason one character too long", "shadow", "x".repeat(201)],
      ["enforce carrying a reason", "enforce", REASON],
      [
        "shadow whose reason carries a patient identifier",
        "shadow",
        "Rollout window while the roster of SSN 900-12-3456 is entered",
      ],
    ] as const)("refuses %s (422): no row, no audit event", async (_name, mode, reason) => {
      const failure = await putMode(ORG_A, "operator", mode, reason).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(ChartWardenError);
      expect(failure).toMatchObject({ statusCode: 422 });
      expect(await policyRows(ORG_A)).toHaveLength(0);
      expect(await changes(ORG_A)).toHaveLength(0);
    });

    it("the table's own CHECK is the last line: shadow with no reason, and enforce with one, are refused by the database", async () => {
      const insert = (mode: string, reason: string | null) =>
        admin.query(
          "INSERT INTO hope_signer_licence_policy (organization_id, mode, shadow_reason, configured_by_user_id) VALUES ($1,$2::hope_signer_licence_mode,$3,$4)",
          [ORG_A, mode, reason, userOf.operator],
        );
      await expect(insert("shadow", null)).rejects.toMatchObject({ code: "23514" });
      await expect(insert("shadow", "too short")).rejects.toMatchObject({ code: "23514" });
      await expect(insert("enforce", REASON)).rejects.toMatchObject({ code: "23514" });
      expect(await policyRows(ORG_A)).toHaveLength(0);
    });

    it("RLS: under org B's tenant context the app role cannot write org A's row", async () => {
      const failure = await withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, (tx) =>
        tx.execute(
          sql`INSERT INTO hope_signer_licence_policy (organization_id, mode, configured_by_user_id) VALUES (${ORG_A}::uuid, 'enforce', ${userOf.operatorB}::uuid)`,
        ),
      ).catch((e: unknown) => e);
      // drizzle wraps the driver's error: the policy's own refusal is on its cause
      const driver = (failure as { cause?: { code?: string; message?: string } }).cause;
      expect(driver?.code).toBe("42501");
      expect(driver?.message).toMatch(/row-level security/i);
      expect(await policyRows(ORG_A)).toHaveLength(0);
    });

    it("shadow with a reason is stored and audited: the row, the reason, the operator, and one warn event naming the change", async () => {
      const set = await putMode(ORG_A, "operator", "shadow", `  ${REASON}  `);

      expect(set).toMatchObject({ mode: "shadow", reason: REASON }); // trimmed
      expect(set.configuredAt).toEqual(expect.any(String));
      expect(await policyRows(ORG_A)).toEqual([
        { mode: "shadow", shadow_reason: REASON, configured_by: userOf.operator },
      ]);
      expect(await svc.getSignerLicencePolicy(ORG_A)).toMatchObject({
        mode: "shadow",
        reason: REASON,
      });
      const [event, ...rest] = await changes(ORG_A);
      expect(rest).toHaveLength(0);
      expect(event).toMatchObject({
        outcome: "success",
        severity: "warn",
        resource_kind: "organization",
        actor_user_id: userOf.operator,
        organization_id: ORG_A,
      });
      expect(Object.keys(event?.context ?? {}).sort()).toEqual([
        "byMembershipId",
        "clientCorrelationId",
        "justification",
        "mode",
        "previousMode",
      ]);
      expect(event?.context).toMatchObject({
        previousMode: "enforce",
        mode: "shadow",
        justification: REASON,
        byMembershipId: memberOf.operator,
      });
    });

    it("in shadow an UNLICENSED signer signs, and the would-be refusal lands as a finding (mode shadow, outcome success), not a denial", async () => {
      const id = await signable("RN");

      const signed = await sign("none", id);

      expect(signed).toMatchObject({ status: "signed", signedByMembershipId: memberOf.none });
      expect((await row(id)).status).toBe("signed");
      expect(await auditRows(SIGNED_AUDIT, id)).toHaveLength(1);
      expect(await outboxEvents(id)).toContain("m10.hope.timepoint_signed");
      const findings = await auditRows(HOPE_SIGNER_LICENCE_REFUSED_EVENT, id);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        outcome: "success",
        severity: "warn",
        resource_kind: "hope_assessment",
        actor_user_id: userOf.none,
        organization_id: ORG_A,
      });
      expect(Object.keys(findings[0]?.context ?? {}).sort()).toEqual(SHADOW_CONTEXT_KEYS);
      expect(findings[0]?.context).toMatchObject({
        mode: "shadow",
        errorCode: "M10_SIGNER_LICENCE_NOT_ACTIVE",
        operation: "timepoint_sign",
        reason: "no_active_licence",
        requiredDiscipline: "RN",
        heldLicenceKinds: [],
      });
    });

    it("in shadow a WRONG-DISCIPLINE signer signs too, with the finding saying so", async () => {
      const id = await signable("RN");

      expect(await sign("np", id)).toMatchObject({ status: "signed" });

      const [finding] = await auditRows(HOPE_SIGNER_LICENCE_REFUSED_EVENT, id);
      expect(finding?.context).toMatchObject({
        mode: "shadow",
        errorCode: "M10_SIGNER_LICENCE_WRONG_DISCIPLINE",
        reason: "wrong_discipline",
        heldLicenceKinds: ["np"],
      });
    });

    it("in shadow a LICENSED signer leaves no finding", async () => {
      const id = await signable("RN");

      expect(await sign("rn", id)).toMatchObject({ status: "signed" });

      expect(await auditRows(HOPE_SIGNER_LICENCE_REFUSED_EVENT, id)).toHaveLength(0);
    });

    it("in shadow an unlicensed SFV completion goes through, with the finding on the admission", async () => {
      const s = await openSfv();

      const completed = await completeSfv("none", s, "RN");

      expect(completed).toMatchObject({ status: "signed", rfaKind: "04_sfv" });
      const [finding, ...rest] = await auditRows(HOPE_SIGNER_LICENCE_REFUSED_EVENT, s.admissionId);
      expect(rest).toHaveLength(0);
      expect(finding).toMatchObject({
        outcome: "success",
        resource_kind: "admission",
        organization_id: ORG_A,
      });
      expect(finding?.context).toMatchObject({
        mode: "shadow",
        operation: "sfv_complete",
        rfaKind: "04_sfv",
        requiredDiscipline: "RN",
      });
    });

    it("the CW-MON-01 burst rule still counts shadow findings: three signatures by one unlicensed user raise it, two do not", async () => {
      const rule = SECURITY_RULES.find(
        (r) => r.id === "signature.licence_refusal_burst",
      ) as SignalRule;
      const findingsNow = () =>
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, async (tx) => {
          const read = await readSignalEvents(
            tx as never,
            { organizationId: ORG_A },
            {
              eventTypes: rule.eventTypes,
              from: new Date(Date.now() - 2 * 60 * 60 * 1000),
              to: new Date(Date.now() + 60_000),
              limit: 1000,
            },
          );
          return evaluateSignalRules([rule], read.events, { organizationId: ORG_A }).filter(
            (f) => f.subject.ref === userOf.shadower,
          );
        });

      expect(await sign("shadower", await signable("RN"))).toMatchObject({ status: "signed" });
      expect(await sign("shadower", await signable("RN"))).toMatchObject({ status: "signed" });
      expect(await findingsNow()).toEqual([]);

      expect(await sign("shadower", await signable("RN"))).toMatchObject({ status: "signed" });
      const findings = await findingsNow();
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: "signature.licence_refusal_burst",
        subject: { kind: "actor", ref: userOf.shadower },
        count: 3,
      });
    });

    it("another tenant's setting never leaks: org B still enforces and cannot see org A's row; org B's own change never reaches org A", async () => {
      expect(await svc.getSignerLicencePolicy(ORG_B)).toEqual({
        mode: "enforce",
        reason: null,
        configuredAt: null,
      });
      expect(await visibleRows(ORG_B)).toBe(0);
      expect(await visibleRows(ORG_A)).toBe(1);
      const idB = await signable("RN", ORG_B);
      const refusal = await refusalOf(sign("noneB", idB, ORG_B));
      expect(refusal).toMatchObject({ code: "M10_SIGNER_LICENCE_NOT_ACTIVE", statusCode: 403 });
      expect((await row(idB)).status).toBe("draft");

      // org B goes to shadow for its own reasons: org A keeps ITS row and reason, and org B's unlicensed signer now signs.
      const reasonB = "Org B rollout window: its roster is being entered this week";
      await putMode(ORG_B, "operatorB", "shadow", reasonB);
      expect(await svc.getSignerLicencePolicy(ORG_A)).toMatchObject({
        mode: "shadow",
        reason: REASON,
      });
      expect(await svc.getSignerLicencePolicy(ORG_B)).toMatchObject({
        mode: "shadow",
        reason: reasonB,
      });
      expect(await sign("noneB", idB, ORG_B)).toMatchObject({ status: "signed" });
      expect((await changes(ORG_B)).map((c) => c.organization_id)).toEqual([ORG_B]);
      expect((await changes(ORG_A)).map((c) => c.organization_id)).toEqual([ORG_A]);
      await putMode(ORG_B, "operatorB", "enforce");
    });

    it("switching back to ENFORCE refuses again, clears the reason from the row and audits the return (info)", async () => {
      const set = await putMode(ORG_A, "operator", "enforce");

      expect(set).toMatchObject({ mode: "enforce", reason: null });
      expect(await policyRows(ORG_A)).toEqual([
        { mode: "enforce", shadow_reason: null, configured_by: userOf.operator },
      ]);
      const events = await changes(ORG_A);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ outcome: "success", severity: "info" });
      expect(events[1]?.context).toMatchObject({
        previousMode: "shadow",
        mode: "enforce",
        justification: null,
      });
      const id = await signable("RN");

      const refusal = await refusalOf(sign("none", id));

      expect(refusal).toMatchObject({ code: "M10_SIGNER_LICENCE_NOT_ACTIVE", statusCode: 403 });
      expect((await row(id)).status).toBe("draft");
      const [denial, ...rest] = await auditRows(HOPE_SIGNER_LICENCE_REFUSED_EVENT, id);
      expect(rest).toHaveLength(0);
      expect(denial).toMatchObject({ outcome: "denied", severity: "warn" });
      expect(denial?.context).toMatchObject({ mode: "enforce" });
    });
  });

  // ── the CW-MON-01 hook ──────────────────────────────────────────────────────────────────────────────────────────────────────
  it("CW-MON-01: the refusals, read back through the real review reader, raise the burst rule at the third by one user", async () => {
    const rule = SECURITY_RULES.find(
      (r) => r.id === "signature.licence_refusal_burst",
    ) as SignalRule;
    expect(rule).toMatchObject({ kind: "burst", lane: "org", subject: "actor" });
    expect(rule.eventTypes).toEqual([HOPE_SIGNER_LICENCE_REFUSED_EVENT]);
    const id = await signable("RN");

    const findingsNow = () =>
      withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, async (tx) => {
        const read = await readSignalEvents(
          tx as never,
          { organizationId: ORG_A },
          {
            eventTypes: rule.eventTypes,
            from: new Date(Date.now() - 2 * 60 * 60 * 1000),
            to: new Date(Date.now() + 60_000),
            limit: 1000,
          },
        );
        // Every refusal the suite made is in this org's trail (the `none` signer has several, so it has its own finding):
        // this case judges one fresh user, `prober`.
        return evaluateSignalRules([rule], read.events, { organizationId: ORG_A }).filter(
          (f) => f.subject.ref === userOf.prober,
        );
      });

    await refusalOf(sign("prober", id));
    await refusalOf(sign("prober", id));
    expect(await findingsNow()).toEqual([]);

    await refusalOf(sign("prober", id));
    const findings = await findingsNow();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "signature.licence_refusal_burst",
      severity: "warn",
      organizationId: ORG_A,
      subject: { kind: "actor", ref: userOf.prober },
      count: 3,
      controls: ["CW-AC-46", "CW-MON-01"],
    });
  });

  it("is proven as the NOBYPASSRLS app role, not a superuser", async () => {
    const { rows } = await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      tx.execute<{ who: string; bypass: boolean; super: boolean }>(
        sql`SELECT current_user AS who, r.rolbypassrls AS bypass, r.rolsuper AS super FROM pg_roles r WHERE r.rolname = current_user`,
      ),
    );
    expect(rows[0]).toEqual({ who: "chartwarden_app", bypass: false, super: false });
  });
});
