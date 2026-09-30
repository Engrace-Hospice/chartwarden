/**
 * F-108 (#103) — M27's half of the §4.4 / §4.10 document-render handshake, END TO END over real Postgres.
 *
 * `ecr_submission.ecr_file_document_id`, `.pi_file_document_id` and `.supporting_documents_document_ids`
 * are where M27 holds the Electronic Cost Report, the Print Image and the supporting bundle. The
 * `EcrSubmissionRepository.update` that accepts all three shipped with M27-T05; nothing ever called it with
 * one. `handleDocumentRendered` — the pure decider — shipped with M27-T09 with NO caller and NO test, its
 * absence recorded as "the live inbound transactional-outbox dispatcher accessor lands (RULE 3(d))", a
 * platform phase that landed. So since F-099 bound the REQUEST half, every submitted cost report has
 * rendered a real document into MinIO and pointed at nothing.
 *
 * Nothing is stubbed here but the object bytes: `runEcrGeneration` (the real §4.8 processor) → the REAL
 * catalog-validating transactional publisher → the REAL `createOutboxDispatcher` → M22's REAL render
 * consumer + `DocumentRenderer` + Drizzle seam store → M27's REAL back-ref consumer, all as the NOBYPASSRLS
 * `wardenx_app` role. Org B must see none of it.
 *
 * NOTE — the supporting-doc REQUEST has no producer: `runEcrGeneration` emits `ecr` and `pi` only, and no
 * other code path emits `m27.artifact.render_requested` at all. The append branch is reachable from the
 * handler and from here; that the third artifact is never asked for is a producer-side absence, reported.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m27:ecr-backref:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { ConnectionOptions } from "bullmq";
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
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { M14_OUTBOX_EVENTS } from "../src/modules/14-idg/index";
import { M15_OUTBOX_EVENTS } from "../src/modules/15-discipline-care-plans/index";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/index";
import { M17_OUTBOX_EVENTS } from "../src/modules/17-scheduling/index";
import { M18_OUTBOX_EVENTS } from "../src/modules/18-evv/index";
import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/index";
import { M21_OUTBOX_EVENTS } from "../src/modules/21-supplies/index";
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
import {
  M27_OUTBOX_EVENTS,
  buildM27DocumentBackrefConsumer,
  buildM27WorkerDeps,
  runEcrGeneration,
} from "../src/modules/27-cost-report/index";
import { M33_OUTBOX_EVENTS } from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
/** `runEcrGeneration` never opens a Valkey connection — `buildM27WorkerDeps` is pure data assembly and the
 *  processor touches repos + the outbox only. Constructing a `Worker` is what would dial, and none is. */
const NO_QUEUE: ConnectionOptions = { host: "127.0.0.1", port: 1 };

describe.skipIf(!DB_URL)("F-108 — M27 ECR/PI back-reference handshake, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
  const memberOf: Record<string, string> = {};

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

  /** Seed a cost report + snapshot + `generating` submission for one org; returns the ids. */
  async function seedSubmission(
    org: string,
  ): Promise<{ reportId: string; submissionId: string; snapshotId: string }> {
    const reportId = randomUUID();
    const snapshotId = randomUUID();
    const submissionId = randomUUID();
    await admin.query(
      `INSERT INTO cost_report (id,organization_id,provider_entity_id,fiscal_year_start_date,fiscal_year_end_date,state)
       VALUES ($1,$2,$3,'2027-01-01','2027-12-31','submitted')`,
      [reportId, org, randomUUID()], // uniq_cost_report_provider_fye — one report per (provider, FYE)
    );
    await admin.query(
      `INSERT INTO cost_report_snapshot
         (id,organization_id,cost_report_id,content_hash_sha256,materialized_inputs,worksheet_snapshot,reason,created_by_membership_id)
       VALUES ($1,$2,$3,$4,'{}'::jsonb,'{}'::jsonb,'submit',$5)`,
      [snapshotId, org, reportId, "a".repeat(64), memberOf[org]],
    );
    await admin.query(
      `INSERT INTO ecr_submission (id,organization_id,cost_report_id,snapshot_id,status)
       VALUES ($1,$2,$3,$4,'generating')`,
      [submissionId, org, reportId, snapshotId],
    );
    return { reportId, submissionId, snapshotId };
  }

  async function submissionRow(id: string) {
    const { rows } = await admin.query(
      `SELECT status, ecr_file_document_id, pi_file_document_id, supporting_documents_document_ids
         FROM ecr_submission WHERE id=$1`,
      [id],
    );
    return rows[0];
  }

  async function documentsFor(aggregateId: string) {
    const { rows } = await admin.query(
      `SELECT id, organization_id, aggregate_type FROM document WHERE aggregate_id=$1 ORDER BY aggregate_type`,
      [aggregateId],
    );
    return rows;
  }

  async function outboxFor(aggregateId: string): Promise<{ type: string; status: string }[]> {
    const { rows } = await admin.query(
      "SELECT event_type, status FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => ({ type: r.event_type as string, status: r.status as string }));
  }

  /** Drop the dispatcher's `(eventId, consumerName)` receipts so the SAME rows redeliver — how an
   *  at-least-once relay actually behaves, and the only way to test the idempotency of the writes. */
  async function redeliver(eventTypes: string[]) {
    await admin.query(
      `DELETE FROM outbox_consumer_receipt r USING outbox_event e
        WHERE r.event_id = e.id AND e.event_type = ANY($1::text[])`,
      [eventTypes],
    );
    await admin.query(
      "UPDATE outbox_event SET status='pending', attempt_count=0 WHERE event_type = ANY($1::text[])",
      [eventTypes],
    );
    await dispatcher.tick();
  }

  function workerDeps(): ReturnType<typeof buildM27WorkerDeps> {
    return buildM27WorkerDeps({
      connection: NO_QUEUE,
      db: handle.db,
      outbox: {
        publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m27" }),
      },
    });
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m27-backref@x.test')`, [USER]);
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

    // M22's ONE render consumer binds every `*.document_requested` name it subscribes to, and the
    // dispatcher REFUSES to construct on an event its catalog does not carry — so every producer of a
    // consumed request event has to contribute here even though this suite only exercises M27's.
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
      // F-144 (#248) — M22's render consumer now also subscribes to
      // `m24.medicaid_billing.document_render_requested`; same reason every sibling entry here is.
      M24_OUTBOX_EVENTS,
      M25_OUTBOX_EVENTS,
      M27_OUTBOX_EVENTS,
      M33_OUTBOX_EVENTS,
      M37_OUTBOX_EVENTS,
    ]);
    publisher = buildTxOutboxPublisher(catalog);

    const objects = createInMemoryObjectStore();
    const store = createDrizzleDocumentSeamStore(handle.db);
    const renderer = createDocumentRenderer({ store, objects: objects.store });
    const renderConsumer = buildM22DocumentRequestConsumer({
      store,
      renderer: () => renderer,
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
      consumers: [
        renderConsumer,
        buildM27DocumentBackrefConsumer({
          db: handle.db,
          outbox: {
            publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m27" }),
          },
        }),
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  let submissionA: { reportId: string; submissionId: string; snapshotId: string };

  it("the ecr-generation job requests both artifacts and carries the real ECR text, not the snapshot id", async () => {
    submissionA = await seedSubmission(ORG_A);
    await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      runEcrGeneration(tx as unknown as DbClient, workerDeps(), {
        organizationId: ORG_A,
        costReportId: submissionA.reportId,
        submissionId: submissionA.submissionId,
        snapshotId: submissionA.snapshotId,
      }),
    );

    expect((await submissionRow(submissionA.submissionId)).status).toBe("generated");
    const { rows } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m27.artifact.render_requested'",
      [submissionA.submissionId],
    );
    // EXACTLY two. F-108 removed the submit path's own emission, which requested `ecr` a second time
    // carrying `payloadRef: snapshot.id`; written first, it won M22's `(sourceEvent, aggregateType,
    // aggregateId)` idempotency and made the job's — the one holding the real file — an idempotent_skip.
    expect(rows).toHaveLength(2);
    const byKind = Object.fromEntries(rows.map((r) => [r.payload.artifactKind, r.payload]));
    expect(Object.keys(byKind).sort()).toEqual(["ecr", "pi"]);
    // The `payloadRef` is the ECR FILE, not an id. The emission F-108 removed carried `snapshot.id`
    // here, so the document M22 rendered was a serialization of the request envelope with a UUID where
    // the file's contents belong — and it was the one that won the idempotency check.
    expect(byKind.ecr.payloadRef).not.toBe(submissionA.snapshotId);
    expect(String(byKind.ecr.payloadRef)).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("the relay renders both artifacts and stamps both back-reference columns", async () => {
    let row = await submissionRow(submissionA.submissionId);
    expect(row.ecr_file_document_id).toBeNull();
    expect(row.pi_file_document_id).toBeNull();

    await dispatcher.tick(); // renders; emits m22.document.rendered
    await dispatcher.tick(); // delivers the rendered events to M27's back-ref consumer

    const docs = await documentsFor(submissionA.submissionId);
    expect(docs.map((d) => d.aggregate_type)).toEqual(["cost_report_ecr", "cost_report_pi"]);

    row = await submissionRow(submissionA.submissionId);
    expect(row.ecr_file_document_id).toBe(docs[0].id);
    expect(row.pi_file_document_id).toBe(docs[1].id);
  });

  it("each stamp announces itself as m27.artifact.stored_back_reference", async () => {
    await dispatcher.tick(); // the announcements were written during the previous tick; settle them
    // The announcement's aggregate is the SUBMISSION, not the document — it is a statement about the
    // `ecr_submission` row that just gained a column value.
    const emitted = await outboxFor(submissionA.submissionId);
    expect(emitted.filter((e) => e.type === "m27.artifact.stored_back_reference")).toHaveLength(2);
    // Record-only in the catalog (`declaredConsumers: []`), so the relay finalizes it rather than
    // holding it pending — the difference between an announcement and a permanent backlog row.
    expect(
      emitted
        .filter((e) => e.type === "m27.artifact.stored_back_reference")
        .every((e) => e.status === "dispatched"),
    ).toBe(true);
  });

  it("a redelivery does not overwrite a stamped column or duplicate a bundle entry", async () => {
    const before = await submissionRow(submissionA.submissionId);
    // Not vacuous: this asserts a STAMPED column survives, so it fails rather than passes when nothing
    // was ever stamped.
    expect(before.ecr_file_document_id).not.toBeNull();
    expect(before.pi_file_document_id).not.toBeNull();
    await redeliver(["m22.document.rendered"]);
    const after = await submissionRow(submissionA.submissionId);
    expect(after.ecr_file_document_id).toBe(before.ecr_file_document_id);
    expect(after.pi_file_document_id).toBe(before.pi_file_document_id);
  });

  it("a supporting document APPENDS to the bundle, and appends it only once", async () => {
    const docId = randomUUID();
    const rendered = {
      documentId: docId,
      documentVersionId: randomUUID(),
      versionNumber: 1,
      isFirstVersion: true,
      templateKey: "cost_report_supporting_doc",
      aggregateType: "cost_report_supporting_doc",
      aggregateId: submissionA.submissionId,
      retentionClass: "compliance",
      patientId: null,
      sourceEvent: "m27.artifact.render_requested",
      sourceModule: "m27",
      renderedAt: new Date().toISOString(),
    };
    await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      publisher.publish(tx as never, {
        eventName: M22_DOCUMENT_RENDERED_EVENT,
        payload: rendered,
        organizationId: ORG_A,
        aggregateKind: "document",
        aggregateId: docId,
        callerModule: "m22",
      }),
    );
    await dispatcher.tick();
    expect(
      (await submissionRow(submissionA.submissionId)).supporting_documents_document_ids,
    ).toEqual([docId]);

    await redeliver(["m22.document.rendered"]);
    expect(
      (await submissionRow(submissionA.submissionId)).supporting_documents_document_ids,
    ).toEqual([docId]);
  });

  it("a document another module requested is a deliberate no-op", async () => {
    const fresh = await seedSubmission(ORG_A);
    const docId = randomUUID();
    await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      publisher.publish(tx as never, {
        eventName: M22_DOCUMENT_RENDERED_EVENT,
        payload: {
          documentId: docId,
          documentVersionId: randomUUID(),
          versionNumber: 1,
          isFirstVersion: true,
          templateKey: "order_record",
          aggregateType: "order_record",
          // Deliberately the M27 submission id: only `sourceModule` separates this from a real M27
          // render, and a consumer keying on the aggregate alone would stamp a foreign document.
          aggregateId: fresh.submissionId,
          retentionClass: "clinical_record",
          patientId: null,
          sourceEvent: "m11.order.document_requested",
          sourceModule: "m11",
          renderedAt: new Date().toISOString(),
        },
        organizationId: ORG_A,
        aggregateKind: "document",
        aggregateId: docId,
        callerModule: "m22",
      }),
    );
    await dispatcher.tick();
    const row = await submissionRow(fresh.submissionId);
    expect(row.ecr_file_document_id).toBeNull();
    expect(row.pi_file_document_id).toBeNull();
    expect(row.supporting_documents_document_ids).toEqual([]);
  });

  it("org A's rendered artifact never reaches org B's submission", async () => {
    const b = await seedSubmission(ORG_B);
    const docId = randomUUID();
    // Published under ORG_A while naming ORG_B's submission id — the cross-tenant attempt. RLS scopes
    // the consumer's UPDATE to app.org_id, and the org predicate is explicit beside it.
    await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      publisher.publish(tx as never, {
        eventName: M22_DOCUMENT_RENDERED_EVENT,
        payload: {
          documentId: docId,
          documentVersionId: randomUUID(),
          versionNumber: 1,
          isFirstVersion: true,
          templateKey: "cost_report_ecr",
          aggregateType: "cost_report_ecr",
          aggregateId: b.submissionId,
          retentionClass: "compliance",
          patientId: null,
          sourceEvent: "m27.artifact.render_requested",
          sourceModule: "m27",
          renderedAt: new Date().toISOString(),
        },
        organizationId: ORG_A,
        aggregateKind: "document",
        aggregateId: docId,
        callerModule: "m22",
      }),
    );
    await dispatcher.tick();
    expect((await submissionRow(b.submissionId)).ecr_file_document_id).toBeNull();
  });
});
