/**
 * GAP-023 / GAP-024 / GAP-038 — the §4.11 document-render handshake, END TO END over real Postgres.
 *
 * The three gaps were one broken chain with a missing link at BOTH ends:
 *   · GAP-023/024 — M11 and M12 declared `*.document_requested` as a "mirror of signed" and never emitted
 *     it, so a signed order's PDF was never requested.
 *   · GAP-038 — M22's consumer allowlist named `m23.abn.document_requested`; M23's catalog declares
 *     `m23.abn.required`. Neither name could ever be delivered.
 *   · And underneath both: NOTHING consumed any `*.document_requested` row at all
 *     (`M22_DOCUMENT_REQUEST_BINDINGS_DEFERRED` was `true`), so even M13's genuine emission sat `pending`
 *     forever. Fixing only the emit side would have moved the silence one hop downstream.
 *
 * So this suite proves the WHOLE chain with nothing stubbed but the object bytes: sign an order through
 * the real Drizzle write service as the NOBYPASSRLS `wardenx_app` role → the real transactional outbox
 * publisher writes the row → the REAL `createOutboxDispatcher` claims and delivers it → M22's real render
 * consumer resolves the template, renders through the real `DocumentRenderer`, and the real Drizzle seam
 * store writes `document` + `document_version`. RLS is live throughout; org B must see none of it.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m22:render-handshake:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import {
  type OrderWriteOutboxPort,
  createDbOrderBackend,
} from "../src/modules/11-orders/orders-route-service-db";
import {
  type DoseSpotWriteOutboxPort,
  createDbDoseSpotBackend,
} from "../src/modules/12-dosespot/dosespot-route-service-db";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import {
  buildM22DocumentRequestConsumer,
  createDocumentRenderer,
  createDrizzleDocumentSeamStore,
  createInMemoryObjectStore,
} from "../src/modules/22-documents/index";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const PHYSICIAN_MDM = "66666666-6666-6666-6666-666666666666";
const ABN_ID = "77777777-7777-7777-7777-777777777777";

describe.skipIf(!DB_URL)("GAP-023/024/038 — §4.11 render handshake, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let orders: ReturnType<typeof createDbOrderBackend>;
  let meds: ReturnType<typeof createDbDoseSpotBackend>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let objects: ReturnType<typeof createInMemoryObjectStore>;
  const memberOf: Record<string, string> = {};
  /** Every template key the consumer actually asked the renderer for, in order. */
  const renderedKeys: string[] = [];

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

  /** Every outbox row for one aggregate, with its dispatch status (the relay's own record). */
  async function outboxFor(aggregateId: string): Promise<{ type: string; status: string }[]> {
    const { rows } = await admin.query(
      "SELECT event_type, status FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => ({ type: r.event_type as string, status: r.status as string }));
  }
  /** The rendered document rows for one source aggregate (superuser read — RLS is asserted separately). */
  async function documentsFor(aggregateId: string) {
    const { rows } = await admin.query(
      `SELECT d.id, d.organization_id, d.aggregate_type, d.patient_id, d.retention_class, d.title,
              v.version_number, v.mime_type, v.byte_size, v.uploaded_by_kind
         FROM document d JOIN document_version v ON v.document_id = d.id
        WHERE d.aggregate_id=$1 ORDER BY v.version_number`,
      [aggregateId],
    );
    return rows;
  }
  /** Publish one outbox row directly, as a source module's transactional publisher would. */
  async function seedOutboxRow(e: {
    eventType: string;
    aggregateKind: string;
    aggregateId: string;
    payload: unknown;
    organizationId: string;
  }) {
    await admin.query(
      `INSERT INTO outbox_event (organization_id, event_type, aggregate_kind, aggregate_id, payload, status)
       VALUES ($1,$2,$3,$4,$5,'pending')`,
      [e.organizationId, e.eventType, e.aggregateKind, e.aggregateId, JSON.stringify(e.payload)],
    );
  }

  const draftArgs = (over: Record<string, unknown> = {}) => ({
    patientId: PATIENT,
    admissionId: ADMISSION,
    kind: "dme" as const,
    drafterDiscipline: "rn_case_manager",
    data: { hcpcs: "E0260" },
    orderingPhysicianMdmId: PHYSICIAN_MDM,
    ...over,
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'render@x.test')`, [USER]);
    for (const org of [ORG_A, ORG_B]) {
      memberOf[org] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, org],
        )
      ).rows[0].id as string;
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // The REAL catalog-validating transactional publisher — the same one boot binds. A payload that does
    // not match the module's declared schema is refused here, so the emissions under test are contract-checked.
    // M13 is here because `createOutboxDispatcher` REFUSES to construct when a consumer binds an event
    // type absent from the catalog it is given ("binds unknown catalog event"). That refusal is why the
    // §4.11 subscription list had to be trimmed to names some module genuinely declares before this
    // consumer could go live at all: the five phantom names it used to carry would have crashed boot.
    const catalog = buildBootOutboxCatalog([
      M11_OUTBOX_EVENTS,
      M12_OUTBOX_EVENTS,
      M13_OUTBOX_EVENTS,
      M23_OUTBOX_EVENTS,
    ]);
    const txPublisher = buildTxOutboxPublisher(catalog);
    const m11Outbox: OrderWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m11" }),
    };
    orders = createDbOrderBackend(handle.db, m11Outbox);
    const m12Outbox: DoseSpotWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m12" }),
    };
    meds = createDbDoseSpotBackend(handle.db, m12Outbox);

    // The real render path: Drizzle document-row store + the real renderer. Only the OBJECT BYTES are
    // in-memory — production binds MinIO/S3 there, and this suite is about the row landing, not the blob.
    objects = createInMemoryObjectStore();
    const store = createDrizzleDocumentSeamStore(handle.db);
    const renderer = createDocumentRenderer({ store, objects: objects.store });
    const consumer = buildM22DocumentRequestConsumer({
      store,
      renderer: () => ({
        render: (scope, templateKey, payload) => {
          renderedKeys.push(templateKey);
          return renderer.render(scope, templateKey, payload);
        },
      }),
    });

    // Stub enumerator only — no platform credential needed to exercise per-org claim/deliver/finalize.
    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [consumer],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  // ── GAP-023 ──────────────────────────────────────────────────────────────────────────────────────────

  it("a signed order requests its PDF, and the dispatcher renders it into document/document_version", async () => {
    const draft = await orders.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
    await orders.requestSignature(ORG_A, draft.id, { signerDiscipline: "rn_case_manager" });
    await orders.signOrder(ORG_A, memberOf[ORG_A], draft.id, {
      signerDiscipline: "rn_case_manager",
      signedAtClient: new Date().toISOString(),
    });

    // The emission GAP-023 says never happened.
    const emitted = await outboxFor(draft.id);
    expect(emitted.map((e) => e.type)).toContain("m11.order.document_requested");
    expect(await documentsFor(draft.id)).toHaveLength(0); // nothing rendered until the relay runs

    await dispatcher.tick();

    const docs = await documentsFor(draft.id);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("order_record");
    expect(docs[0].organization_id).toBe(ORG_A);
    // The order's patient must reach the document row — a chart artifact filed under NULL is not filed.
    expect(docs[0].patient_id).toBe(PATIENT);
    expect(docs[0].retention_class).toBe("clinical_record");
    expect(Number(docs[0].version_number)).toBe(1);
    expect(docs[0].mime_type).toBe("application/pdf");
    expect(Number(docs[0].byte_size)).toBeGreaterThan(0);
    expect(docs[0].uploaded_by_kind).toBe("system_render");
    // The bytes went to the object store under the row's key, not just the catalog.
    expect(objects.objects.size).toBeGreaterThan(0);
    // The relay recorded the delivery: the request row is no longer pending.
    const after = await outboxFor(draft.id);
    expect(after.find((e) => e.type === "m11.order.document_requested")?.status).toBe("dispatched");
  });

  // D14 — the dispatcher redelivers after any crash between render and receipt; the rendered row is the
  // durable dedup key, so a replay must not mint a second document or a second version.
  it("re-delivering the same request renders nothing new (D14 idempotency)", async () => {
    const draft = await orders.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
    await orders.requestSignature(ORG_A, draft.id, { signerDiscipline: "rn_case_manager" });
    await orders.signOrder(ORG_A, memberOf[ORG_A], draft.id, {
      signerDiscipline: "rn_case_manager",
      signedAtClient: new Date().toISOString(),
    });
    await dispatcher.tick();
    expect(await documentsFor(draft.id)).toHaveLength(1);

    // Replay the very same request payload as a fresh delivery.
    await seedOutboxRow({
      organizationId: ORG_A,
      eventType: "m11.order.document_requested",
      aggregateKind: "order",
      aggregateId: draft.id,
      payload: {
        orderId: draft.id,
        formTemplate: "order_record",
        renderPayload: { patientId: PATIENT, kind: "dme" },
      },
    });
    await dispatcher.tick();
    expect(await documentsFor(draft.id)).toHaveLength(1); // still ONE version, not two
  });

  // ── GAP-024 ──────────────────────────────────────────────────────────────────────────────────────────

  it("a signed medication order renders its medication_order PDF", async () => {
    const draft = await meds.createDraft(ORG_A, memberOf[ORG_A], {
      patientId: PATIENT,
      admissionId: ADMISSION,
      medClass: "standard" as const,
      rxnormRxcui: "1049502",
      ndc: null,
      drugName: "Morphine",
      strength: "5 mg",
      doseForm: "tablet",
      route: "oral",
      data: { sig_free_text: "1 tab PO q6h PRN pain" },
      prescriberDiscipline: "hospice_physician",
      prescribingPhysicianMdmId: PHYSICIAN_MDM,
      refillsAuthorized: 0,
    });
    await meds.requestSignature(ORG_A, draft.id, "hospice_physician");
    await meds.signOrder(ORG_A, memberOf[ORG_A], draft.id, {
      signerDiscipline: "hospice_physician",
      signedAtClient: new Date().toISOString(),
    });

    expect((await outboxFor(draft.id)).map((e) => e.type)).toContain(
      "m12.medication_order.document_requested",
    );
    await dispatcher.tick();

    const docs = await documentsFor(draft.id);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("medication_order");
    expect(docs[0].patient_id).toBe(PATIENT);
  });

  // ── GAP-038 ──────────────────────────────────────────────────────────────────────────────────────────

  // M23 has no ABN write path at all (no table, no route, no emitter — only the catalog entry), so the
  // request is published directly here. What GAP-038 is about is the NAME and the template: an
  // `m23.abn.required` row must now resolve to the CMS-R-131 descriptor and render. The missing M23
  // producer is recorded as a separate finding, not faked here.
  it("an m23.abn.required request renders the CMS-R-131 ABN (the name M23 actually declares)", async () => {
    await seedOutboxRow({
      organizationId: ORG_A,
      eventType: "m23.abn.required",
      aggregateKind: "abn",
      aggregateId: ABN_ID,
      payload: {
        abnId: ABN_ID,
        patientId: PATIENT,
        organizationId: ORG_A,
        claimId: null,
        serviceDescription: "Continuous home care, 8 hours",
        estimatedCost: 124_50,
        reasonNoncovered: "not related to the terminal diagnosis",
        requiredBy: "2026-09-01T00:00:00.000Z",
      },
    });
    await dispatcher.tick();

    const docs = await documentsFor(ABN_ID);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("abn");
    expect(docs[0].retention_class).toBe("compliance");
    expect(docs[0].title).toBe("Advance Beneficiary Notice of Noncoverage");
    expect(renderedKeys).toContain("abn");
  });

  // The pre-fix name. Nothing declares it, so the dispatcher cannot route it — it must stay pending rather
  // than render, which is exactly why the mismatch survived undetected.
  it("the old m23.abn.document_requested name renders nothing", async () => {
    const ghost = "78787878-7878-4878-8878-787878787878";
    await seedOutboxRow({
      organizationId: ORG_A,
      eventType: "m23.abn.document_requested",
      aggregateKind: "abn",
      aggregateId: ghost,
      payload: { abnId: ghost, patientId: PATIENT },
    });
    await dispatcher.tick();
    expect(await documentsFor(ghost)).toHaveLength(0);
  });

  // ── tenancy ──────────────────────────────────────────────────────────────────────────────────────────

  it("renders under the requesting org only — org B never sees org A's rendered documents", async () => {
    const { rows } = await admin.query(
      "SELECT DISTINCT organization_id FROM document WHERE aggregate_type IN ('order_record','medication_order','abn')",
    );
    expect(rows.map((r) => r.organization_id)).toEqual([ORG_A]);

    // And prove it through RLS, not just by inspection: as the app role pinned to org B, the same rows
    // are invisible.
    const b = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await b.connect();
    try {
      await b.query("BEGIN");
      await b.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
      const { rows: seen } = await b.query(
        "SELECT count(*)::int AS n FROM document WHERE aggregate_type IN ('order_record','medication_order','abn')",
      );
      expect(seen[0].n).toBe(0);
      await b.query("COMMIT");
    } finally {
      await b.end();
    }
  });
});
