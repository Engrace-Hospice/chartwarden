/**
 * GAP-051 — a requested PDF/XLSX export ACTUALLY COMPLETES, end to end, over real Postgres.
 *
 * The audit recorded this as "the export outbox was never bound due to a payload-shape mismatch". The
 * shape mismatch was already fixed at the catalog; what was actually missing was the whole other end:
 *
 *   · `exportOutbox` was unbound, so `POST /reporting/views/:id/export.pdf|xlsx` 503'd every time; and
 *   · M22 did not consume `m33.scheduled_report.render_requested` AT ALL — it appears in neither M22's
 *     subscribed list nor its anticipated one. M33 has declared `declaredConsumers: ["m22"]` on that
 *     event since it landed, so even the SCHEDULED path — which genuinely emits, and has a passing live
 *     test asserting the outbox row — had every request sit `pending` forever. The row was proof that
 *     M33 asked, not that anything answered; and
 *   · the request carried only `snapshotQuery`, a SELECT with literal `$1, $2, …` markers and no params
 *     channel (D4 keeps them separate on purpose). M22 has no reporting database and must never execute
 *     SQL handed to it over an event, so it could not have rendered from that under any binding. The
 *     producer that owns the query, the tx and the RLS scope now EXECUTES it and ships the rows.
 *
 * So this suite proves the chain with nothing stubbed but the object bytes: the real Drizzle export
 * service (as the NOBYPASSRLS `wardenx_app` role) → the real catalog-validating transactional publisher →
 * the REAL `createOutboxDispatcher` → M22's real render consumer + real `DocumentRenderer` → real
 * `document`/`document_version` rows → M33's real delivery consumer settling the occurrence.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m33:export-render:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { ReportDefinitionRepository, ReportViewRepository } from "@wardenx/reporting";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
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
import {
  M33_OUTBOX_EVENTS,
  buildDrizzleM33ExportDrilldownService,
  buildM33DocumentBackrefConsumer,
} from "../src/modules/33-reporting/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111161";
const ORG_B = "22222222-2222-2222-2222-222222222262";
const USER = "33333333-3333-3333-3333-333333333363";

describe.skipIf(!DB_URL)("GAP-051 — M33 export render, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let seedDb: ReturnType<typeof createDbClient>;
  let exportService: ReturnType<typeof buildDrizzleM33ExportDrilldownService>["service"];
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let objects: ReturnType<typeof createInMemoryObjectStore>;
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
  const memberOf: Record<string, string> = {};
  const viewOf: Record<string, string> = {};

  const actorFor = (org: string) => ({
    organizationId: org,
    userId: USER,
    membershipId: memberOf[org] as string,
    roles: ["administrator"],
  });

  /** Every outbox row for one aggregate, with its dispatch status (the relay's own record). */
  async function outboxFor(aggregateId: string) {
    const { rows } = await admin.query(
      "SELECT event_type, status, payload FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows as { event_type: string; status: string; payload: Record<string, unknown> }[];
  }
  /** The rendered document rows for one source aggregate (superuser read — RLS asserted separately). */
  async function documentsFor(aggregateId: string) {
    const { rows } = await admin.query(
      `SELECT d.id, d.organization_id, d.aggregate_type, d.patient_id, d.retention_class, d.title,
              v.version_number, v.minio_object_key AS object_key
         FROM document d JOIN document_version v ON v.document_id = d.id
        WHERE d.aggregate_id=$1 ORDER BY v.version_number`,
      [aggregateId],
    );
    return rows;
  }

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("DROP SCHEMA IF EXISTS report_mv CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of [...ROLES, "report_writer"])
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

  /** One `admission` row for `org` — the census MV's source, so a refresh has something real to roll up. */
  async function seedCensusAdmission(org: string, label: string): Promise<void> {
    const providerEntity = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-X${label}`, `Provider ${label}`, `NPI-X${label}`],
      )
    ).rows[0].id as string;
    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-X${label}`],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO admission (organization_id, provider_entity_id, location_id, patient_id, admitted_by_physician_id, status, activated_at)
       VALUES ($1,$2,$3, gen_random_uuid(), gen_random_uuid(),'active', now())`,
      [org, providerEntity, location],
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-exp-a','A','A'),($2,'org-exp-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'export@x.test')`, [USER]);
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
    seedDb = createDbClient({ connectionString: DB_URL as string });

    // Real census rows for BOTH tenants, then a REFRESH so the translated SELECT returns something —
    // an export of an empty result would render just as happily and prove much less.
    await seedCensusAdmission(ORG_A, "a");
    await seedCensusAdmission(ORG_B, "b");
    await admin.query("REFRESH MATERIALIZED VIEW report_mv.mv_census_org_daily");

    for (const org of [ORG_A, ORG_B]) {
      const defRepo = new ReportDefinitionRepository(seedDb.db);
      const definition = await defRepo.createDefinition({
        organizationId: org,
        authorship: "tenant",
        baseKey: "census_org_daily",
        ownerMembershipId: memberOf[org] as string,
        displayName: "Daily Census (export test)",
      });
      const version = await defRepo.createVersion({
        definitionId: definition.id,
        organizationId: org,
        versionNumber: 1,
        spec: {
          dimensions: [{ dimensionKey: "census_day" }],
          measures: [{ measureKey: "active_patient_count" }],
          filters: [],
          // The `census_org_daily` base's own maxRowLimit is 10000, which is ABOVE the §4.8 PDF cap of
          // 5000 — so a PDF export of an unconstrained view legitimately 413s. Pinned under the cap here
          // so the PDF path is exercisable; the cap itself is asserted separately below.
          rowLimit: 500,
        },
        status: "published",
      });
      const view = await new ReportViewRepository(seedDb.db).create({
        organizationId: org,
        definitionVersionId: version.id,
        ownerMembershipId: memberOf[org] as string,
        displayName: `Census Export — ${org === ORG_A ? "A" : "B"}`,
      });
      viewOf[org] = view.id;
    }

    // The REAL catalog-validating transactional publisher: a payload that does not match M33's declared
    // schema is refused here, so the render request under test is contract-checked before it is stored.
    // Every producer M22's ONE render consumer subscribes to must be in the catalog: the dispatcher
    // REFUSES to construct on a consumer binding an event type the catalog does not know
    // ("binds unknown catalog event"). That refusal is the reason M22's subscription list and the boot
    // catalog can never drift apart silently.
    const catalog = buildBootOutboxCatalog([
      M11_OUTBOX_EVENTS,
      M12_OUTBOX_EVENTS,
      M13_OUTBOX_EVENTS,
      M21_OUTBOX_EVENTS,
      M22_OUTBOX_EVENTS,
      M23_OUTBOX_EVENTS,
      M33_OUTBOX_EVENTS,
    ]);
    publisher = buildTxOutboxPublisher(catalog);
    const m33Outbox = {
      publish: (tx: unknown, input: Parameters<typeof publisher.publish>[1]) =>
        publisher.publish(tx as never, { ...input, callerModule: "m33" }),
    };
    exportService = buildDrizzleM33ExportDrilldownService({
      db: handle.db,
      outbox: m33Outbox as never,
    }).service;

    objects = createInMemoryObjectStore();
    // Stub enumerator only — no platform credential needed to exercise per-org claim/deliver/finalize.
    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      eventCatalog: catalog,
      consumers: [
        buildM22DocumentRequestConsumer({
          store: createDrizzleDocumentSeamStore(handle.db),
          renderer: () =>
            createDocumentRenderer({
              store: createDrizzleDocumentSeamStore(handle.db),
              objects: objects.store,
            }),
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
        }),
        buildM33DocumentBackrefConsumer({
          db: handle.db,
          emitDelivered: ({ organizationId, ...payload }) =>
            withOrgContext(handle.db, { organizationId, userId: "" }, (tx) =>
              publisher.publish(tx as never, {
                eventName: "m33.scheduled_report.delivered",
                payload: { ...payload, organizationId },
                organizationId,
                aggregateKind: "report_schedule_run",
                aggregateId: payload.runId,
                callerModule: "m33",
              }),
            ),
        }),
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (seedDb) await seedDb.close();
    if (admin) await admin.end();
  });

  /** Drain until nothing more is claimable (render → announce → back-ref is three dispatcher hops). */
  async function drain(times = 4) {
    for (let i = 0; i < times; i += 1) await dispatcher.tick();
  }

  it("the ad-hoc export route path emits a render request carrying the EXECUTED snapshot", async () => {
    const res = await exportService.requestExport(
      actorFor(ORG_A),
      viewOf[ORG_A] as string,
      "pdf",
      "",
    );
    expect(res.status).toBe("render_requested");

    const rows = await outboxFor(res.exportId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe("m33.scheduled_report.render_requested");

    const p = rows[0]?.payload as Record<string, unknown>;
    expect(p.aggregateType).toBe("report_export");
    expect(p.format).toBe("pdf");
    expect(p.title).toBe("Census Export — A");
    // THE fix: the request carries rows, not just a query string M22 could never run. The MV was
    // refreshed with one admission per tenant, so org A's export must see exactly its own.
    expect(p.columns).toHaveLength(2);
    expect((p.rows as unknown[]).length).toBeGreaterThan(0);
    expect(p.rowCount).toBe((p.rows as unknown[]).length);
    // …and the SELECT still rides along as provenance.
    expect(String(p.snapshotQuery)).toContain("select_mv_census_org_daily");
  });

  it("M22 drains that request into a real document — the export completes", async () => {
    const res = await exportService.requestExport(
      actorFor(ORG_A),
      viewOf[ORG_A] as string,
      "xlsx",
      "",
    );
    await drain();

    const [doc] = await documentsFor(res.exportId);
    expect(doc, "no document was rendered for the export").toBeDefined();
    expect(doc.aggregate_type).toBe("report_export");
    expect(doc.organization_id).toBe(ORG_A);
    expect(doc.retention_class).toBe("operational");
    expect(doc.title).toBe("Census Export — A");
    // A report is aggregate-only (D6) — no chart target.
    expect(doc.patient_id).toBeNull();

    // THE POINT OF THE WHOLE CHANGE: the rendered bytes contain the report's own ROWS. Before this, the
    // request carried a SELECT string; whatever M22 rendered from it could not have been the report.
    const stored = [...objects.objects.entries()].find(([k]) => k.endsWith(doc.object_key));
    expect(stored, `no stored object for ${doc.object_key}`).toBeDefined();
    const body = new TextDecoder().decode(stored?.[1] as Uint8Array);
    expect(body).toContain("census_day");
    expect(body).toContain("active_patient_count");

    const [row] = await outboxFor(res.exportId);
    expect(row?.status).toBe("dispatched");
  });

  it("the scheduled path settles its occurrence `delivered` with the M22 document_id", async () => {
    // A real schedule + a real occurrence parked at `rendered_pending`, exactly where the runner leaves it.
    const scheduleId = (
      await admin.query(
        `INSERT INTO report_schedule (organization_id, report_view_id, owner_membership_id, cron_expression,
           tenant_timezone, format, recipient_membership_ids, delivery_channel, status)
         VALUES ($1,$2,$3,'0 6 * * *','America/New_York','pdf',$4::jsonb,'in_app','active') RETURNING id`,
        [ORG_A, viewOf[ORG_A], memberOf[ORG_A], JSON.stringify([memberOf[ORG_A]])],
      )
    ).rows[0].id as string;
    const scheduledFor = new Date("2026-08-13T10:00:00.000Z");
    const runId = (
      await admin.query(
        `INSERT INTO report_schedule_run (organization_id, schedule_id, scheduled_for, status)
         VALUES ($1,$2,$3,'rendered_pending') RETURNING id`,
        [ORG_A, scheduleId, scheduledFor],
      )
    ).rows[0].id as string;

    // Publish through the REAL producer contract (the runner's own payload shape).
    await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      publisher.publish(tx as never, {
        eventName: "m33.scheduled_report.render_requested",
        payload: {
          scheduleId,
          runId,
          viewId: viewOf[ORG_A] as string,
          format: "pdf",
          organizationId: ORG_A,
          snapshotQuery: "SELECT 1",
          idempotencyKey: runId,
          aggregateType: "report_schedule_run",
          title: "Weekly Census",
          columns: [{ key: "census_day", sourceKey: "census_day", kind: "dimension" }],
          rows: [{ census_day: "2026-08-01" }],
          rowCount: 1,
        },
        organizationId: ORG_A,
        aggregateKind: "report_schedule_run",
        aggregateId: runId,
        callerModule: "m33",
      }),
    );

    await drain();

    // 1. M22 filed it under the OCCURRENCE's own aggregate type, with its own title.
    const [doc] = await documentsFor(runId);
    expect(doc, "no document was rendered for the scheduled run").toBeDefined();
    expect(doc.aggregate_type).toBe("report_schedule_run");
    expect(doc.title).toBe("Weekly Census");

    // 2. …and M33's delivery consumer settled the occurrence. Both halves: the column the run built for
    //    exactly this, and the terminal status. An UPDATE against a row that does not exist is a silent
    //    zero-row no-op, which is why the run is seeded first and both fields are asserted.
    const { rows: runRows } = await admin.query(
      "SELECT status, document_id, finished_at FROM report_schedule_run WHERE id=$1",
      [runId],
    );
    expect(runRows[0].document_id).toBe(doc.id);
    expect(runRows[0].status).toBe("delivered");
    expect(runRows[0].finished_at).not.toBeNull();
  });

  // The §4.8 gate is real and stays real: this base's own maxRowLimit (10000) is ABOVE the PDF cap, so a
  // view that does not pin a smaller `row_limit` legitimately refuses to render as PDF — before any
  // handshake is emitted. Asserted here so "PDF works now" is not read as "the cap was removed".
  it("still refuses a PDF whose view exceeds the 5000-row cap, emitting nothing", async () => {
    const defRepo = new ReportDefinitionRepository(seedDb.db);
    const definition = await defRepo.createDefinition({
      organizationId: ORG_A,
      authorship: "tenant",
      baseKey: "census_org_daily",
      ownerMembershipId: memberOf[ORG_A] as string,
      displayName: "Unbounded census",
    });
    const version = await defRepo.createVersion({
      definitionId: definition.id,
      organizationId: ORG_A,
      versionNumber: 1,
      spec: {
        dimensions: [{ dimensionKey: "census_day" }],
        measures: [{ measureKey: "active_patient_count" }],
        filters: [],
      },
      status: "published",
    });
    const view = await new ReportViewRepository(seedDb.db).create({
      organizationId: ORG_A,
      definitionVersionId: version.id,
      ownerMembershipId: memberOf[ORG_A] as string,
      displayName: "Unbounded census view",
    });

    const before = (await admin.query("SELECT count(*)::int AS n FROM outbox_event")).rows[0].n;
    await expect(exportService.requestExport(actorFor(ORG_A), view.id, "pdf", "")).rejects.toThrow(
      /PDF_ROW_LIMIT_EXCEEDED/,
    );
    // Fail-closed: the gate runs before the emit, so no render was requested.
    expect((await admin.query("SELECT count(*)::int AS n FROM outbox_event")).rows[0].n).toBe(
      before,
    );

    // …and the same view exports fine as XLSX, which carries no cap.
    const xlsx = await exportService.requestExport(actorFor(ORG_A), view.id, "xlsx", "");
    expect(xlsx.status).toBe("render_requested");
  });

  it("keeps one tenant's export invisible to the other under real RLS", async () => {
    const a = await exportService.requestExport(
      actorFor(ORG_A),
      viewOf[ORG_A] as string,
      "pdf",
      "",
    );
    await drain();
    const [doc] = await documentsFor(a.exportId);
    expect(doc).toBeDefined();

    // Org B, on the same NOBYPASSRLS connection, sees none of org A's documents…
    const visibleToB = await withOrgContext(
      handle.db,
      { organizationId: ORG_B, userId: "" },
      async (tx) => {
        const res = await tx.execute(
          `SELECT count(*)::int AS n FROM document WHERE aggregate_id = '${a.exportId}'` as never,
        );
        return (res.rows[0] as { n: number }).n;
      },
    );
    expect(visibleToB).toBe(0);

    // …and B's own export resolves B's own view, not A's.
    const b = await exportService.requestExport(
      actorFor(ORG_B),
      viewOf[ORG_B] as string,
      "pdf",
      "",
    );
    const [bRow] = await outboxFor(b.exportId);
    expect((bRow?.payload as { title: string }).title).toBe("Census Export — B");

    // Cross-tenant: B may not export A's view at all.
    await expect(
      exportService.requestExport(actorFor(ORG_B), viewOf[ORG_A] as string, "pdf", ""),
    ).rejects.toThrow();
  });
});
