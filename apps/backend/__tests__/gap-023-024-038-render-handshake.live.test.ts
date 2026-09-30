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
import { M6_OUTBOX_EVENTS } from "../src/modules/06-admission/index";
import { M7_OUTBOX_EVENTS } from "../src/modules/07-care-plan/index";
import { M8_OUTBOX_EVENTS } from "../src/modules/08-encounters/index";
import { M9_OUTBOX_EVENTS } from "../src/modules/09-assessments/index";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/index";
import { M11_OUTBOX_EVENTS, buildM11DocumentBackrefConsumer } from "../src/modules/11-orders/index";
import { M14_OUTBOX_EVENTS } from "../src/modules/14-idg/index";
import { M15_OUTBOX_EVENTS } from "../src/modules/15-discipline-care-plans/index";
import { M17_OUTBOX_EVENTS } from "../src/modules/17-scheduling/index";
import { M18_OUTBOX_EVENTS } from "../src/modules/18-evv/index";
import { M19_OUTBOX_EVENTS } from "../src/modules/19-oncall/index";
import {
  type OrderWriteOutboxPort,
  createDbOrderBackend,
} from "../src/modules/11-orders/orders-route-service-db";
import {
  type DoseSpotWriteOutboxPort,
  createDbDoseSpotBackend,
} from "../src/modules/12-dosespot/dosespot-route-service-db";
import {
  M12_OUTBOX_EVENTS,
  buildM12DocumentBackrefConsumer,
} from "../src/modules/12-dosespot/index";
import { M13_OUTBOX_EVENTS, buildM13DocumentBackrefConsumer } from "../src/modules/13-emar/index";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/index";
import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/index";
import {
  M21_OUTBOX_EVENTS,
  buildM21DocumentBackrefConsumer,
} from "../src/modules/21-supplies/index";
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
import {
  M33_OUTBOX_EVENTS,
  buildM33DocumentBackrefConsumer,
} from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";
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
/** Every `document_aggregate_type` this suite renders — the tenancy assertion must cover all of them,
 *  or a new render silently escapes the only cross-tenant check in the file. */
const RENDERED_TYPES = [
  "order_record",
  "medication_order",
  "abn",
  "supply_bill_of_lading",
  "comfort_kit_return_receipt",
  // F-099
  "hope_summary",
  "bereavement_letter",
  "safety_incident_report",
  "appeal_packet",
  "cost_report_ecr",
  "body_release_authorization",
]
  .map((t) => `'${t}'`)
  .join(",");
const LOCATION = "99999999-9999-4999-8999-999999999991";
const PROVIDER_ENTITY = "99999999-9999-4999-8999-999999999992";

describe.skipIf(!DB_URL)("GAP-023/024/038 — §4.11 render handshake, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let orders: ReturnType<typeof createDbOrderBackend>;
  let meds: ReturnType<typeof createDbDoseSpotBackend>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let objects: ReturnType<typeof createInMemoryObjectStore>;
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
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
  /** One column value, by table + id — the back-ref half's proof (superuser read). */
  async function columnOf(table: string, column: string, id: string): Promise<string | null> {
    const { rows } = await admin.query(`SELECT ${column} AS v FROM ${table} WHERE id=$1`, [id]);
    return (rows[0]?.v as string | null) ?? null;
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
      M21_OUTBOX_EVENTS,
      // GAP-051 — M22's ONE render consumer now also subscribes to M33's request event, and
      // `m22.document.rendered` declares m33 among its consumers. BOTH halves have to be present here:
      // the dispatcher refuses to construct on an event its catalog does not know, and it holds every
      // back-ref row `pending` while a declared consumer module has no live binding.
      M33_OUTBOX_EVENTS,
      M22_OUTBOX_EVENTS,
      M23_OUTBOX_EVENTS,
      // F-099 — the six modules whose render REQUEST was being emitted with nothing draining it. Present
      // here for the same two reasons M33 is: the dispatcher refuses to construct on an event its catalog
      // does not know, and `buildTxOutboxPublisher` validates each payload against the catalog schema —
      // which is what makes the `patientId` these payloads gained a checked fact rather than a comment.
      // F-100 — M6's six CoP events, which M22's ONE render consumer now also binds. The dispatcher
      // refuses to CONSTRUCT on an event its catalog does not carry, so this contribution is not
      // optional: without it every test in the file reports "skipped" beside a failed suite, which is a
      // read this suite's `describe.skipIf(!DB_URL)` guard makes easy to mistake for "no database".
      M6_OUTBOX_EVENTS,
      M10_OUTBOX_EVENTS,
      M16_OUTBOX_EVENTS,
      M20_OUTBOX_EVENTS,
      M25_OUTBOX_EVENTS,
      M27_OUTBOX_EVENTS,
      M37_OUTBOX_EVENTS,
      // F-144 (#248) — M22's render consumer now also subscribes to
      // `m24.medicaid_billing.document_render_requested`; same reason as every entry above it.
      M24_OUTBOX_EVENTS,
      // F-161/F-166 (#248) — M7/M17's, and M8/M14/M15/M18's, GENESIS-only render requests; the same
      // "the dispatcher refuses to construct otherwise" reason as every entry above.
      M7_OUTBOX_EVENTS,
      M8_OUTBOX_EVENTS,
      M9_OUTBOX_EVENTS,
      M14_OUTBOX_EVENTS,
      M15_OUTBOX_EVENTS,
      M17_OUTBOX_EVENTS,
      M18_OUTBOX_EVENTS,
      M19_OUTBOX_EVENTS,
    ]);
    const txPublisher = buildTxOutboxPublisher(catalog);
    publisher = txPublisher;
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
      // The §7.2 downstream half, wired exactly as boot wires it: the emit opens its own tx (the render
      // already committed in the renderer's) and publishes through the same catalog-validating publisher,
      // so `m22.document.rendered`'s payload is contract-checked too.
      emitRendered: ({ organizationId, ...payload }) =>
        withOrgContext(handle.db, { organizationId, userId: "" }, (tx) =>
          txPublisher.publish(tx as never, {
            eventName: M22_DOCUMENT_RENDERED_EVENT,
            payload,
            organizationId,
            aggregateKind: "document",
            aggregateId: payload.documentId,
            callerModule: "m22",
          }),
        ),
    });

    // Stub enumerator only — no platform credential needed to exercise per-org claim/deliver/finalize.
    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [
        consumer,
        // All four back-ref consumers — `m22.document.rendered` declares exactly these, and the dispatcher
        // holds the row `pending` while any declared consumer module has no live binding.
        buildM11DocumentBackrefConsumer({ db: handle.db }),
        buildM12DocumentBackrefConsumer({ db: handle.db }),
        buildM13DocumentBackrefConsumer({ db: handle.db }),
        buildM21DocumentBackrefConsumer({ db: handle.db }),
        buildM33DocumentBackrefConsumer({ db: handle.db }),
      ],
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

    // The DOWNSTREAM half: M22 announced the render and M11 stamped its own back-ref column — the column
    // that has existed since M11's schema landed, commented "null until reports rendered", and stayed
    // NULL because `m22.document.rendered` did not exist.
    const announced = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type='m22.document.rendered' AND aggregate_id=$1",
      [docs[0].id],
    );
    expect(announced.rows).toHaveLength(1);
    expect(announced.rows[0].payload).toMatchObject({
      sourceModule: "m11",
      sourceEvent: "m11.order.document_requested",
      aggregateType: "order_record",
      aggregateId: draft.id,
      documentId: docs[0].id,
      isFirstVersion: true,
    });
    await dispatcher.tick(); // deliver the back-ref event
    expect(await columnOf("order_record", "document_id", draft.id)).toBe(docs[0].id);
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
      // standard.v1 payload (packages/dosespot/src/classes/contracts.ts) — complete, so requestSignature passes.
      data: {
        sigStructured: {
          doseQuantity: 1,
          doseUnit: "tablet",
          route: "oral",
          frequencyCode: "Q6H",
          asNeeded: true,
          asNeededReasonCode: "pain",
        },
        sigFreeText: "1 tab PO q6h PRN pain",
        refillsAuthorized: 0,
        dispenseQuantity: { value: 28, unit: "tablet" },
        daysSupply: 7,
        daw: false,
      },
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

    await dispatcher.tick();
    expect(await columnOf("medication_order", "document_id", draft.id)).toBe(docs[0].id);
  });

  // ── M21 supply documents ─────────────────────────────────────────────────────────────────────────────

  // M21 has been emitting this from BOTH write paths since it landed, with no consumer and no published
  // template on the M22 side — its rows just accumulated `pending`. Standing up M21's full write domain
  // (supply_request → comfort_kit → vendor → dispatch → return) is out of scope here, so the request is
  // published through the REAL catalog-validating transactional publisher under M21's own declared schema:
  // a payload shaped differently from what `events-by-m21.ts` declares is refused before it reaches the
  // relay, which is the part of the contract this proves.
  it("renders both M21 supply artifacts, each filed against the right source aggregate", async () => {
    const supplyRequestId = "88888888-8888-4888-8888-888888888881";
    const dispatchId = "88888888-8888-4888-8888-888888888882";
    const returnId = "88888888-8888-4888-8888-888888888883";
    const templateId = "88888888-8888-4888-8888-888888888884";
    // The two rows the back-ref half stamps have to EXIST — an UPDATE against an absent row is a silent
    // zero-row no-op, which is exactly what this assertion must not mistake for success. Seeded as
    // admin: M21's write domain (request → kit → vendor → dispatch → return) is out of scope here, and
    // these rows are the target of the stamp, not the subject of the test.
    // `location` hangs off `provider_entity`, not the org directly (it is NON_ORG_SCOPED — the tenancy
    // spine reaches it through the provider entity), so the provider goes in first.
    await admin.query(
      `INSERT INTO provider_entity (id, organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,'371234','Provider','1234567893','enc','1231') ON CONFLICT DO NOTHING`,
      [PROVIDER_ENTITY, ORG_A],
    );
    await admin.query(
      `INSERT INTO location (id, provider_entity_id, name, address_line1, city, state, postal_code, timezone)
       VALUES ($1,$2,'HQ','1 Main','Portland','OR','97201','America/Los_Angeles')
       ON CONFLICT DO NOTHING`,
      [LOCATION, PROVIDER_ENTITY],
    );
    await admin.query(
      `INSERT INTO comfort_kit_template (id, organization_id, name)
       VALUES ($1,$2,'Standard Kit') ON CONFLICT DO NOTHING`,
      [templateId, ORG_A],
    );
    await admin.query(
      `INSERT INTO comfort_kit_dispatch
         (id, supply_request_id, organization_id, patient_id, admission_id, location_id,
          provider_entity_id, comfort_kit_template_id, deployment_site, pharmacy_dispatch_mode,
          dispatch_source, kit_serial_number, dispatched_by_membership_id,
          controlled_substance_handling_policy_digest, dispatched_contents_jsonb)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'home','supply_hub_dispatch','supply_hub','KIT-1',$9,
               'digest','[]'::jsonb)`,
      [
        dispatchId,
        supplyRequestId,
        ORG_A,
        PATIENT,
        ADMISSION,
        LOCATION,
        PROVIDER_ENTITY,
        templateId,
        memberOf[ORG_A],
      ],
    );
    await admin.query(
      `INSERT INTO comfort_kit_return
         (id, dispatch_id, dispatch_partition_dispatched_at, organization_id, m13_deployment_id,
          patient_id, admission_id, location_id, provider_entity_id, return_required_at, return_due_at)
       VALUES ($1,$2, now(), $3,$4,$5,$6,$7,$8, now(), now() + interval '3 days')`,
      [
        returnId,
        dispatchId,
        ORG_A,
        "88888888-8888-4888-8888-888888888885",
        PATIENT,
        ADMISSION,
        LOCATION,
        PROVIDER_ENTITY,
      ],
    );
    const anchor = {
      orgId: ORG_A,
      patientId: PATIENT,
      admissionId: ADMISSION,
      providerEntityId: PHYSICIAN_MDM,
      locationId: PHYSICIAN_MDM,
    };
    await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, async (tx) => {
      // The bill of lading — envelope aggregate is the DISPATCH.
      await publisher.publish(tx as never, {
        eventName: "m21.supply_request.document_requested",
        payload: {
          ...anchor,
          supplyRequestId,
          dispatchId,
          documentKind: "bill_of_lading",
          requestedAt: new Date().toISOString(),
        },
        organizationId: ORG_A,
        aggregateKind: "comfort_kit_dispatch",
        aggregateId: dispatchId,
        callerModule: "m21",
      });
      // The DEA-1304 return receipt — envelope aggregate is the RETURN, while the body still carries
      // `dispatchId`. Reading the body would file this against the dispatch and collide with the BOL.
      await publisher.publish(tx as never, {
        eventName: "m21.supply_request.document_requested",
        payload: {
          ...anchor,
          supplyRequestId,
          dispatchId,
          documentKind: "return_receipt",
          requestedAt: new Date().toISOString(),
        },
        organizationId: ORG_A,
        aggregateKind: "comfort_kit_return",
        aggregateId: returnId,
        callerModule: "m21",
      });
    });

    await dispatcher.tick();

    const bol = await documentsFor(dispatchId);
    expect(bol).toHaveLength(1);
    expect(bol[0].aggregate_type).toBe("supply_bill_of_lading");
    expect(bol[0].retention_class).toBe("operational"); // a shipping manifest, not a chart artifact
    expect(bol[0].patient_id).toBe(PATIENT);

    const receipt = await documentsFor(returnId);
    expect(receipt).toHaveLength(1);
    expect(receipt[0].aggregate_type).toBe("comfort_kit_return_receipt");
    // A controlled-substance disposition record — compliance, not the clinical class its deployment-side
    // sibling (`comfort_kit_receipt`, M13) carries.
    expect(receipt[0].retention_class).toBe("compliance");
    expect(receipt[0].title).toBe("Comfort Kit Return Receipt");

    // Both requests completed at the relay — no pending backlog left behind.
    for (const id of [dispatchId, returnId]) {
      const rows = await outboxFor(id);
      expect(rows.find((r) => r.type === "m21.supply_request.document_requested")?.status).toBe(
        "dispatched",
      );
    }

    // M21 is the only requester whose back-ref consumer ROUTES: the BOL lands on the dispatch row, the
    // return receipt on the return row. Getting this wrong would put both on whichever row the payload's
    // `dispatchId` named.
    await dispatcher.tick();
    expect(await columnOf("comfort_kit_dispatch", "bol_document_id", dispatchId)).toBe(bol[0].id);
    expect(await columnOf("comfort_kit_return", "receipt_document_id", returnId)).toBe(
      receipt[0].id,
    );
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

  // ── F-099 — the six render requests that were emitted and drained by nothing ─────────────────────────

  /** The six, as their producers publish them. `patientId` is the F-099 addition on four of them. */
  const F099_REQUESTS = [
    {
      label: "M10 HOPE summary",
      eventType: "m10.hope.summary_requested",
      aggregateKind: "hope_assessment",
      payload: (id: string) => ({ assessmentId: id, requestedBy: USER, patientId: PATIENT }),
      aggregateType: "hope_summary",
      retentionClass: "clinical_record",
      patientId: PATIENT,
    },
    {
      label: "M16 bereavement welcome packet",
      eventType: "m16.bereavement.outreach_artifact_requested",
      aggregateKind: "bereavement_plan",
      payload: (id: string) => ({
        planId: id,
        patientId: PATIENT,
        contactId: LOCATION,
        outreachId: null,
        templateKey: "bereavement_welcome_packet",
        payloadJsonb: { deathDate: "2026-08-01" },
      }),
      aggregateType: "bereavement_letter",
      retentionClass: "bereavement",
      patientId: PATIENT,
    },
    {
      label: "M20 staff-safety incident report",
      eventType: "m20.safety.incident_report_requested",
      aggregateKind: "safety_incident",
      payload: (id: string) => ({
        orgId: ORG_A,
        providerEntityId: PROVIDER_ENTITY,
        occurredAt: "2026-08-01T00:00:00.000Z",
        incidentId: id,
        patientId: null,
        renderTargetKind: "pdf",
      }),
      aggregateType: "safety_incident_report",
      retentionClass: "compliance",
      // Deliberately NULL, and the whole reason the column is nullable: a vehicle accident has no
      // patient, and filing that report on someone's chart is worse than filing it on none.
      patientId: null,
    },
    {
      label: "M25 appeal packet",
      eventType: "m25.appeal_packet.render_requested",
      aggregateKind: "appeal_case",
      payload: (id: string) => ({ appealCaseId: id, tier: "redetermination", payload: {} }),
      aggregateType: "appeal_packet",
      retentionClass: "compliance",
      patientId: null,
    },
    {
      label: "M27 electronic cost report",
      eventType: "m27.artifact.render_requested",
      aggregateKind: "ecr_submission",
      payload: (id: string) => ({
        costReportId: ABN_ID,
        submissionId: id,
        artifactKind: "ecr",
        payloadRef: ADMISSION,
        retentionClass: "compliance",
      }),
      aggregateType: "cost_report_ecr",
      retentionClass: "compliance",
      patientId: null,
    },
    {
      label: "M37 body-release authorization",
      eventType: "m37.body_release.document_requested",
      aggregateKind: "ipu_body_release",
      payload: (id: string) => ({
        organizationId: ORG_A,
        bodyReleaseId: id,
        patientId: PATIENT,
      }),
      aggregateType: "body_release_authorization",
      retentionClass: "compliance",
      patientId: PATIENT,
    },
  ] as const;

  it.each(F099_REQUESTS)(
    "$label: the request is delivered and rendered into document/document_version",
    async (req) => {
      const id = randomUUID();
      // Published through the REAL transactional publisher, not a raw INSERT: it Value.Check's the
      // payload against the boot catalog, so a `patientId` the producer's schema does not declare would
      // fail here rather than silently riding along.
      await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        publisher.publish(tx as never, {
          eventName: req.eventType,
          payload: req.payload(id),
          organizationId: ORG_A,
          aggregateKind: req.aggregateKind,
          aggregateId: id,
          callerModule: req.eventType.split(".")[0] as string,
        }),
      );
      expect(await documentsFor(id)).toHaveLength(0); // nothing rendered until the relay runs

      await dispatcher.tick();

      const docs = await documentsFor(id);
      expect(docs).toHaveLength(1);
      // The aggregate type is the migration-0239 enum value: a `document_aggregate_type` the database
      // does not know is a write error, so this row existing IS the migration's proof.
      expect(docs[0].aggregate_type).toBe(req.aggregateType);
      expect(docs[0].retention_class).toBe(req.retentionClass);
      expect(docs[0].patient_id).toBe(req.patientId);
      expect(docs[0].organization_id).toBe(ORG_A);
      expect(Number(docs[0].byte_size)).toBeGreaterThan(0);
      // The relay finalized it: a declared-but-unbound consumer leaves the row `pending` forever, which
      // is exactly the state all six were in.
      expect((await outboxFor(id)).find((e) => e.type === req.eventType)?.status).toBe(
        "dispatched",
      );
    },
  );

  it("re-delivery of a request renders no second document (D14 idempotency)", async () => {
    const id = randomUUID();
    const seed = () =>
      withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        publisher.publish(tx as never, {
          eventName: "m37.body_release.document_requested",
          payload: { organizationId: ORG_A, bodyReleaseId: id, patientId: PATIENT },
          organizationId: ORG_A,
          aggregateKind: "ipu_body_release",
          aggregateId: id,
          callerModule: "m37",
        }),
      );
    await seed();
    await dispatcher.tick();
    await seed();
    await dispatcher.tick();
    expect(await documentsFor(id)).toHaveLength(1);
  });

  // ── tenancy ──────────────────────────────────────────────────────────────────────────────────────────

  it("renders under the requesting org only — org B never sees org A's rendered documents", async () => {
    const { rows } = await admin.query(
      `SELECT DISTINCT organization_id FROM document WHERE aggregate_type IN (${RENDERED_TYPES})`,
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
        `SELECT count(*)::int AS n FROM document WHERE aggregate_type IN (${RENDERED_TYPES})`,
      );
      expect(seen[0].n).toBe(0);
      await b.query("COMMIT");
    } finally {
      await b.end();
    }
  });
});
