/**
 * F-225 (#248) — the portal document download is ACCOUNTED (HIPAA §164.528), proven against real Postgres
 * as the NOBYPASSRLS `wardenx_app` role, through the real M31 route, the real M22 `PortalDocumentReader`
 * (Drizzle reader store + Drizzle access-log writer + the SigV4 presigner) and the real M4 read-audit hook.
 *
 * What this pins (F-221 found every one of these false on the prior code):
 *   • an authorized download returns a usable, real-object, 60-minute URL AND appends exactly one
 *     `document_access_log` row (ids only: org, document, version, portal account, session, patient);
 *   • a repeat mint appends another row;
 *   • every refusal (other patient's / other org's / not-patient-facing / superseded / SUD without consent /
 *     malformed id / a session anchored to another patient) is a 404 with NO url, NO `document_access_log`
 *     row and NO M4 `portal_document` read row — the ledger records only actual disclosures;
 *   • the M4 read row carries the DOCUMENT id (`resource_id`) and the session patient;
 *   • cross-tenant isolation of the ledger, and the ledger is append-only for the app role (no UPDATE /
 *     DELETE, on the parent or on a partition child).
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run \
 *     apps/backend/__tests__/f225-portal-document-access-log.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, buildServer, registerSeam } from "../src/bootstrap/index";
import { buildPortalDisclosureReader } from "../src/modules/22-documents/access-log/portal-disclosures";
import {
  createDrizzleDocumentReaderStore,
  createDrizzlePortalAccessLog,
} from "../src/modules/22-documents/seams/drizzle-readers-store";
import {
  createInMemoryPortalConsentPort,
  createPortalDocumentReader,
  createS3ObjectStore,
} from "../src/modules/22-documents/seams/index";
import { registerPortalReadRoutes } from "../src/modules/31-portal/routes/read.routes";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";
const USER_B = "33333333-3333-4333-8333-444444444444";
const MEMBERSHIP = "44444444-4444-4444-8444-444444444444";
const PATIENT_1 = "55555555-5555-4555-8555-555555555555";
const PATIENT_2 = "55555555-5555-4555-8555-666666666666";
const ACCOUNT = "66666666-6666-4666-8666-666666666666";
const SESSION = "77777777-7777-4777-8777-777777777777";
const SESSION_2 = "77777777-7777-4777-8777-888888888888";

function portalAuth(request: FastifyRequest): void {
  const h = request.headers;
  const get = (k: string): string | undefined =>
    typeof h[k] === "string" && (h[k] as string).length > 0 ? (h[k] as string) : undefined;
  request.context.userId = get("x-test-user") ?? USER_A;
  request.context.organizationId = get("x-test-org") ?? ORG_A;
  request.context.roles = ["seed"];
  request.context.attributes.sessionClass = "caregiver_portal";
  request.context.attributes.portalAccountId = ACCOUNT;
  const patient = get("x-test-patient");
  if (patient) request.context.attributes.sessionPatientId = patient;
  const session = get("x-test-session");
  if (session) request.context.attributes.sessionId = session;
}
/** drizzle wraps the driver error ("Failed query: …"); the SQLSTATE text lives on `cause`. */
async function expectPermissionDenied(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (err) {
    const msg = `${(err as Error).message} ${(err as { cause?: Error }).cause?.message ?? ""}`;
    expect(msg).toMatch(/permission denied/i);
    return;
  }
  throw new Error("expected permission denied, but the statement succeeded");
}
const AUTH = { "x-test-patient": PATIENT_1, "x-test-session": SESSION };

describe.skipIf(!DB_URL)("F-225 portal document access log — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let seq = 0;
  let consent: Record<string, boolean> = {};

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  const peByOrg = new Map<string, { pe: string; loc: string }>();
  async function scope(org: string) {
    const cached = peByOrg.get(org);
    if (cached) return cached;
    const n = ++seq;
    const pe = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-F225-${n}`, `F225 ${n}`, `NPI-F225-${n}`],
      )
    ).rows[0].id as string;
    const loc = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [pe, `Loc-F225-${n}`],
      )
    ).rows[0].id as string;
    const v = { pe, loc };
    peByOrg.set(org, v);
    return v;
  }

  async function seedDocument(a: {
    org: string;
    patientId: string;
    patientFacing?: boolean;
    sud?: boolean;
    status?: string;
  }) {
    const { pe, loc } = await scope(a.org);
    const n = ++seq;
    const doc = (
      await admin.query(
        `INSERT INTO document (organization_id, patient_id, provider_entity_id, location_id, retention_class,
           source_kind, aggregate_type, title, patient_facing, created_by_membership_id, metadata, status)
         VALUES ($1,$2,$3,$4,'clinical_record','user_upload','other','F225 doc',$5,$6,$7,$8) RETURNING id`,
        [
          a.org,
          a.patientId,
          pe,
          loc,
          a.patientFacing ?? true,
          MEMBERSHIP,
          a.sud ? JSON.stringify({ sudRedacted: true }) : null,
          a.status ?? "active",
        ],
      )
    ).rows[0].id as string;
    const version = async (num: number) =>
      (
        await admin.query(
          `INSERT INTO document_version (organization_id, document_id, version_number, minio_object_key,
             mime_type, byte_size, sha256_hex, uploaded_by_kind)
           VALUES ($1,$2,$3,$4,'application/pdf','1024','abc123','system') RETURNING id`,
          [a.org, doc, String(num), `rendered/f225-${n}-v${num}.pdf`],
        )
      ).rows[0].id as string;
    const v1 = await version(1);
    await admin.query("UPDATE document SET active_version_id = $1 WHERE id = $2", [v1, doc]);
    return {
      documentId: doc,
      v1,
      objectKey: `rendered/f225-${n}-v1.pdf`,
      async addVersion2() {
        const v2 = await version(2);
        await admin.query("UPDATE document SET active_version_id = $1 WHERE id = $2", [v2, doc]);
        return { v2, objectKey: `rendered/f225-${n}-v2.pdf` };
      },
    };
  }

  const logRows = async (org = ORG_A) =>
    (
      await admin.query(
        `SELECT id, organization_id, document_id, document_version_id, accessor_membership_id,
                accessor_portal_account_id, portal_session_id, patient_id, access_kind, purpose, correlation_id
           FROM document_access_log WHERE organization_id = $1 ORDER BY accessed_at, id`,
        [org],
      )
    ).rows;
  const m4Rows = async () =>
    (
      await admin.query(
        `SELECT resource_id::text, resource_kind, context FROM audit_event
          WHERE organization_id = $1 AND resource_kind = 'portal_document' ORDER BY created_at`,
        [ORG_A],
      )
    ).rows;

  function makeApp() {
    const store = createInMemoryEffectivePermissionStore([
      {
        orgId: ORG_A,
        userId: USER_A,
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["portal.documents.download"],
          },
        ],
      },
    ]);
    registerEffectivePermissionResolver(store.store);
    const reg = createPredicateRegistry();
    // The §4.7 grant predicate is M31's own (covered by its suites); here it only needs a patient anchor.
    reg.register("portal_grant_active_for_patient", async (_ctx, target) => {
      const patientId = (target as { patientId?: unknown }).patientId;
      return typeof patientId === "string" && patientId.length > 0;
    });
    registerAbacRegistry(reg);
    __resetSeamsForTest();
    registerSeam(
      "PortalDocumentReader",
      createPortalDocumentReader({
        store: createDrizzleDocumentReaderStore(handle.db),
        objects: createS3ObjectStore({
          endpoint: "http://127.0.0.1:9",
          accessKeyId: "AKIAF225",
          secretAccessKey: "secret-f225",
        }),
        consent: createInMemoryPortalConsentPort(consent),
        accessLog: createDrizzlePortalAccessLog(handle.db),
      }),
    );
    const app = buildServer({
      db: handle.db,
      authenticate: portalAuth,
      security: { rateLimitEnabled: false },
    });
    registerPortalReadRoutes(app, { now: () => new Date() } as never);
    return app;
  }

  const get = (
    app: ReturnType<typeof makeApp>,
    documentId: string,
    headers: Record<string, string> = AUTH,
  ) =>
    app.inject({
      method: "GET",
      url: `/api/v1/portal/documents/${documentId}/download-url`,
      headers,
    });

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
      `INSERT INTO "user" (id,email) VALUES ($1,'a225@x.test'),($2,'b225@x.test')`,
      [USER_A, USER_B],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    resetAuthorizationContract();
    resetRbacEngine();
    consent = {};
    await admin.query("DELETE FROM document_access_log");
    await admin.query("DELETE FROM audit_event WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
  });

  it("an authorized download mints a real 60-min URL, writes EXACTLY ONE ids-only log row and one M4 row carrying the document id", async () => {
    const d = await seedDocument({ org: ORG_A, patientId: PATIENT_1 });
    const app = makeApp();
    const res = await get(app, d.documentId);
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.patientId).toBe(PATIENT_1);
    // a usable URL: the REAL stored object key, tenant bucket, 3600s TTL (M31 spec: 60 min per mint)
    expect(body.url).toContain(`tenant-${ORG_A}`);
    expect(body.url).toContain(d.objectKey);
    expect(body.url).toContain("X-Amz-Expires=3600");
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now() + 59 * 60_000);

    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organization_id: ORG_A,
      document_id: d.documentId,
      document_version_id: d.v1,
      accessor_membership_id: null,
      accessor_portal_account_id: ACCOUNT,
      portal_session_id: SESSION,
      patient_id: PATIENT_1,
      access_kind: "portal_view",
      purpose: "patient_access",
    });
    // the ledger's own M4 write-audit trigger fired (append is itself audited, PHI-free)
    const trig = await admin.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND event_type='document_access_log.insert'`,
      [ORG_A],
    );
    expect(trig.rows[0].n).toBe(1);

    // GAP-052: the §164.528 accounting reader returns that ledger row for the patient (and none for another org)
    const window = [new Date(Date.now() - 3_600_000), new Date(Date.now() + 3_600_000)] as const;
    const reader = buildPortalDisclosureReader(handle.db);
    const lines = await reader(ORG_A, PATIENT_1, ...window);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      portalAccountId: ACCOUNT,
      patientId: PATIENT_1,
      documentId: d.documentId,
      accessKind: "portal_view",
    });
    expect(await reader(ORG_B, PATIENT_1, ...window)).toHaveLength(0);
    expect(await reader(ORG_A, PATIENT_2, ...window)).toHaveLength(0);

    // M4 route read-audit: one row, resource = the DOCUMENT, patient = the session patient
    const m4 = await m4Rows();
    expect(m4).toHaveLength(1);
    expect(m4[0].resource_id).toBe(d.documentId);
    expect(m4[0].context.patientId).toBe(PATIENT_1);
  });

  it("a repeat mint appends another row (and another M4 row)", async () => {
    const d = await seedDocument({ org: ORG_A, patientId: PATIENT_1 });
    const app = makeApp();
    expect((await get(app, d.documentId)).statusCode).toBe(200);
    expect((await get(app, d.documentId)).statusCode).toBe(200);
    await app.close();
    expect(await logRows()).toHaveLength(2);
    expect(await m4Rows()).toHaveLength(2);
  });

  it("a superseded-then-new version: the mint targets the ACTIVE (governed) version and logs ITS id", async () => {
    const d = await seedDocument({ org: ORG_A, patientId: PATIENT_1 });
    const { v2, objectKey } = await d.addVersion2();
    const app = makeApp();
    const res = await get(app, d.documentId);
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toContain(objectKey);
    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].document_version_id).toBe(v2);
  });

  it("every refusal is a 404 with no url, no ledger row and no M4 read row", async () => {
    const other = await seedDocument({ org: ORG_A, patientId: PATIENT_2 });
    const internal = await seedDocument({ org: ORG_A, patientId: PATIENT_1, patientFacing: false });
    const sud = await seedDocument({ org: ORG_A, patientId: PATIENT_1, sud: true });
    const superseded = await seedDocument({
      org: ORG_A,
      patientId: PATIENT_1,
      status: "superseded",
    });
    const foreignOrg = await seedDocument({ org: ORG_B, patientId: PATIENT_1 });
    const mine = await seedDocument({ org: ORG_A, patientId: PATIENT_1 });
    const app = makeApp();
    const cases: Array<[string, string, Record<string, string>?]> = [
      ["other patient's document", other.documentId],
      ["not patient-facing", internal.documentId],
      ["SUD class, consent absent", sud.documentId],
      ["superseded document", superseded.documentId],
      ["other org's document", foreignOrg.documentId],
      ["unknown id", "99999999-9999-4999-8999-999999999999"],
      ["malformed id", "not-a-uuid"],
      // a session anchored to PATIENT_2 naming PATIENT_1's own document
      [
        "wrong session patient",
        mine.documentId,
        { ...AUTH, "x-test-patient": PATIENT_2, "x-test-session": SESSION_2 },
      ],
    ];
    for (const [label, id, headers] of cases) {
      const res = await get(app, id, headers);
      expect(res.statusCode, label).toBe(404);
      expect(res.json().url, label).toBeUndefined();
    }
    // no session anchor at all: refused before any M22 call
    const noSession = await get(app, mine.documentId, { "x-test-patient": PATIENT_1 });
    expect(noSession.statusCode).toBe(403);
    await app.close();
    expect(await logRows()).toEqual([]);
    expect(await logRows(ORG_B)).toEqual([]);
    expect(await m4Rows()).toEqual([]);
  });

  it("SUD-class content is disclosed only while consent is ACTIVE, and only then is it logged", async () => {
    const sud = await seedDocument({ org: ORG_A, patientId: PATIENT_1, sud: true });
    const app = makeApp();
    expect((await get(app, sud.documentId)).statusCode).toBe(404);
    expect(await logRows()).toHaveLength(0);
    consent = { [PATIENT_1]: true };
    // re-register a reader over the new consent map
    const app2 = makeApp();
    expect((await get(app2, sud.documentId)).statusCode).toBe(200);
    await app.close();
    await app2.close();
    expect(await logRows()).toHaveLength(1);
  });

  it("ledger rows are tenant-isolated: org B's context sees none of org A's rows, and cannot forge one into org A", async () => {
    const d = await seedDocument({ org: ORG_A, patientId: PATIENT_1 });
    const app = makeApp();
    expect((await get(app, d.documentId)).statusCode).toBe(200);
    await app.close();
    const asA = await withOrgContext(handle.db, { organizationId: ORG_A, userId: USER_A }, (tx) =>
      tx.execute(sql`SELECT id FROM document_access_log`),
    );
    const asB = await withOrgContext(handle.db, { organizationId: ORG_B, userId: USER_B }, (tx) =>
      tx.execute(sql`SELECT id FROM document_access_log`),
    );
    expect(asA.rows ?? asA).toHaveLength(1);
    expect(asB.rows ?? asB).toHaveLength(0);
    await expect(
      withOrgContext(handle.db, { organizationId: ORG_B, userId: USER_B }, (tx) =>
        tx.execute(sql`INSERT INTO document_access_log
          (organization_id, document_id, document_version_id, accessor_portal_account_id, access_kind, purpose, correlation_id)
          VALUES (${ORG_A}, ${d.documentId}, ${d.v1}, ${ACCOUNT}, 'portal_view', 'patient_access', 'forge')`),
      ),
    ).rejects.toThrow();
  });

  it("the ledger is append-only for the app role: no UPDATE, no DELETE (parent or partition child), and exactly one accessor kind", async () => {
    const d = await seedDocument({ org: ORG_A, patientId: PATIENT_1 });
    const app = makeApp();
    expect((await get(app, d.documentId)).statusCode).toBe(200);
    await app.close();
    const ctx = { organizationId: ORG_A, userId: USER_A };
    await expectPermissionDenied(
      withOrgContext(handle.db, ctx, (tx) =>
        tx.execute(sql`UPDATE document_access_log SET purpose = 'treatment'`),
      ),
    );
    await expectPermissionDenied(
      withOrgContext(handle.db, ctx, (tx) => tx.execute(sql`DELETE FROM document_access_log`)),
    );
    await expectPermissionDenied(
      withOrgContext(handle.db, ctx, (tx) =>
        tx.execute(sql`DELETE FROM document_access_log_default`),
      ),
    );
    // nothing changed
    expect((await logRows())[0].purpose).toBe("patient_access");
    // a row with neither / both accessors violates the CHECK
    const base = `INSERT INTO document_access_log (organization_id, document_id, document_version_id,
      accessor_membership_id, accessor_portal_account_id, access_kind, purpose, correlation_id)
      VALUES ('${ORG_A}','${d.documentId}','${d.v1}',`;
    await expect(
      admin.query(`${base} NULL, NULL, 'portal_view','patient_access','c')`),
    ).rejects.toThrow(/one_accessor/);
    await expect(
      admin.query(`${base} '${MEMBERSHIP}', '${ACCOUNT}', 'portal_view','patient_access','c')`),
    ).rejects.toThrow(/one_accessor/);
  });
});
