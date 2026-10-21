/**
 * GAP-097 — the SEC-052 platform-ops RELEASE side of an oversized tenant-export bundle hold, proven
 * end-to-end over real Postgres. Before this fix, `POST /api/v1/platform/tenant-export-jobs/:id/
 * approve-oversized` was documented (typebox.ts's `ApproveOversizedExportRequest`) but never registered
 * as a route — GAP-094's `holdForOversizedApproval` could record the hold, but nothing could ever flip
 * the job back to `fulfilled`, permanently trapping it (the tenant-scoped download route 409s any job
 * whose status isn't `fulfilled`, forever).
 *
 * This test drives the REAL bound pieces:
 *   1. `TenantPlatformRouteService.approveOversizedExport` (service-drizzle.ts, platform side), running
 *      inside a genuine `withPlatformContext` transaction (the platform-pooled, RLS-bypass credential —
 *      here a BYPASSRLS-attributed `wardenx_admin` login, mirroring what a real `DATABASE_PLATFORM_URL`
 *      role carries in production, per apps/backend/src/index.ts's own comment on that credential).
 *   2. The held-state check against the REAL `tenant_export_job_event` ledger (the newest event must be
 *      GAP-094's `oversized_hold` row) — not a separate status/column.
 *   3. The tenant-scoped download route (`buildDrizzleTenantService`) 409ing before approval and minting
 *      a real presigned URL after — the full SEC-052 hold → release → download round trip.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/gap-097-tenant-export-approval-live.test.ts
 */
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { m34PlatformBypassAuditor } from "../src/index";
import {
  createInMemoryObjectStore,
  registerDocumentSeams,
} from "../src/modules/22-documents/index";
import {
  buildDrizzlePlatformService,
  buildDrizzleTenantService,
  wireM34Tenancy,
} from "../src/modules/34-saas-tenant-platform/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = `${__dirname}/../../../packages/db/migrations`;
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "tenant_platform_writer",
];
const ORG = "77777777-7777-7777-7777-777777777777";
const REQUESTING_MEMBERSHIP = "88888888-8888-8888-8888-888888888888";
const APPROVER_MEMBERSHIP = "99999999-9999-9999-9999-999999999999";

describe.skipIf(!DB_URL)("GAP-097 — M34 SEC-052 oversized-export approval, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let platformHandle: ReturnType<typeof createDbClient>;
  let actorUserId: string;

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
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
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
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-gap097','GAP-097','GAP-097')",
      [ORG],
    );
    await admin.query(
      `INSERT INTO tenant_account (organization_id, legal_business_name, billing_contact_email, breach_notification_email)
       VALUES ($1,'GAP-097 Hospice LLC','billing@gap097.example','breach@gap097.example')`,
      [ORG],
    );
    // `tenant_export_job_event` is `PARTITION BY LIST (organization_id)` (migration 0051) — the gap-094
    // precedent's manual per-org partition (OPS-021 auto-provisioning is still deferred).
    await admin.query(
      `CREATE TABLE "tenant_export_job_event_gap097" PARTITION OF "tenant_export_job_event" FOR VALUES IN ('${ORG}')`,
    );
    actorUserId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        "gap097-actor@x.test",
      ])
    ).rows[0].id as string;

    // GAP-086: parse the url, never string-replace it — the replace idiom silently no-ops on a
    // passworded url and the suite runs as superuser with RLS bypassed.
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });

    // The platform-ops route surface runs its cross-tenant reads/writes over a SEPARATELY POOLED
    // platform credential (never `wardenx_app`, never a `SET ROLE`) — apps/backend/src/index.ts's own
    // comment on `DATABASE_PLATFORM_URL` names it "a least-privilege platform login role (… + BYPASSRLS)".
    // `wardenx_admin` already carries the right table-level GRANTs (0052's `GRANT ALL … TO wardenx_admin`
    // on tenant_export_job/_event); this test attaches LOGIN + BYPASSRLS to it — the same DEV-ONLY
    // mechanism `scripts/db/migrate.ts` uses for `wardenx_app` under CHARTWARDEN_DEV_BYPASSRLS — to stand in
    // for that dedicated role without provisioning a new one just for this test cluster.
    await admin.query(
      "ALTER ROLE wardenx_admin LOGIN BYPASSRLS PASSWORD 'wardenx_admin_live_test'",
    );
    // `m34PlatformBypassAuditor` (the mandatory F09 bypass audit) calls the SECURITY DEFINER
    // `audit_writer_insert_platform_event` (migration 0187), EXECUTE-granted only to `wardenx_app` —
    // a real `DATABASE_PLATFORM_URL` role needs its own grant (index.ts's comment on that credential
    // names "audit_event INSERT" as one of its required privileges); extend it here too since this test
    // stands `wardenx_admin` in for that role.
    await admin.query(
      "GRANT EXECUTE ON FUNCTION audit_writer_insert_platform_event(text, text, uuid, text, text, text, jsonb, text) TO wardenx_admin",
    );
    // Same GAP-086 rule as `handle`: parse, never string-replace (which silently keeps superuser).
    const platformUrl = new URL(DB_URL as string);
    platformUrl.username = "wardenx_admin";
    platformUrl.password = "wardenx_admin_live_test";
    platformHandle = createDbClient({ connectionString: platformUrl.toString() });

    wireM34Tenancy(); // idempotent — registers M34_PLATFORM_JOB_ID on the tenancy allowlist

    registerDocumentSeams({ objects: createInMemoryObjectStore().store });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await platformHandle?.close();
    if (admin) await admin.end();
  });

  async function seedHeldJob(): Promise<string> {
    const jobId = (
      await admin.query(
        `INSERT INTO tenant_export_job (organization_id, requested_purpose, requesting_membership_id, status)
         VALUES ($1,'migration',$2,'generating') RETURNING id`,
        [ORG, REQUESTING_MEMBERSHIP],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO tenant_export_job_event (organization_id, tenant_export_job_id, event_kind, shard_receipt)
       VALUES ($1,$2,'oversized_hold',$3::jsonb)`,
      [
        ORG,
        jobId,
        JSON.stringify({
          bundleMinioObjectKey: `exports/tenant/${jobId}.tar.gz`,
          bundleSha256: "deadbeef",
          bundleSizeBytes: 60 * 1024 * 1024 * 1024,
          recordCount: 20_000,
        }),
      ],
    );
    return jobId;
  }

  it("approves a genuinely held bundle: flips to fulfilled, appends the ledger event, unblocks download", async () => {
    const jobId = await seedHeldJob();

    const { service: platformService } = buildDrizzlePlatformService({
      platformDb: platformHandle.db,
      enqueue: {
        async enqueue() {
          throw new Error("not expected in this test");
        },
      },
      auditBypass: m34PlatformBypassAuditor,
    });

    // Pre-approval: the download route 409s (the SEC-052 hold-by-omission the GAP-094 fix already covers).
    const { service: tenantService } = buildDrizzleTenantService({
      db: handle.db,
      enqueue: {
        async enqueue() {
          throw new Error("not expected in this test");
        },
      },
    });
    await expect(
      runWithRequestContext({ organizationId: ORG, userId: actorUserId }, () =>
        tenantService.tenantExportDownloadUrl(ORG, jobId, REQUESTING_MEMBERSHIP),
      ),
    ).rejects.toThrow(/not yet available/);

    const result = await platformService.approveOversizedExport(jobId, APPROVER_MEMBERSHIP, {
      approvalReason: "reviewed record count + PHI scope with compliance; cleared for release",
    });
    expect(result).toEqual({ jobId, status: "fulfilled" });

    const { rows: jobRows } = await admin.query(
      "SELECT status, bundle_minio_object_key, bundle_sha256, bundle_size_bytes, fulfilled_at, bundle_presigned_url_expires_at FROM tenant_export_job WHERE id=$1",
      [jobId],
    );
    expect(jobRows[0].status).toBe("fulfilled");
    expect(jobRows[0].bundle_minio_object_key).toBe(`exports/tenant/${jobId}.tar.gz`);
    expect(jobRows[0].bundle_sha256).toBe("deadbeef");
    expect(Number(jobRows[0].bundle_size_bytes)).toBe(60 * 1024 * 1024 * 1024);
    expect(jobRows[0].fulfilled_at).not.toBeNull();
    expect(jobRows[0].bundle_presigned_url_expires_at).not.toBeNull();

    const { rows: eventRows } = await admin.query(
      "SELECT event_kind, shard_receipt FROM tenant_export_job_event WHERE tenant_export_job_id=$1 ORDER BY occurred_at",
      [jobId],
    );
    expect(eventRows.map((r) => r.event_kind)).toEqual(["oversized_hold", "oversized_approved"]);
    expect(eventRows[1].shard_receipt).toMatchObject({
      approvedByMembershipId: APPROVER_MEMBERSHIP,
      approvalReason: "reviewed record count + PHI scope with compliance; cleared for release",
    });

    // Post-approval: the SAME download route that 409'd above now mints a real presigned URL — the
    // whole SEC-052 hold → release → download round trip the fix note asked for.
    const download = await runWithRequestContext({ organizationId: ORG, userId: actorUserId }, () =>
      tenantService.tenantExportDownloadUrl(ORG, jobId, REQUESTING_MEMBERSHIP),
    );
    expect(download.url).toBeTruthy();
    expect(new Date(download.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses to approve a job that is not actually held (409 TENANT_EXPORT_NOT_HELD)", async () => {
    const requestedJobId = (
      await admin.query(
        `INSERT INTO tenant_export_job (organization_id, requested_purpose, requesting_membership_id, status)
         VALUES ($1,'migration',$2,'requested') RETURNING id`,
        [ORG, REQUESTING_MEMBERSHIP],
      )
    ).rows[0].id as string;

    const { service: platformService } = buildDrizzlePlatformService({
      platformDb: platformHandle.db,
      enqueue: {
        async enqueue() {
          throw new Error("not expected in this test");
        },
      },
      auditBypass: m34PlatformBypassAuditor,
    });

    await expect(
      platformService.approveOversizedExport(requestedJobId, APPROVER_MEMBERSHIP, {
        approvalReason: "should be refused — never held",
      }),
    ).rejects.toThrow(/not awaiting oversized-hold approval/);

    // Re-approving an ALREADY-approved job is refused the same way (idempotency guard — the newest
    // ledger event is `oversized_approved`, not `oversized_hold`, once the first approval lands).
    const heldJobId = await seedHeldJob();
    await platformService.approveOversizedExport(heldJobId, APPROVER_MEMBERSHIP, {
      approvalReason: "first approval",
    });
    await expect(
      platformService.approveOversizedExport(heldJobId, APPROVER_MEMBERSHIP, {
        approvalReason: "second approval attempt — must be refused",
      }),
    ).rejects.toThrow(/not awaiting oversized-hold approval/);
  });

  it("refuses the requester approving their own export (403 TENANT_EXPORT_SELF_APPROVAL), then accepts a distinct approver", async () => {
    // THE two-person property itself: one platform-ops membership can hold both
    // `tenant_export.request` and `tenant_export.approve_oversized` — the service, not the
    // permission model, must refuse the requester as approver (spec §3.7 "second actor must be
    // distinct from the tenant-export requestor"). Before this fix the route checked only
    // status + hold, and this exact call succeeded.
    const jobId = await seedHeldJob();

    const { service: platformService } = buildDrizzlePlatformService({
      platformDb: platformHandle.db,
      enqueue: {
        async enqueue() {
          throw new Error("not expected in this test");
        },
      },
      auditBypass: m34PlatformBypassAuditor,
    });

    await expect(
      platformService.approveOversizedExport(jobId, REQUESTING_MEMBERSHIP, {
        approvalReason: "self-approval attempt — must be refused",
      }),
    ).rejects.toThrow(/distinct from the export requestor/);

    // The refusal must not have consumed the hold: the job is still held and still approvable
    // by a genuinely distinct actor.
    const { rows } = await admin.query("SELECT status FROM tenant_export_job WHERE id=$1", [jobId]);
    expect(rows[0].status).toBe("generating");
    const result = await platformService.approveOversizedExport(jobId, APPROVER_MEMBERSHIP, {
      approvalReason: "distinct-actor approval after the self-approval refusal",
    });
    expect(result).toEqual({ jobId, status: "fulfilled" });
  });
});
