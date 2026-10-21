/**
 * GAP-094 — M34's tenant-export worker, proven end-to-end over real Postgres. The `tenant.export` sibling
 * of GAP-048's DSAR fix: before this fix, 7 of 8 `TenantExportWorkerPorts` methods were unconditional
 * `unbound()` throws and `registerM34Workers` (which DOES wire a `Worker` for the queue) was never called
 * from the composition root at all — no tenant-export job could ever leave `requested`. This test drives
 * the REAL bound pieces:
 *   1. `requestTenantExport` (service-drizzle.ts) inserts the job + enqueues `{jobId, orgId}` — fixed
 *      alongside this GAP (it previously enqueued a bare `{jobId}`, which would have left the worker's
 *      `withOrgContext` opening with an undefined `organizationId` the moment it went live).
 *   2. The worker's ports (`buildM34WorkerPorts(...).tenantExport`) are built the SAME way
 *      `registerM34TenantExportWorker` builds them per job — the live `listTenantExportShards()` fan-out,
 *      a REAL ustar tar.gz bundle (not a renamed JSON blob — proven here by shelling out to the system
 *      `tar` binary, mirroring tenant-export-tar.test.ts's own proof), real `TenantExportRepository`
 *      writes, and a DIRECT `DocumentRenderer.render()` cover-letter call (GAP-094 — mirrors GAP-048;
 *      replaces the dead `m22.document.upload_requested` outbox event an earlier design considered).
 *   3. `tenantExportDownloadUrl` (via `buildDrizzleTenantService`) mints a REAL presigned URL once
 *      `fulfilled`, and 409s while the job is still `generating` — the SEC-052 hold-by-omission enforcement
 *      `holdForOversizedApproval`'s doc comment describes (no separate status/column needed).
 *
 * No live MinIO/S3 server is stood up (same established convention as gap-048-dsar-export-live.test.ts —
 * the in-memory `ObjectStorePort` substitutes for the one piece that would need real infra).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/gap-094-tenant-export-live.test.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import {
  type TenantExportJobBody,
  type TenantExportShard,
  __resetModule34SeamsForTest,
  registerTenantExportShard,
  runTenantExportJob,
} from "@chartwarden/saas-tenant-platform";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createInMemoryObjectStore,
  registerDocumentSeams,
} from "../src/modules/22-documents/index";
import { getDocumentRenderer } from "../src/modules/22-documents/index";
import { deriveTenantBucket } from "../src/modules/22-documents/lifecycle/storage";
import {
  buildDrizzleTenantService,
  buildM34WorkerDeps,
  buildM34WorkerPorts,
} from "../src/modules/34-saas-tenant-platform/index";
import { tenantExportManifestObjectKey } from "../src/modules/34-saas-tenant-platform/tenant-export-bundle-sink";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "tenant_platform_writer",
];
const ORG = "55555555-5555-5555-5555-555555555555";
const ACTOR_MEMBERSHIP = "66666666-6666-6666-6666-666666666666";

/** A fake `TenantExportShard` — proves the fan-out actually runs and lands rows in a real per-table file. */
function fakeShard(moduleKey: string): TenantExportShard {
  return {
    moduleKey,
    async streamShardForOrg(_orgId, sink) {
      await sink.write({ table: `${moduleKey}_widget`, row: { id: "1", name: "alpha" } });
      await sink.write({ table: `${moduleKey}_widget`, row: { id: "2", name: "beta" } });
      return { rowCount: 2, tableCount: 1, sha256: "unused" };
    },
    // Present so the double satisfies the whole seam; this suite drives the ORG fan-out only, and a
    // silent no-op here would look like a module that contributes nothing to a DSAR.
    async streamDsarShardForPatient() {
      throw new Error("fakeShard: the DSAR path is not exercised by this suite");
    },
  };
}

describe.skipIf(!DB_URL)("GAP-094 — M34 tenant export, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let actorUserId: string;
  let objects: ReturnType<typeof createInMemoryObjectStore>["store"];
  let objectBytes: ReturnType<typeof createInMemoryObjectStore>["objects"];

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

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-gap094','GAP-094','GAP-094')",
      [ORG],
    );
    await admin.query(
      `INSERT INTO tenant_account (organization_id, legal_business_name, billing_contact_email, breach_notification_email)
       VALUES ($1,'GAP-094 Hospice LLC','billing@gap094.example','breach@gap094.example')`,
      [ORG],
    );
    // `tenant_export_job_event` is `PARTITION BY LIST (organization_id)` (migration 0051) with no automatic
    // per-org partition provisioning (OPS-021, still deferred) — mirrors gap-048's own partition setup.
    await admin.query(
      `CREATE TABLE "tenant_export_job_event_gap094" PARTITION OF "tenant_export_job_event" FOR VALUES IN ('${ORG}')`,
    );
    actorUserId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        "gap094-actor@x.test",
      ])
    ).rows[0].id as string;
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });

    const objectStore = createInMemoryObjectStore();
    objects = objectStore.store;
    objectBytes = objectStore.objects;
    registerDocumentSeams({ objects });
    __resetModule34SeamsForTest();
    registerTenantExportShard(fakeShard("m05"));
    registerTenantExportShard(fakeShard("m06"));
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("runs the real worker ports end-to-end: fan-out, a REAL extractable tar.gz, direct M22 render, fulfilled", async () => {
    const jobId = (
      await admin.query(
        `INSERT INTO tenant_export_job (organization_id, requested_purpose, requesting_membership_id, status)
         VALUES ($1,'migration','${ACTOR_MEMBERSHIP}','requested') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;

    const jobInput: TenantExportJobBody = { jobId, orgId: ORG };

    // Built the way the PRODUCTION registrar builds it (`registerM34TenantExportWorker`): the pooled
    // handle plus an explicit `orgScope`, with NO transaction held open around the job. Passing a `tx`
    // as `db` here would make each port's own `withOrgContext` a SAVEPOINT instead of a real
    // transaction, so the suite would no longer exercise — or catch a regression in — the per-port
    // tenancy envelope that replaced the job-long transaction.
    const result = await (async () => {
      const deps = buildM34WorkerDeps({
        connection: {} as never, // never read by buildM34WorkerPorts — no real BullMQ/Redis needed here
        db: handle.db,
        tenantExport: {
          objectStore: {
            async putObject({ organizationId, objectKey, bytes }) {
              return objects.putObject({
                bucket: deriveTenantBucket(organizationId),
                objectKey,
                bytes,
              });
            },
          },
          render: {
            render: (args) =>
              getDocumentRenderer().render(
                { orgId: args.organizationId },
                "tenant_export_cover_letter",
                args,
              ),
          },
        },
      });
      // `orgScope` is added HERE, not in `buildM34WorkerDeps` (whose parameter type cannot express it) —
      // exactly as `registerM34TenantExportWorker` does with `{ ...deps, orgScope: data.orgId }`.
      return runTenantExportJob(
        jobInput,
        buildM34WorkerPorts({ ...deps, orgScope: ORG }).tenantExport,
      );
    })();

    expect(result.outcome).toBe("fulfilled");
    expect(result.modules.map((m) => m.moduleKey)).toEqual(["m05", "m06"]);
    expect(result.totalRowCount).toBe(4);
    expect(result.bundleMinioObjectKey).toBe(`exports/tenant/${jobId}.tar.gz`);

    // The archive really landed in the object store — and is a REAL, system-tar-extractable ustar.tar.gz,
    // not a renamed JSON blob (the whole point of GAP-094's own tar builder, tenant-export-tar.ts).
    const stored = await objects.inspectObject({
      bucket: deriveTenantBucket(ORG),
      objectKey: result.bundleMinioObjectKey,
    });
    expect(stored).not.toBeNull();
    expect(stored?.byteSize).toBeGreaterThan(0);
    const bytes = objectBytes.get(`${deriveTenantBucket(ORG)}/${result.bundleMinioObjectKey}`);
    if (!bytes) throw new Error("bundle object bytes not found in the in-memory object store");
    const dir = mkdtempSync(join(tmpdir(), "wx-gap094-live-"));
    try {
      const archivePath = join(dir, "bundle.tar.gz");
      writeFileSync(archivePath, bytes);
      const listing = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
      const listedPaths = listing.trim().split("\n").sort();
      expect(listedPaths).toEqual(
        ["modules/m05/m05_widget.ndjson", "modules/m06/m06_widget.ndjson"].sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // manifest.json is a SEPARATE sidecar object next to the archive (packageAndUpload runs before
    // writeManifest — the manifest needs the archive's own sha256 — so it can't live inside the tar).
    const manifestBytes = objectBytes.get(
      `${deriveTenantBucket(ORG)}/${tenantExportManifestObjectKey(ORG, jobId)}`,
    );
    if (!manifestBytes) throw new Error("manifest.json sidecar object not found");
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
    expect(manifest.bundleId).toBe(jobId);
    expect(manifest.sha256OfArchive).toBeTruthy();
    expect(manifest.modules.map((m: { moduleKey: string }) => m.moduleKey)).toEqual(["m05", "m06"]);

    // The job row carries the real artifacts.
    const { rows: jobRows } = await admin.query(
      "SELECT status, bundle_minio_object_key, bundle_sha256, bundle_module_inventory FROM tenant_export_job WHERE id=$1",
      [jobId],
    );
    expect(jobRows[0].status).toBe("fulfilled");
    expect(jobRows[0].bundle_minio_object_key).toBe(result.bundleMinioObjectKey);
    expect(jobRows[0].bundle_module_inventory.modules).toHaveLength(2);

    // The §7.6 ledger chain landed for real.
    const { rows: eventRows } = await admin.query(
      "SELECT event_kind, module_key FROM tenant_export_job_event WHERE tenant_export_job_id=$1 ORDER BY occurred_at",
      [jobId],
    );
    expect(eventRows.map((r) => r.event_kind)).toEqual([
      "generating",
      "shard_receipt",
      "shard_receipt",
      "fulfilled",
    ]);
    expect(
      eventRows
        .filter((r) => r.event_kind === "shard_receipt")
        .map((r) => r.module_key)
        .sort(),
    ).toEqual(["m05", "m06"]);
  });

  it("tenantExportDownloadUrl mints a real presigned URL once fulfilled, and 409s while still generating", async () => {
    // An already-fulfilled fixture job (independent of the worker run above — proves the ROUTE-layer
    // presign in isolation).
    const fulfilledJobId = (
      await admin.query(
        `INSERT INTO tenant_export_job (organization_id, requested_purpose, requesting_membership_id, status, bundle_minio_object_key, bundle_sha256)
         VALUES ($1,'migration','${ACTOR_MEMBERSHIP}','fulfilled','exports/tenant/manual-fixture.tar.gz','deadbeef') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    await objects.putObject({
      bucket: deriveTenantBucket(ORG),
      objectKey: "exports/tenant/manual-fixture.tar.gz",
      bytes: new TextEncoder().encode("fixture"),
    });

    const generatingJobId = (
      await admin.query(
        `INSERT INTO tenant_export_job (organization_id, requested_purpose, requesting_membership_id, status)
         VALUES ($1,'migration','${ACTOR_MEMBERSHIP}','generating') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;

    const { service } = buildDrizzleTenantService({
      db: handle.db,
      enqueue: { async enqueue() {} },
    });

    const download = await runWithRequestContext({ organizationId: ORG, userId: actorUserId }, () =>
      service.tenantExportDownloadUrl(ORG, fulfilledJobId, ACTOR_MEMBERSHIP),
    );
    expect(download.url).toBeTruthy();
    expect(new Date(download.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // SEC-052 hold-by-omission: a non-fulfilled job (the same state `holdForOversizedApproval` leaves an
    // oversized job in) 409s — no separate hold status/column needed for the download gate to work.
    await expect(
      runWithRequestContext({ organizationId: ORG, userId: actorUserId }, () =>
        service.tenantExportDownloadUrl(ORG, generatingJobId, ACTOR_MEMBERSHIP),
      ),
    ).rejects.toThrow(/not yet available/);
  });

  it("requestTenantExport enqueues {jobId, orgId} — not a bare jobId (the worker needs orgId to open withOrgContext)", async () => {
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
      service.requestTenantExport(ORG, ACTOR_MEMBERSHIP, {
        requestedPurpose: "compliance_audit",
        justification: "annual compliance review",
      }),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.queue).toBe("tenant.export");
    expect(captured[0]?.payload).toMatchObject({ orgId: ORG });
    expect((captured[0]?.payload as { jobId?: string }).jobId).toBeTruthy();
  });
});
