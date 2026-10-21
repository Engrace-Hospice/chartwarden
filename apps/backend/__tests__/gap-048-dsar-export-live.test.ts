/**
 * GAP-048 — M34's DSAR-export worker + download route, proven end-to-end over real Postgres.
 *
 * Before this fix: `PresignDownloadPort.presign` was a hardcoded fail-closed stub (no `/download` route
 * could ever succeed), AND (a deeper gap the audit's evidence didn't name) the entire worker that
 * produces a fulfilled bundle was ALSO unbound (6 stub ports in `saas-jobs.ts`'s `dsarExport` block) —
 * meaning no DSAR export job could ever reach `fulfilled` in production, so the presign fix alone would
 * have been unreachable dead code. This test drives the REAL bound pieces:
 *   1. `requestDsarExport` (service-drizzle.ts) inserts the job + enqueues the FULL DsarExportJobInput
 *      shape (not just `{jobId}` — the worker needs `orgId` before it can open `withOrgContext`).
 *   2. The worker's ports (`buildM34WorkerPorts(...).dsarExport`) are built the SAME way
 *      `registerM34DsarExportWorker` builds them per job — real `PatientReader` seam resolve, a real
 *      `TenantExportShard` fan-out, a real (in-memory-object-store-backed) gzip NDJSON Bundle PUT, real
 *      `DsarExportRepository` writes, a DIRECT `DocumentRenderer.render()` call (GAP-048 — replaced the
 *      dead `m22.document.upload_requested` outbox event that had no catalog entry and no consumer), and
 *      the REAL catalog-validating transactional outbox publisher for `m34.dsar_export.completed`.
 *   3. Once `fulfilled`, `dsarDownloadUrl` (via `buildDrizzleTenantService`) mints a REAL presigned URL
 *      through `getSeam("DocumentStorageProvider")` — the exact route GAP-048 was filed against.
 *
 * No live MinIO/S3 server is stood up here (nothing in this repo does — even M22's own object-store IO
 * is only unit-tested via `createS3ObjectStore`'s pure SigV4 math, `document-s3-object-store.test.ts`;
 * every M22 "live" test drives `createInMemoryObjectStore()`, never a real network PUT). This test
 * follows that SAME established convention — the in-memory `ObjectStorePort` substitutes for the one
 * piece that would need real infra, while everything else (DB writes, RLS, seam resolution, the worker's
 * own orchestration, the outbox catalog validation, the presign port) runs for real.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/gap-048-dsar-export-live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import {
  type DsarExportJobInput,
  M34_DSAR_EXPORT_COMPLETED,
  type TenantExportShard,
  __resetModule34SeamsForTest,
  registerTenantExportShard,
  runDsarExportJob,
} from "@chartwarden/saas-tenant-platform";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDrizzlePatientReaderStore } from "../src/modules/05-patient/index";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import {
  createInMemoryObjectStore,
  registerDocumentSeams,
} from "../src/modules/22-documents/index";
import { getDocumentRenderer } from "../src/modules/22-documents/index";
import {
  M34_OUTBOX_EVENTS,
  buildDrizzleTenantService,
  buildM34WorkerDeps,
  buildM34WorkerPorts,
} from "../src/modules/34-saas-tenant-platform/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "tenant_platform_writer",
];
const ORG = "33333333-3333-3333-3333-333333333333";
const ACTOR_MEMBERSHIP = "44444444-4444-4444-4444-444444444444";

/** A fake `TenantExportShard` — proves the fan-out actually runs, without needing a real PHI module. */
function fakeShard(moduleKey: string): TenantExportShard {
  return {
    moduleKey,
    async streamShardForOrg() {
      return { rowCount: 0, tableCount: 0, sha256: "unused" };
    },
    async streamDsarShardForPatient(_orgId, patientId, sink) {
      await sink.write({ resourceType: "Observation", id: `${moduleKey}-1`, subject: patientId });
      return { resourceCount: 1, sha256: "unused" };
    },
  };
}

describe.skipIf(!DB_URL)("GAP-048 — M34 DSAR export, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let patientId: string;
  let actorUserId: string;
  let objects: ReturnType<typeof createInMemoryObjectStore>["store"];

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

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-gap048','GAP-048','GAP-048')",
      [ORG],
    );
    await admin.query(
      `INSERT INTO tenant_account (organization_id, legal_business_name, billing_contact_email, breach_notification_email)
       VALUES ($1,'GAP-048 Hospice LLC','billing@gap048.example','breach@gap048.example')`,
      [ORG],
    );
    // `dsar_export_job_event` is `PARTITION BY LIST (organization_id)` (migration 0051) with NO automatic
    // per-org partition provisioning anywhere (OPS-021, still deferred) — every live test that writes to
    // it must create its own org partition, mirroring `m34-rls-isolation.live.test.ts`'s established
    // pattern, or every INSERT 500s with "no partition of relation found for row".
    await admin.query(
      `CREATE TABLE "dsar_export_job_event_gap048" PARTITION OF "dsar_export_job_event" FOR VALUES IN ('${ORG}')`,
    );
    patientId = (
      await admin.query(
        `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,'MRN-GAP048','Dana','Dsar','1955-03-14','F','active') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    // The M4 write-audit trigger FKs `app.user_id` to a real `user` row — `requestDsarExport`'s route
    // layer sets it from the ambient request context (empty in this test, so it must be set explicitly).
    actorUserId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        "gap048-actor@x.test",
      ])
    ).rows[0].id as string;
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });

    // Real seams: PatientReader (M5, Drizzle-backed) + Document{Renderer,StorageProvider} (M22, real
    // Drizzle-independent renderer logic over an in-memory object store — see file docstring).
    registerPatientSeams({
      db: handle.db,
      readerStore: createDrizzlePatientReaderStore(handle.db),
    });
    objects = createInMemoryObjectStore().store;
    registerDocumentSeams({ objects });
    __resetModule34SeamsForTest();
    registerTenantExportShard(fakeShard("m05"));
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("runs the real worker ports end-to-end: fan-out, real Bundle PUT, direct M22 render, catalog-valid completion emit", async () => {
    const jobId = (
      await admin.query(
        `INSERT INTO dsar_export_job (organization_id, patient_id, request_source, requestor_identity_verification_evidence, requesting_membership_id, status, sla_due_at)
         VALUES ($1,$2,'patient','ID verified via phone callback','${ACTOR_MEMBERSHIP}','requested',NOW()+interval '30 days') RETURNING id`,
        [ORG, patientId],
      )
    ).rows[0].id as string;

    const jobInput: DsarExportJobInput = {
      jobId,
      orgId: ORG,
      tenantAccountId: "unused-in-worker-logic",
      patientId,
    };

    const txOutboxPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M34_OUTBOX_EVENTS]));
    // Built the way the PRODUCTION registrar builds it (`registerM34DsarExportWorker`): the pooled
    // handle plus an explicit `orgScope`, with NO transaction held open around the job. Passing a `tx`
    // as `db` would make each port's own `withOrgContext` a SAVEPOINT rather than a real transaction,
    // so the suite would stop exercising the per-port tenancy envelope that replaced the job-long one.
    const result = await (async () => {
      const ports = buildM34WorkerDeps({
        connection: {} as never, // never read by buildM34WorkerPorts — no real BullMQ/Redis needed here
        db: handle.db,
        dsarExport: {
          objectStore: {
            async putObject({ organizationId, objectKey, bytes }) {
              return objects.putObject({ bucket: `tenant-${organizationId}`, objectKey, bytes });
            },
          },
          render: {
            render: (args) =>
              getDocumentRenderer().render({ orgId: args.organizationId }, "dsar_bundle", args),
          },
          outbox: {
            publish: (publishTx, input) =>
              txOutboxPublisher.publish(publishTx as never, { ...input, callerModule: "m34" }),
          },
        },
      });
      // `orgScope` is added HERE, not in `buildM34WorkerDeps` (whose parameter type cannot express it)
      // — exactly as `registerM34DsarExportWorker` does with `{ ...deps, orgScope: data.orgId }`.
      return runDsarExportJob(
        jobInput,
        buildM34WorkerPorts({ ...ports, orgScope: ORG }).dsarExport,
      );
    })();

    // The fan-out actually ran (one resource from the fake m05 shard).
    expect(result.shardReceipts.map((r) => r.moduleKey)).toEqual(["m05"]);
    expect(result.resourceCount).toBe(1);
    expect(result.status).toBe("review_pending");
    expect(result.bundleDocumentId).toBeTruthy();

    // The Bundle really landed in the object store — a valid FHIR R4 collection Bundle, gzip-compressed.
    const stored = await objects.inspectObject({
      bucket: `tenant-${ORG}`,
      objectKey: result.bundleMinioObjectKey,
    });
    expect(stored).not.toBeNull();
    expect(stored?.byteSize).toBeGreaterThan(0);

    // The job row itself carries the real artifacts (not the old async-backref-consumer null).
    const { rows: jobRows } = await admin.query(
      "SELECT status, bundle_minio_object_key, bundle_sha256, bundle_document_id FROM dsar_export_job WHERE id=$1",
      [jobId],
    );
    expect(jobRows[0].status).toBe("review_pending");
    expect(jobRows[0].bundle_minio_object_key).toBe(result.bundleMinioObjectKey);
    expect(jobRows[0].bundle_document_id).toBe(result.bundleDocumentId);

    // GAP-048: exactly ONE outbox event — the dead m22.document.upload_requested emit is gone, and the
    // remaining m34.dsar_export.completed passed the REAL catalog validation (would have thrown
    // `unknown_event`/schema-mismatch otherwise, rolling back the whole transaction).
    const { rows: outboxRows } = await admin.query(
      "SELECT event_type, payload FROM outbox_event WHERE aggregate_id=$1",
      [jobId],
    );
    expect(outboxRows.map((r) => r.event_type)).toEqual([M34_DSAR_EXPORT_COMPLETED]);
    expect(outboxRows[0].payload.bundleDocumentId).toBe(result.bundleDocumentId);

    // §164.528 ledger landed too.
    const { rows: eventRows } = await admin.query(
      "SELECT event_kind FROM dsar_export_job_event WHERE dsar_export_job_id=$1 ORDER BY occurred_at",
      [jobId],
    );
    expect(eventRows.map((r) => r.event_kind)).toEqual([
      "generation_started",
      "shard_received",
      "bundle_assembled",
      "bundle_uploaded",
    ]);
  });

  it("dsarDownloadUrl mints a real presigned URL once fulfilled — the route GAP-048 was filed against", async () => {
    // A second, already-fulfilled job (independent of the worker run above — proves the ROUTE-layer
    // presign fix in isolation, exactly matching GAP-048's original evidence: `GET .../download`).
    const jobId = (
      await admin.query(
        `INSERT INTO dsar_export_job (organization_id, patient_id, request_source, requestor_identity_verification_evidence, requesting_membership_id, status, sla_due_at, bundle_minio_object_key, bundle_sha256)
         VALUES ($1,$2,'patient','ID verified via phone callback','${ACTOR_MEMBERSHIP}','fulfilled',NOW()+interval '30 days','exports/dsar/manual-fixture.ndjson.gz','deadbeef') RETURNING id`,
        [ORG, patientId],
      )
    ).rows[0].id as string;
    // Back the object the presign will target — presignDownload doesn't require the object to exist
    // (SigV4 presign is a pure signing operation, not a HEAD check), but seed it anyway for realism.
    await objects.putObject({
      bucket: `tenant-${ORG}`,
      objectKey: "exports/dsar/manual-fixture.ndjson.gz",
      bytes: new TextEncoder().encode("fixture"),
    });

    const { service } = buildDrizzleTenantService({
      db: handle.db,
      enqueue: { async enqueue() {} },
    });
    const download = await runWithRequestContext({ organizationId: ORG, userId: actorUserId }, () =>
      service.dsarDownloadUrl(ORG, jobId, ACTOR_MEMBERSHIP),
    );
    expect(download.url).toBeTruthy();
    expect(new Date(download.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // The 24h SEC-052 floor reached the signer unclamped (not M22's own 300s chart-viewer ceiling).
    const ttlHours = (new Date(download.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(ttlHours).toBeGreaterThan(23);
    expect(ttlHours).toBeLessThanOrEqual(24.01);
  });

  it("requestDsarExport enqueues the FULL DsarExportJobInput shape (not a bare jobId)", async () => {
    const captured: Array<{ queue: string; payload: unknown }> = [];
    const { service } = buildDrizzleTenantService({
      db: handle.db,
      enqueue: {
        async enqueue(queue, payload) {
          captured.push({ queue, payload });
        },
      },
    });
    await runWithRequestContext({ organizationId: ORG, userId: actorUserId }, () =>
      service.requestDsarExport(ORG, ACTOR_MEMBERSHIP, {
        patientId,
        requestSource: "patient",
        requestorIdentityVerificationEvidence: "ID verified via phone callback",
      }),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.queue).toBe("tenant.dsar_export");
    expect(captured[0]?.payload).toMatchObject({ orgId: ORG, patientId });
    const tenantAccountId = (captured[0]?.payload as { tenantAccountId?: string }).tenantAccountId;
    expect(tenantAccountId).toBeTruthy();
    const { rows } = await admin.query("SELECT id FROM tenant_account WHERE organization_id=$1", [
      ORG,
    ]);
    expect(tenantAccountId).toBe(rows[0].id);
  });
});
