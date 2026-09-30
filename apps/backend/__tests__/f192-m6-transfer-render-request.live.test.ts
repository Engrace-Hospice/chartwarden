/**
 * F-192 (#248) — `m6.transfer.created` → M22's `discharge_summary_transfer` render, proven END TO END
 * over real Postgres, closing the LAST event in M22's `handlers-unbound` group.
 *
 * Every prior pass that checked this pair (F-161/F-162/F-166/F-176) found the identical wall: the M22
 * spec itself calls the wanted artifact "discharge_summary (transfer variant)"
 * (render-consumer.ts's own header comment on `m6.discharge.created`), and no such variant existed —
 * rendering the base `discharge_summary` template would file a document titled "Discharge Summary" for
 * a patient who was TRANSFERRED, not discharged for cause/death/routine. Migration 0267 adds the
 * `discharge_summary_transfer` `document_aggregate_type` value (the F-099/F-144/F-161 additive-enum
 * precedent). `transfer_event.document_id` ("(M22) transfer summary") has carried that exact comment
 * since M6's schema landed, unread until now.
 *
 * This suite mirrors `m6-cop-document-renders.live.test.ts` (F-100) exactly, for the SEVENTH M6
 * artifact: drive the REAL M6 write service (`transferOut` / `transferIn`,
 * `admission-route-service-db.ts`) through a real admission → the REAL catalog-validating transactional
 * publisher writes the outbox row → the REAL `createOutboxDispatcher` claims and delivers it → M22's
 * real render consumer resolves the template and renders through the real `DocumentRenderer` into the
 * real Drizzle seam store → M22 announces `m22.document.rendered` → M6's real back-ref consumer stamps
 * `transfer_event.document_id`. RLS is live throughout, as the NOBYPASSRLS `wardenx_app` role.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:f192:m6-transfer-render:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { M6_OUTBOX_EVENTS, buildM6DocumentBackrefConsumer } from "../src/modules/06-admission/index";
import { M7_OUTBOX_EVENTS } from "../src/modules/07-care-plan/index";
import { M8_OUTBOX_EVENTS } from "../src/modules/08-encounters/index";
import { M9_OUTBOX_EVENTS } from "../src/modules/09-assessments/index";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/index";
import { M11_OUTBOX_EVENTS, buildM11DocumentBackrefConsumer } from "../src/modules/11-orders/index";
import { M12_OUTBOX_EVENTS, buildM12DocumentBackrefConsumer } from "../src/modules/12-dosespot/index";
import { M13_OUTBOX_EVENTS, buildM13DocumentBackrefConsumer } from "../src/modules/13-emar/index";
import { M14_OUTBOX_EVENTS } from "../src/modules/14-idg/index";
import { M15_OUTBOX_EVENTS } from "../src/modules/15-discipline-care-plans/index";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/index";
import { M17_OUTBOX_EVENTS } from "../src/modules/17-scheduling/index";
import { M18_OUTBOX_EVENTS } from "../src/modules/18-evv/index";
import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/index";
import { M21_OUTBOX_EVENTS, buildM21DocumentBackrefConsumer } from "../src/modules/21-supplies/index";
import {
  M22_DOCUMENT_RENDERED_EVENT,
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
import { M33_OUTBOX_EVENTS, buildM33DocumentBackrefConsumer } from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";

/** Clinical content every CTI draft carries (`CtiDraftInput` requires it — CtiDraftSchema, route 22). */
const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative:
    "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care.",
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const ATTENDING = "77777777-7777-7777-7777-777777777777";
const MD = "66666666-6666-6666-6666-666666666666";
const PROVIDER_ENTITY = "88888888-8888-8888-8888-888888888888";

const DRAFT = {
  electedProviderEntityId: PROVIDER_ENTITY,
  electedAttendingPhysicianId: ATTENDING,
  waiverAcknowledged: true,
} as const;
const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;

describe.skipIf(!DB_URL)("F-192 — M6 transfer summary renders + back-refs, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;

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

  /**
   * Two hops, not one — the F-100 shape. The first tick delivers the render REQUEST and M22 writes the
   * document; that render emits `m22.document.rendered` as a NEW outbox row, which the same tick has
   * already passed. The second tick delivers it to the back-ref consumers.
   */
  async function settle(): Promise<void> {
    await dispatcher.tick();
    await dispatcher.tick();
  }

  /** The rendered document for one source row (superuser read — RLS is asserted separately). */
  async function documentFor(aggregateType: string, aggregateId: string) {
    const { rows } = await admin.query(
      `SELECT id, organization_id, patient_id, retention_class FROM document
        WHERE aggregate_type=$1 AND aggregate_id=$2`,
      [aggregateType, aggregateId],
    );
    return rows[0] ?? null;
  }
  async function backref(id: string): Promise<string | null> {
    const { rows } = await admin.query(`SELECT document_id FROM transfer_event WHERE id=$1`, [id]);
    return (rows[0]?.document_id as string | null) ?? null;
  }

  /** The full §418.24 admission chain through the REAL write service, to an ACTIVE, period-1 admission
   *  ready to transfer-out (mirrors `m6-cop-document-renders.live.test.ts`'s own helper). */
  async function activeAdmission(patientId: string): Promise<{ admissionId: string }> {
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      hospicePhysicianId: MD,
      organizationId: ORG_A,
      actorUserId: USER,
      patientId,
    });
    const periods = await svc.listElectionPeriods(ORG_A, admissionId);
    const periodId = periods?.[0]?.id as string;
    const nor = await svc.acknowledgeNor(
      ORG_A,
      admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId, DRAFT);
    await svc.signElection(ORG_A, es.id, es.version, USER, SIGN);
    const cti = await svc.draftCti(
      ORG_A,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: ATTENDING,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      USER,
    );
    await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    const active = await svc.activateAdmission(ORG_A, admissionId, nor.version);
    expect(active.state).toBe("active");
    return { admissionId };
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
      `INSERT INTO "user" (id,email) VALUES ($1,'f192a@x.test'),($2,'f192md@x.test'),($3,'f192at@x.test')`,
      [USER, MD, ATTENDING],
    );
    await admin.query(
      `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,$2,'A Hospice','341234','1111111111','\\x00','12-31')`,
      [PROVIDER_ENTITY, ORG_A],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    registerM5IntakeSeams(handle.db);

    // BOTH halves of the handshake in one catalog, the F-100 shape exactly: M6's events (which M22 now
    // consumes) and M22's `document.rendered` (which M6 now consumes). The dispatcher refuses to
    // construct on an event its catalog does not carry, and holds a row `pending` while any declared
    // consumer has no live binding.
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

    svc = createDbAdmissionRouteService(
      handle.db,
      { publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m6" }) },
      undefined,
      {
        async belongsToOrg(organizationId: string, providerEntityId: string) {
          const { rows } = await admin.query(
            "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
            [providerEntityId, organizationId],
          );
          return rows.length > 0;
        },
      },
    );

    const store = createDrizzleDocumentSeamStore(handle.db);
    const objects = createInMemoryObjectStore();
    const renderConsumer = buildM22DocumentRequestConsumer({
      store,
      renderer: () => createDocumentRenderer({ store, objects: objects.store }),
      emitRendered: ({ organizationId, ...payload }) =>
        withOrgContext(handle.db, { organizationId, userId: "" }, (tx) =>
          publisher.publish(tx as never, {
            eventName: M22_DOCUMENT_RENDERED_EVENT,
            payload,
            organizationId,
            aggregateKind: "document",
            aggregateId: payload.documentId,
            callerModule: "m22",
          }),
        ),
    });

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      // `m22.document.rendered` declares SIX back-ref consumers — the F-100 comment applies verbatim:
      // binding only M6's would leave the row `pending` for a reason that has nothing to do with M6.
      consumers: [
        renderConsumer,
        buildM6DocumentBackrefConsumer({ db: handle.db }),
        buildM11DocumentBackrefConsumer({ db: handle.db }),
        buildM12DocumentBackrefConsumer({ db: handle.db }),
        buildM13DocumentBackrefConsumer({ db: handle.db }),
        buildM21DocumentBackrefConsumer({ db: handle.db }),
        buildM33DocumentBackrefConsumer({ db: handle.db }),
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  // ── transfer-out ─────────────────────────────────────────────────────────────────────────────────────

  it("transferOut requests + renders the transfer summary, and stamps transfer_event.document_id", async () => {
    const patientId = randomUUID();
    const { admissionId } = await activeAdmission(patientId);

    const xfer = await svc.transferOut(
      ORG_A,
      admissionId,
      {
        effectiveDate: "2026-06-15",
        otherHospiceName: "Sunrise Hospice",
        otherHospiceCcn: "391234",
        narrative: "patient relocated closer to family; care transferred by mutual agreement",
      },
      USER,
    );
    expect(await documentFor("discharge_summary_transfer", xfer.id)).toBeNull();

    await settle();

    const doc = await documentFor("discharge_summary_transfer", xfer.id);
    expect(doc).not.toBeNull();
    expect(doc.organization_id).toBe(ORG_A);
    expect(doc.patient_id).toBe(patientId);
    expect(doc.retention_class).toBe("clinical_record");
    expect(await backref(xfer.id)).toBe(doc.id);

    // §2.3.1 — a transfer-out does NOT create a `discharge_event` row (`dischargeAdmissionTx`'s own
    // comment: "omitted by revocation/transferOut"), so no `discharge_summary` (the BASE template) was
    // filed for this patient — only the transfer variant, never a second render of the base one.
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM document WHERE aggregate_type='discharge_summary'",
    );
    expect(rows[0].n).toBe(0);
  });

  // ── transfer-in ──────────────────────────────────────────────────────────────────────────────────────

  it("transferIn requests + renders its own transfer summary, distinct from transfer-out's", async () => {
    const patientId = randomUUID();
    const adm = await svc.createAdmission(
      ORG_A,
      { patientId, intakeMethod: "transfer_in", hospiceMedicalDirectorId: MD },
      USER,
    );
    const res = await svc.transferIn(
      ORG_A,
      adm.id,
      {
        priorBenefitPeriodSequence: 3,
        priorElectionStartDate: "2026-01-01",
        hospiceMedicalDirectorId: MD,
        effectiveDate: "2026-04-01",
        otherHospiceName: "Prior Hospice Inc",
        otherHospiceCcn: "381588",
        narrative: "patient transferred in mid-benefit-period from Prior Hospice Inc",
      },
      USER,
    );

    await settle();

    const doc = await documentFor("discharge_summary_transfer", res.id);
    expect(doc).not.toBeNull();
    expect(doc.patient_id).toBe(patientId);
    expect(await backref(res.id)).toBe(doc.id);

    const { rows } = await admin.query("SELECT direction FROM transfer_event WHERE id=$1", [res.id]);
    expect(rows[0].direction).toBe("in");
  });

  // ── idempotency ──────────────────────────────────────────────────────────────────────────────────────

  it("a re-delivered request renders no second document and does not re-stamp", async () => {
    const patientId = randomUUID();
    const { admissionId } = await activeAdmission(patientId);
    const xfer = await svc.transferOut(
      ORG_A,
      admissionId,
      {
        effectiveDate: "2026-07-01",
        otherHospiceName: "Second Hospice",
        narrative: "patient relocated for a second, independent transfer scenario",
      },
      USER,
    );
    await settle();
    const first = await documentFor("discharge_summary_transfer", xfer.id);
    expect(first).not.toBeNull();

    await settle();
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM document WHERE aggregate_type='discharge_summary_transfer' AND aggregate_id=$1",
      [xfer.id],
    );
    expect(rows[0].n).toBe(1);
    expect(await backref(xfer.id)).toBe(first.id);
  });

  // ── tenancy ──────────────────────────────────────────────────────────────────────────────────────────

  it("renders under the requesting org only — org B never sees org A's F-192 documents", async () => {
    const { rows } = await admin.query(
      `SELECT DISTINCT organization_id FROM document WHERE aggregate_type = 'discharge_summary_transfer'`,
    );
    expect(rows.map((r) => r.organization_id)).toEqual([ORG_A]);

    const b = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await b.connect();
    try {
      await b.query("BEGIN");
      await b.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
      const { rows: seen } = await b.query(
        `SELECT count(*)::int AS n FROM document WHERE aggregate_type = 'discharge_summary_transfer'`,
      );
      expect(seen[0].n).toBe(0);
      await b.query("COMMIT");
    } finally {
      await b.end();
    }
  });
});
