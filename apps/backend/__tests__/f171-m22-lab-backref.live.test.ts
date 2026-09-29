/**
 * F-171 (#248) — M22's §7.15/§7.16 lab-results back-ref pipeline, proven live end to end over real Postgres.
 *
 * The standing finding (re-confirmed at F-166/F-170): `lab-backref-bindings.ts`'s `resolveLabResultsPayload`
 * called a method (`resolveLabResultsPayload`) M29's REAL registered `LabObservationReader` interface never
 * had (only `getById`/`listByPatient`) — a name mismatch the deny-stub silently absorbed, so the pipeline
 * fail-closed forever even after M29's seam registered at boot. Even fixing the name would not have been
 * enough: `LabObservationSeamValue` carried no per-value SUD-class flag, and §7.16 requires one before any
 * render (the identical Part-2-disclosure risk F-035 already refused for the M12/M13 FHIR DTO pair).
 *
 * Fixed this pass:
 *   · A new `LabObservationReader.getByObservationId` method (`published.ts`) — the real catalogued
 *     `m11.order.results_received` payload (`events-by-m11.ts`) carries NO `patientId`, so the existing
 *     `getById` (which REQUIRES one) could never have been called from this consumer regardless of the
 *     name fix. Additive; `getById` is untouched for the M28 FHIR caller that already has a patientId.
 *   · `LabObservationSeamValue.isSudClass` + `.loincDisplayText` (`published.ts`/`published-store-drizzle.ts`)
 *     — the honest per-value projection of the parent `lab_observation.sud_redacted_at_ingest` column (SUD
 *     redaction is applied per-MESSAGE at ingest, uniformly across every OBX row — never an invented
 *     per-row classifier).
 *   · The dedicated live consumer (`buildM22LabBackrefConsumer`), wired into the composition root for the
 *     first time. Deliberately NOT part of the generic `render-consumer.ts` `REQUEST_SHAPES` pipeline:
 *     `lab_results_pdf` shares its published `aggregateType` (`order_record`) with the order-FORM render
 *     `m11.order.document_requested` already produces at sign time, so genesis-only (aggregate-level)
 *     idempotency would read "this order already has a document" and silently skip the lab result forever.
 *     This consumer uses the F-168 per-delivered-event dedup instead (`document_version.source_event_id`),
 *     which means a genuinely new lab result always renders — as a NEW VERSION of the order's
 *     `order_record` document trail, matching what M11's own `buildM11DocumentBackrefConsumer` already
 *     expects (it stamps `order_record.document_id` by matching `aggregateId === order.id` regardless of
 *     which artifact produced the version).
 *
 * `m11.order.results_received` has NO production emitter anywhere in this codebase today (`LabResultsApplier`,
 * named in the event's own catalog description, does not exist — exhaustively grepped) — the `m17
 * .caregiver_reminder_due` (F-161) shape. This suite proves the M22-side binding against the REAL catalogued
 * payload shape, published directly through the real catalog-validating transactional publisher, the same
 * proof shape a real emitter's `outbox.publish()` call would produce. Likewise M29's own ingest worker
 * (`planLabAttach`) has no production caller — `lab_observation`/`lab_observation_value` rows are seeded
 * directly, simulating "M29 has already matched and stored this result", which is the real state this
 * consumer reads regardless of how that row got there.
 *
 * Nothing is stubbed on the M22/M29 side under test: the real catalog-validating transactional publisher
 * writes the row, the real `createOutboxDispatcher` claims and delivers it, M29's real
 * `createDrizzleM29PublishedSeamStore`-backed `LabObservationReader` seam resolves the observation, the real
 * `DocumentRenderer` renders, and the real Drizzle seam store writes `document`/`document_version`, under
 * RLS, as the NOBYPASSRLS `wardenx_app` role. `ConsentEvaluator` is stubbed (both directions driven) — same
 * convention `m28-fhir-gateway.live.test.ts` uses for the identical M39 seam.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:f171:m22-lab-backref:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M11_OUTBOX_EVENTS, buildM11DocumentBackrefConsumer } from "../src/modules/11-orders/index";
import {
  M22_OUTBOX_EVENTS,
  buildM22LabBackrefConsumer,
  createDocumentRenderer,
  createDrizzleDocumentSeamStore,
  createInMemoryObjectStore,
} from "../src/modules/22-documents/index";
import {
  createDrizzleM29PublishedSeamStore,
  registerM29PublishedSeams,
} from "../src/modules/29-external-interfaces/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";

describe.skipIf(!DB_URL)("F-171 — M22 lab-results back-ref (m11.order.results_received), LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
  let memberA: string;
  let providerA: string;
  let providerB: string;
  let consentAllows = false;

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

  async function seedOrder(organizationId: string, providerEntityId: string): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO order_record
         (organization_id, provider_entity_id, patient_id, admission_id, kind, kind_version, data,
          status, drafter_membership_id, drafter_discipline, ordering_physician_mdm_id)
       VALUES ($1,$2,gen_random_uuid(),gen_random_uuid(),'lab','v1','{}'::jsonb,'active',$3,
               'rn_case_manager',$4)
       RETURNING id`,
      [organizationId, providerEntityId, memberA, PHYSICIAN_MDM],
    );
    return rows[0].id as string;
  }

  /** Seed a `lab_observation` + N `lab_observation_value` rows directly (M29's own ingest worker has no
   *  production caller — see the file header). `sudRedacted` mirrors ingest's real per-MESSAGE behavior:
   *  every value row of the SAME observation is flagged together (`lab-attach-planner.ts`'s `buildValueRows`
   *  applies one boolean to every OBX row in the message). */
  async function seedObservation(opts: {
    organizationId: string;
    providerEntityId: string;
    orderId: string;
    patientId: string;
    sudRedacted: boolean;
  }): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO lab_observation
         (organization_id, provider_entity_id, patient_id, order_id, source_message_id,
          observation_date, result_status, loinc_code, loinc_display_text,
          terminology_validation, abnormal_summary, sud_redacted_at_ingest)
       VALUES ($1,$2,$3,$4,gen_random_uuid(),now(),'final','2823-3','Basic Metabolic Panel',
               'valid','no_flags',$5)
       RETURNING id`,
      [opts.organizationId, opts.providerEntityId, opts.patientId, opts.orderId, opts.sudRedacted],
    );
    const observationId = rows[0].id as string;
    if (opts.sudRedacted) {
      await admin.query(
        `INSERT INTO lab_observation_value
           (organization_id, observation_id, obx_set_id, loinc_code, loinc_display_text,
            terminology_validation, value_type, string_value)
         VALUES ($1,$2,1,'3400-1','Methadone screen, urine','valid','ST','[REDACTED_SUD]')`,
        [opts.organizationId, observationId],
      );
    } else {
      await admin.query(
        `INSERT INTO lab_observation_value
           (organization_id, observation_id, obx_set_id, loinc_code, loinc_display_text,
            terminology_validation, value_type, numeric_value, units, abnormal_flag)
         VALUES ($1,$2,1,'2823-3','Potassium','valid','NM',5.2,'mEq/L','N')`,
        [opts.organizationId, observationId],
      );
    }
    return observationId;
  }

  async function outboxRow(organizationId: string, aggregateId: string) {
    const { rows } = await admin.query(
      `SELECT id, event_type, status, attempt_count FROM outbox_event
        WHERE organization_id=$1 AND aggregate_id=$2 AND event_type='m11.order.results_received'
        ORDER BY created_at DESC LIMIT 1`,
      [organizationId, aggregateId],
    );
    return rows[0] as
      | { id: string; event_type: string; status: string; attempt_count: number }
      | undefined;
  }

  async function documentsFor(aggregateId: string) {
    const { rows } = await admin.query(
      `SELECT d.id, d.organization_id, d.aggregate_type, d.patient_id, d.retention_class, d.title,
              v.id AS version_id, v.version_number, v.source_event_id
         FROM document d JOIN document_version v ON v.document_id = d.id
        WHERE d.aggregate_id=$1 ORDER BY v.version_number`,
      [aggregateId],
    );
    return rows as Array<{
      id: string;
      organization_id: string;
      aggregate_type: string;
      patient_id: string;
      retention_class: string;
      title: string;
      version_id: string;
      version_number: string;
      source_event_id: string | null;
    }>;
  }

  async function orderDocumentId(orderId: string): Promise<string | null> {
    const { rows } = await admin.query(`SELECT document_id FROM order_record WHERE id=$1`, [
      orderId,
    ]);
    return (rows[0]?.document_id as string | null) ?? null;
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f174@x.test')`, [USER]);
    memberA = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    providerA = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-F171-A','F171 A','NPI-F171-A','enc','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    providerB = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-F171-B','F171 B','NPI-F171-B','enc','12-31') RETURNING id`,
        [ORG_B],
      )
    ).rows[0].id as string;

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    __resetSeamsForTest();
    registerM29PublishedSeams({ store: createDrizzleM29PublishedSeamStore(handle.db) });
    // M39's evaluator, stubbed so the §7.16 gate can be driven both ways — everything else about the gate
    // is real (`resolveSudConsentPresent` genuinely calls it). Mirrors `m28-fhir-gateway.live.test.ts`.
    registerSeam("ConsentEvaluator", {
      async evaluate() {
        return { allowed: consentAllows };
      },
    } as never);

    const catalog = buildBootOutboxCatalog([M11_OUTBOX_EVENTS, M22_OUTBOX_EVENTS]);
    publisher = buildTxOutboxPublisher(catalog);

    const objects = createInMemoryObjectStore();
    const store = createDrizzleDocumentSeamStore(handle.db);
    const renderer = createDocumentRenderer({ store, objects: objects.store });

    const labConsumer = buildM22LabBackrefConsumer({
      store,
      renderer: () => renderer,
      emitRendered: ({ organizationId, ...payload }) =>
        withOrgContext(handle.db, { organizationId, userId: "" }, (tx) =>
          publisher.publish(tx as never, {
            eventName: "m22.document.rendered",
            payload,
            organizationId,
            aggregateKind: "document",
            aggregateId: payload.documentId,
            callerModule: "m22",
          }),
        ),
    });
    const backrefConsumer = buildM11DocumentBackrefConsumer({ db: handle.db });

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [labConsumer, backrefConsumer],
      eventCatalog: catalog,
      options: { log: () => {} },
    });

    // Expose the renderer builder for the direct pre-render (order-form collision test) below.
    (globalThis as { __f174Renderer?: typeof renderer }).__f174Renderer = renderer;
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  async function publishReceived(input: {
    organizationId: string;
    orderId: string;
    observationId: string;
  }): Promise<void> {
    await withOrgContext(handle.db, { organizationId: input.organizationId, userId: "" }, (tx) =>
      publisher.publish(tx as never, {
        eventName: "m11.order.results_received",
        organizationId: input.organizationId,
        aggregateKind: "order_record",
        aggregateId: input.orderId,
        payload: {
          orderId: input.orderId,
          organizationId: input.organizationId,
          observationId: input.observationId,
          attachmentKind: "full",
          orderingPhysicianMdmId: PHYSICIAN_MDM,
          signedAt: new Date().toISOString(),
        },
        callerModule: "m11",
      }),
    );
  }

  it("renders a non-SUD lab result and stamps order_record.document_id", async () => {
    consentAllows = false;
    const orderId = await seedOrder(ORG_A, providerA);
    const patientId = randomUUID();
    const observationId = await seedObservation({
      organizationId: ORG_A,
      providerEntityId: providerA,
      orderId,
      patientId,
      sudRedacted: false,
    });

    await publishReceived({ organizationId: ORG_A, orderId, observationId });
    expect(await orderDocumentId(orderId)).toBeNull();

    await dispatcher.tick();
    await dispatcher.tick(); // second tick drains the m22.document.rendered → m11 back-ref hop

    const docs = await documentsFor(orderId);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("order_record");
    expect(docs[0].patient_id).toBe(patientId);
    expect(docs[0].retention_class).toBe("clinical_record");
    expect(docs[0].title).toBe("Lab Results");

    expect(await orderDocumentId(orderId)).toBe(docs[0].id);
  });

  it("SUD-class result with NO M39 consent redacts the value and forces compliance_42cfr_part2 retention", async () => {
    consentAllows = false;
    const orderId = await seedOrder(ORG_A, providerA);
    const patientId = randomUUID();
    const observationId = await seedObservation({
      organizationId: ORG_A,
      providerEntityId: providerA,
      orderId,
      patientId,
      sudRedacted: true,
    });

    await publishReceived({ organizationId: ORG_A, orderId, observationId });
    await dispatcher.tick();

    const docs = await documentsFor(orderId);
    expect(docs).toHaveLength(1);
    expect(docs[0].retention_class).toBe("compliance_42cfr_part2");
  });

  it("the SAME SUD-class result WITH an active M39 consent does not force compliance retention", async () => {
    consentAllows = true;
    const orderId = await seedOrder(ORG_A, providerA);
    const patientId = randomUUID();
    const observationId = await seedObservation({
      organizationId: ORG_A,
      providerEntityId: providerA,
      orderId,
      patientId,
      sudRedacted: true,
    });

    await publishReceived({ organizationId: ORG_A, orderId, observationId });
    await dispatcher.tick();

    const docs = await documentsFor(orderId);
    expect(docs).toHaveLength(1);
    expect(docs[0].retention_class).toBe("clinical_record");
    consentAllows = false;
  });

  it("appends a NEW VERSION onto an already-rendered order-form document, never a silent idempotent_skip", async () => {
    const orderId = await seedOrder(ORG_A, providerA);
    const patientId = randomUUID();

    // Pre-render the order FORM under the SAME (aggregateType=order_record, aggregateId=orderId) key
    // `m11.order.document_requested`'s genesis render would use — this is the exact collision the
    // generic REQUEST_SHAPES pipeline could not solve (see the file header).
    const renderer = (globalThis as { __f174Renderer?: ReturnType<typeof createDocumentRenderer> })
      .__f174Renderer!;
    await renderer.render({ orgId: ORG_A }, "order_record", {
      aggregateId: orderId,
      patientId,
      title: "Order",
    });
    const before = await documentsFor(orderId);
    expect(before).toHaveLength(1);
    expect(before[0].version_number).toBe("1");

    const observationId = await seedObservation({
      organizationId: ORG_A,
      providerEntityId: providerA,
      orderId,
      patientId,
      sudRedacted: false,
    });
    await publishReceived({ organizationId: ORG_A, orderId, observationId });
    await dispatcher.tick();

    const after = await documentsFor(orderId);
    // Same DOCUMENT (one row), a NEW version — never a second document, never idempotent_skip forever.
    expect(after).toHaveLength(2);
    expect(after.map((d) => d.id)).toEqual([before[0].id, before[0].id]);
    expect(after.map((d) => d.version_number)).toEqual(["1", "2"]);
    expect(after[1].title).toBe("Lab Results");
  });

  it("a redelivery of the SAME outbox event never produces a second document_version (F-168 dedup)", async () => {
    const orderId = await seedOrder(ORG_A, providerA);
    const patientId = randomUUID();
    const observationId = await seedObservation({
      organizationId: ORG_A,
      providerEntityId: providerA,
      orderId,
      patientId,
      sudRedacted: false,
    });
    await publishReceived({ organizationId: ORG_A, orderId, observationId });
    const row = await outboxRow(ORG_A, orderId);
    expect(row).toBeDefined();

    await dispatcher.tick();
    const after1 = await documentsFor(orderId);
    expect(after1).toHaveLength(1);

    // Simulate a genuine crash-retry redelivery: reset the row back to pending and re-tick.
    await admin.query(
      `UPDATE outbox_event SET status='pending', next_attempt_at=now() WHERE id=$1`,
      [row!.id],
    );
    await dispatcher.tick();

    const after2 = await documentsFor(orderId);
    expect(after2).toHaveLength(1); // still exactly one version — no duplicate
    expect(after2[0].version_id).toBe(after1[0].version_id);
  });

  it("defers (retries, never renders) when the M29 observation has not been resolved yet", async () => {
    const orderId = await seedOrder(ORG_A, providerA);
    const missingObservationId = randomUUID();
    await publishReceived({ organizationId: ORG_A, orderId, observationId: missingObservationId });

    const before = await outboxRow(ORG_A, orderId);
    expect(before?.status).toBe("pending");
    expect(before?.attempt_count).toBe(0);

    await dispatcher.tick();

    const after = await outboxRow(ORG_A, orderId);
    expect(after?.status).toBe("pending"); // retried, not dead-lettered on the first miss
    expect(after?.attempt_count).toBe(1);
    expect(await documentsFor(orderId)).toHaveLength(0);
  });

  it("renders under the requesting org only — org B never sees org A's lab-results documents", async () => {
    const orderIdB = await seedOrder(ORG_B, providerB);
    const patientIdB = randomUUID();
    const observationIdB = await seedObservation({
      organizationId: ORG_B,
      providerEntityId: providerB,
      orderId: orderIdB,
      patientId: patientIdB,
      sudRedacted: false,
    });
    await publishReceived({ organizationId: ORG_B, orderId: orderIdB, observationId: observationIdB });
    await dispatcher.tick();
    expect(await documentsFor(orderIdB)).toHaveLength(1);

    const b = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await b.connect();
    try {
      await b.query("BEGIN");
      await b.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      const { rows: seen } = await b.query(
        `SELECT count(*)::int AS n FROM document WHERE aggregate_id=$1`,
        [orderIdB],
      );
      expect(seen[0].n).toBe(0);
      await b.query("COMMIT");
    } finally {
      await b.end();
    }
  });
});
