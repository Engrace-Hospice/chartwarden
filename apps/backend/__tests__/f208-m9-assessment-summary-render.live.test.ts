/**
 * F-208 (#248) — `m9.assessment.summary_requested` → M22's `assessment_summary` render, proven END TO
 * END over real Postgres, closing the last event in M22's `handlers-unbound` group.
 *
 * The payload (`{patientId, asOfDate, scales, lang}`) carries no per-request/assessment id, so the user
 * decided the open versioning question F-168/F-170 left standing: treat "the assessment summary" as ONE
 * evolving per-patient document (`assessment_summary`, mig 0277), never one per `asOfDate`. Two real M9
 * producer call sites now emit the request:
 *
 *   1. AUTO-REFRESH — `AssessmentRouteService.summary()` (the chart-open read, `GET .../assessments
 *      /summary`) emits a fresh request whenever the most recent ACTIVE assessment was captured within
 *      `SUMMARY_AUTO_REFRESH_WINDOW_MS` (24h) of now — a freshness throttle, not a new per-patient dedup
 *      table, so a long-settled patient's chart does not mint a new document version on every open.
 *   2. EXPLICIT DOWNLOAD/PRINT — the new `POST .../assessments/summary/document` route
 *      (`requestSummaryDocument`) always emits, unconditionally, since the caller asked directly.
 *
 * Both drive the REAL `createDbAssessmentRouteService` → the REAL catalog-validating transactional
 * publisher → the REAL `createOutboxDispatcher` → M22's real render consumer resolves the
 * `assessment_summary` template and renders through the real `DocumentRenderer` into the real Drizzle
 * seam store, under RLS as the NOBYPASSRLS `wardenx_app` role. F-168's per-source-event-id append
 * mechanism is proven directly: two fresh chart-opens render TWO document versions of the SAME
 * `(aggregate_type, aggregate_id)`, never an `idempotent_skip`.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:f208:m9-assessment-summary-render:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M6_OUTBOX_EVENTS } from "../src/modules/06-admission/index";
import { M7_OUTBOX_EVENTS } from "../src/modules/07-care-plan/index";
import { M8_OUTBOX_EVENTS } from "../src/modules/08-encounters/index";
import {
  type AssessmentWriteOutboxPort,
  M9_OUTBOX_EVENTS,
  createDbAssessmentRouteService,
} from "../src/modules/09-assessments/index";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/index";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { M14_OUTBOX_EVENTS } from "../src/modules/14-idg/index";
import { M15_OUTBOX_EVENTS } from "../src/modules/15-discipline-care-plans/index";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/index";
import { M17_OUTBOX_EVENTS } from "../src/modules/17-scheduling/index";
import { M18_OUTBOX_EVENTS } from "../src/modules/18-evv/index";
import { M19_OUTBOX_EVENTS } from "../src/modules/19-oncall/index";
import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/index";
import { M21_OUTBOX_EVENTS } from "../src/modules/21-supplies/index";
import {
  M22_OUTBOX_EVENTS,
  buildM22DocumentRequestConsumer,
  createDocumentRenderer,
  createDrizzleDocumentSeamStore,
  createInMemoryObjectStore,
} from "../src/modules/22-documents/index";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/index";
import { M24_OUTBOX_EVENTS } from "../src/modules/24-billing-medicaid/index";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { M27_OUTBOX_EVENTS } from "../src/modules/27-cost-report/index";
import { M33_OUTBOX_EVENTS } from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

/** A PAINAD payload scoring 5/10 — no license required (unlike PPS), keeps setup minimal. */
const PAINAD = {
  breathing: 1,
  negativeVocalization: 1,
  facialExpression: 1,
  bodyLanguage: 1,
  consolability: 1,
};

describe.skipIf(!DB_URL)("F-208 — M9 assessment-summary render, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAssessmentRouteService>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let recorder = "";

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
  async function membership(org: string, user: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [user, org],
      )
    ).rows[0].id as string;
  }
  /** Two ticks: the request lands on the first, M22's render is synchronous within `handle()` (no
   *  second-hop back-ref chain here — M9 has no `document_id` column to stamp), so one tick suffices in
   *  practice; two is the F-192/F-168 standing convention and costs nothing extra. */
  async function settle(): Promise<void> {
    await dispatcher.tick();
    await dispatcher.tick();
  }
  async function versionsFor(aggregateId: string) {
    const { rows } = await admin.query(
      `SELECT d.id AS document_id, d.organization_id, d.aggregate_type, d.patient_id,
              v.id AS version_id, v.version_number
         FROM document d JOIN document_version v ON v.document_id = d.id
        WHERE d.aggregate_id=$1 AND d.aggregate_type='assessment_summary' ORDER BY v.version_number::int`,
      [aggregateId],
    );
    return rows as {
      document_id: string;
      organization_id: string;
      aggregate_type: string;
      patient_id: string | null;
      version_id: string;
      version_number: string;
    }[];
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f208@x.test')`, [USER]);
    recorder = await membership(ORG_A, USER);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // The M22 render consumer's `eventTypes` is the WHOLE `M22_DOCUMENT_REQUEST_EVENTS` array (every
    // module it renders for, not only M9's), and `createOutboxDispatcher` validates every bound event
    // type against the catalog at construction time — so the full producer set is required even though
    // this suite only ever publishes M9's one event (the F-192/F-168 precedent).
    const catalog = buildBootOutboxCatalog([
      M6_OUTBOX_EVENTS,
      M7_OUTBOX_EVENTS,
      M8_OUTBOX_EVENTS,
      M9_OUTBOX_EVENTS,
      M10_OUTBOX_EVENTS,
      M11_OUTBOX_EVENTS,
      M12_OUTBOX_EVENTS,
      M13_OUTBOX_EVENTS,
      M14_OUTBOX_EVENTS,
      M15_OUTBOX_EVENTS,
      M16_OUTBOX_EVENTS,
      M17_OUTBOX_EVENTS,
      M18_OUTBOX_EVENTS,
      M19_OUTBOX_EVENTS,
      M20_OUTBOX_EVENTS,
      M21_OUTBOX_EVENTS,
      M22_OUTBOX_EVENTS,
      M23_OUTBOX_EVENTS,
      M24_OUTBOX_EVENTS,
      M25_OUTBOX_EVENTS,
      M27_OUTBOX_EVENTS,
      M33_OUTBOX_EVENTS,
      M37_OUTBOX_EVENTS,
    ]);
    const publisher = buildTxOutboxPublisher(catalog);
    const outbox: AssessmentWriteOutboxPort = {
      publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m9" }),
    };
    // GAP-016 admission-anchor gate — fail-closed without a resolver; stub it active so `recordAssessment`
    // succeeds seeding test data (the m9-assessments-write.live.test.ts precedent).
    svc = createDbAssessmentRouteService(handle.db, outbox, {
      resolve: async () => ({ providerEntityId: null, locationId: null }),
      resolveAnchor: async () => ({
        siting: { providerEntityId: null, locationId: null },
        anchor: { status: "active", activatedAt: "2020-01-01" },
      }),
    });

    const store = createDrizzleDocumentSeamStore(handle.db);
    const objects = createInMemoryObjectStore();
    const renderConsumer = buildM22DocumentRequestConsumer({
      store,
      renderer: () => createDocumentRenderer({ store, objects: objects.store }),
    });

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [renderConsumer],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  const recordArgs = (capturedAt: string, over: Record<string, unknown> = {}) => ({
    admissionId: ADMISSION,
    scaleType: "painad" as never,
    capturedAt,
    data: PAINAD,
    recorderDiscipline: "rn",
    ...over,
  });

  it("chart-open auto-refresh: a FRESH assessment triggers the render, and a second open appends a second version (F-168)", async () => {
    const patientId = randomUUID();
    const fresh = new Date().toISOString();
    await svc.recordAssessment(ORG_A, recorder, patientId, recordArgs(fresh));

    const first = await svc.summary(ORG_A, patientId);
    expect(first.latest).toHaveLength(1);
    await settle();
    const v1 = await versionsFor(patientId);
    expect(v1.map((v) => v.version_number)).toEqual(["1"]);
    expect(v1[0]?.organization_id).toBe(ORG_A);
    expect(v1[0]?.patient_id).toBe(patientId);

    // A second chart-open, still within the freshness window, renders a NEW version — never
    // idempotent_skip — proving the F-168 per-source-event-id append mechanism, not the old
    // per-aggregate dedup that would have silently no-op'd this.
    await svc.summary(ORG_A, patientId);
    await settle();
    const v2 = await versionsFor(patientId);
    expect(v2.map((v) => v.version_number)).toEqual(["1", "2"]);
  });

  it("chart-open auto-refresh: a STALE assessment (outside the freshness window) does NOT re-request", async () => {
    const patientId = randomUUID();
    const stale = "2020-01-01T00:00:00.000Z";
    await svc.recordAssessment(ORG_A, recorder, patientId, recordArgs(stale));

    await svc.summary(ORG_A, patientId);
    await settle();
    expect(await versionsFor(patientId)).toHaveLength(0);
  });

  it("a patient with no assessments never requests a render (nothing to summarize)", async () => {
    const patientId = randomUUID();
    const empty = await svc.summary(ORG_A, patientId);
    expect(empty.latest).toHaveLength(0);
    await settle();
    expect(await versionsFor(patientId)).toHaveLength(0);
  });

  it("explicit download/print: requests unconditionally even for a STALE patient", async () => {
    const patientId = randomUUID();
    const stale = "2020-01-01T00:00:00.000Z";
    await svc.recordAssessment(ORG_A, recorder, patientId, recordArgs(stale));

    const ack = await svc.requestSummaryDocument(ORG_A, patientId);
    expect(ack).toEqual({ requested: true });
    await settle();
    const versions = await versionsFor(patientId);
    expect(versions.map((v) => v.version_number)).toEqual(["1"]);
  });

  it("cross-tenant isolation: ORG_B never sees ORG_A's rendered summary", async () => {
    const patientId = randomUUID();
    const fresh = new Date().toISOString();
    await svc.recordAssessment(ORG_A, recorder, patientId, recordArgs(fresh));
    await svc.summary(ORG_A, patientId);
    await settle();
    expect(await versionsFor(patientId)).toHaveLength(1);

    const { rows } = await admin.query(
      `SELECT 1 FROM document WHERE aggregate_id=$1 AND aggregate_type='assessment_summary' AND organization_id=$2`,
      [patientId, ORG_B],
    );
    expect(rows).toHaveLength(0);
  });
});
