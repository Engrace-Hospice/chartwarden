/**
 * GAP-098 — the DISCOVERY surface for a SEC-052 oversized tenant-export hold, over real Postgres.
 *
 * GAP-097 built the release route and proved it works GIVEN A JOB ID. Nothing handed one out. The hold
 * gives the job no status of its own — it stays `generating` (GAP-094) and the hold lives only in the
 * `tenant_export_job_event` ledger — so a held bundle was invisible to the platform-ops actor expected
 * to co-sign it unless they already knew the id from a support ticket. Both halves of the fix are here:
 *
 *   PULL — `GET /api/v1/platform/tenant-export-jobs?held=true`, the cross-tenant list behind
 *          `tenant_export.list_platform` (a permission key that existed with ZERO route registrations).
 *   PUSH — the `m34.tenant_export.oversized_hold` M36 alert `holdForOversizedApproval`'s own doc comment
 *          has always promised and never emitted.
 *
 * The assertions that matter are the ones a plausible-looking implementation would fail:
 *   • held-ness is "the NEWEST ledger event is `oversized_hold`", so an already-approved job drops off
 *     the queue — the same test the release route makes, not a separate notion that could disagree.
 *   • the list spans organizations (that is the whole point of a platform-ops surface).
 *   • an alert-emit failure does NOT take the hold row with it: the ledger row is what makes the bundle
 *     releasable at all, and a bundle assembled, uploaded, then unreachable by any path is the worst
 *     outcome available here.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m34:hold-discovery:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import type { TenantExportWorkerPorts } from "@chartwarden/saas-tenant-platform";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { m34PlatformBypassAuditor } from "../src/index";
import {
  buildDrizzlePlatformService,
  buildM34WorkerPorts,
  wireM34Tenancy,
} from "../src/modules/34-saas-tenant-platform/index";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
  "tenant_platform_writer",
];

const ORG_A = "11111111-1111-4111-8111-111111110981";
const ORG_B = "22222222-2222-4222-8222-222222220982";
const REQUESTER = "33333333-3333-4333-8333-333333330983";
const APPROVER = "44444444-4444-4444-8444-444444440984";

/** A recording stand-in for M36's `AlertEmitter` seam. */
function recordingEmitter(behaviour: "ok" | "throw" = "ok") {
  const emitted: { orgId: string; eventType: string; payload: Record<string, unknown> }[] = [];
  return {
    emitted,
    seam: {
      async emit(orgId: string, input: { eventType: string; payload: Record<string, unknown> }) {
        if (behaviour === "throw") throw new Error("M36 is down");
        emitted.push({ orgId, eventType: input.eventType, payload: input.payload });
        return { alertId: "alert-1", resolvedRecipientCount: 2 };
      },
    },
  };
}

describe.skipIf(!DB_URL)("GAP-098 — M34 oversized-hold discovery, LIVE Postgres", () => {
  let admin: Client;
  let appHandle: ReturnType<typeof createDbClient>;
  let platformHandle: ReturnType<typeof createDbClient>;

  /** Build a login URL for `role` by PARSING the url (never string-replacing it — GAP-086). */
  const urlAs = (role: string, password: string): string => {
    const u = new URL(DB_URL as string);
    u.username = role;
    u.password = password;
    return u.toString();
  };

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

  async function seedOrg(org: string, slug: string): Promise<void> {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
      [org, slug, slug],
    );
    await admin.query(
      `INSERT INTO tenant_account (organization_id, legal_business_name, billing_contact_email, breach_notification_email)
       VALUES ($1,$2,'billing@gap098.example','breach@gap098.example')`,
      [org, `${slug} Hospice LLC`],
    );
    // `tenant_export_job_event` is PARTITION BY LIST (organization_id) (migration 0051) — OPS-021's
    // auto-provisioning is still deferred, so each org needs its partition made by hand (GAP-094/097).
    await admin.query(
      `CREATE TABLE "tenant_export_job_event_${slug}" PARTITION OF "tenant_export_job_event" FOR VALUES IN ('${org}')`,
    );
  }

  /** A job in whatever state; `hold` appends the SEC-052 ledger row the discovery surface keys on. */
  async function seedJob(
    org: string,
    opts: { status?: string; hold?: boolean; sizeBytes?: number; requestedAt?: string } = {},
  ): Promise<string> {
    const jobId = (
      await admin.query(
        `INSERT INTO tenant_export_job (organization_id, requested_purpose, requesting_membership_id, status, requested_at)
         VALUES ($1,'migration',$2,$3::tenant_export_job_status, COALESCE($4::timestamptz, now())) RETURNING id`,
        [org, REQUESTER, opts.status ?? "generating", opts.requestedAt ?? null],
      )
    ).rows[0].id as string;
    if (opts.hold !== false) {
      await admin.query(
        `INSERT INTO tenant_export_job_event (organization_id, tenant_export_job_id, event_kind, shard_receipt)
         VALUES ($1,$2,'oversized_hold',$3::jsonb)`,
        [
          org,
          jobId,
          JSON.stringify({
            bundleMinioObjectKey: `exports/tenant/${jobId}.tar.gz`,
            bundleSha256: "deadbeef",
            bundleSizeBytes: opts.sizeBytes ?? 60 * 1024 * 1024 * 1024,
            recordCount: 20_000,
          }),
        ],
      );
    }
    return jobId;
  }

  const platformService = () =>
    buildDrizzlePlatformService({
      platformDb: platformHandle.db,
      enqueue: {
        async enqueue() {
          throw new Error("not expected in this test");
        },
      },
      auditBypass: m34PlatformBypassAuditor,
    }).service;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    await seedOrg(ORG_A, "gap098a");
    await seedOrg(ORG_B, "gap098b");

    await admin.query("ALTER ROLE chartwarden_app LOGIN PASSWORD 'gap098_app'");
    appHandle = createDbClient({ connectionString: urlAs("chartwarden_app", "gap098_app") });

    // The platform-ops surface runs cross-tenant reads over a separately-pooled BYPASSRLS credential
    // (index.ts's `DATABASE_PLATFORM_URL`); `chartwarden_admin` already holds 0052's table grants, so it
    // stands in for that role here (the GAP-097 suite's precedent).
    await admin.query("ALTER ROLE chartwarden_admin LOGIN BYPASSRLS PASSWORD 'gap098_platform'");
    await admin.query(
      "GRANT EXECUTE ON FUNCTION audit_writer_insert_platform_event(text, text, uuid, text, text, text, jsonb, text) TO chartwarden_admin",
    );
    platformHandle = createDbClient({
      connectionString: urlAs("chartwarden_admin", "gap098_platform"),
    });

    wireM34Tenancy();
  }, 240_000);

  afterAll(async () => {
    await appHandle?.close();
    await platformHandle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM tenant_export_job_event");
    await admin.query("DELETE FROM tenant_export_job");
    __resetSeamsForTest();
  });

  // ── the PULL half: the cross-tenant list ────────────────────────────────────────────────────────
  describe("GET /api/v1/platform/tenant-export-jobs", () => {
    it("surfaces held bundles from EVERY tenant, with the size the co-signer decides on", async () => {
      const a = await seedJob(ORG_A, { sizeBytes: 60 * 1024 * 1024 * 1024 });
      const b = await seedJob(ORG_B, { sizeBytes: 80 * 1024 * 1024 * 1024 });

      const page = await platformService().listTenantExportJobs({ held: true }, undefined, 50);
      expect(page.items.map((j) => j.id).sort()).toEqual([a, b].sort());
      for (const item of page.items) {
        expect(item.heldForOversizedApproval).toBe(true);
        expect(item.heldRecordCount).toBe(20_000);
        expect(item.heldAt).not.toBeNull();
      }
      // Size round-trips as a STRING, not a JS number: an oversized bundle is past 2^31 by definition
      // (that is why it is held), and 80 GiB read through a 32-bit column is the GAP-097 overflow.
      const bItem = page.items.find((j) => j.id === b);
      expect(bItem?.heldBundleSizeBytes).toBe(String(80 * 1024 * 1024 * 1024));
    });

    it("drops a job whose newest event is the APPROVAL — held is the newest event, not any event", async () => {
      // The trap a naive `EXISTS (… event_kind = 'oversized_hold')` would fall into: the hold row is
      // append-only and never deleted, so an approved job keeps it forever and would sit in the queue
      // permanently, telling every operator a released bundle still needs them.
      const approved = await seedJob(ORG_A);
      const stillHeld = await seedJob(ORG_A);
      await admin.query(
        `INSERT INTO tenant_export_job_event (organization_id, tenant_export_job_id, event_kind, shard_receipt, occurred_at)
         VALUES ($1,$2,'oversized_approved','{}'::jsonb, now() + interval '1 minute')`,
        [ORG_A, approved],
      );

      const page = await platformService().listTenantExportJobs({ held: true }, undefined, 50);
      expect(page.items.map((j) => j.id)).toEqual([stillHeld]);
    });

    it("re-holding after an approval puts the job back on the queue", async () => {
      // Same predicate, the other direction — a second hold is newer than the approval, so the job is
      // held again. A "has ever been approved" shortcut would lose it.
      const job = await seedJob(ORG_A);
      await admin.query(
        `INSERT INTO tenant_export_job_event (organization_id, tenant_export_job_id, event_kind, shard_receipt, occurred_at)
         VALUES ($1,$2,'oversized_approved','{}'::jsonb, now() + interval '1 minute'),
                ($1,$2,'oversized_hold','{"bundleSizeBytes":1,"recordCount":1}'::jsonb, now() + interval '2 minutes')`,
        [ORG_A, job],
      );
      const page = await platformService().listTenantExportJobs({ held: true }, undefined, 50);
      expect(page.items.map((j) => j.id)).toEqual([job]);
    });

    it("lists unheld jobs too, and reports them as not held", async () => {
      const held = await seedJob(ORG_A);
      const plain = await seedJob(ORG_A, { status: "fulfilled", hold: false });
      const page = await platformService().listTenantExportJobs({}, undefined, 50);
      expect(page.items.map((j) => j.id).sort()).toEqual([held, plain].sort());
      expect(page.items.find((j) => j.id === plain)?.heldForOversizedApproval).toBe(false);
      expect(page.items.find((j) => j.id === plain)?.heldBundleSizeBytes).toBeNull();
    });

    it("filters by organization and by status", async () => {
      await seedJob(ORG_A);
      const b = await seedJob(ORG_B);
      await seedJob(ORG_B, { status: "fulfilled", hold: false });

      const byOrg = await platformService().listTenantExportJobs(
        { organizationId: ORG_B },
        undefined,
        50,
      );
      expect(byOrg.items).toHaveLength(2);
      const byStatus = await platformService().listTenantExportJobs(
        { organizationId: ORG_B, status: "generating" },
        undefined,
        50,
      );
      expect(byStatus.items.map((j) => j.id)).toEqual([b]);
    });

    it("pages by the (requestedAt, id) keyset without repeating or dropping a row", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        ids.push(
          await seedJob(ORG_A, { requestedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString() }),
        );
      }
      const svc = platformService();
      const first = await svc.listTenantExportJobs({}, undefined, 2);
      expect(first.items).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      const second = await svc.listTenantExportJobs({}, first.nextCursor ?? undefined, 2);
      expect(second.items).toHaveLength(1);
      expect(second.hasMore).toBe(false);
      const seen = [...first.items, ...second.items].map((j) => j.id);
      expect(new Set(seen).size).toBe(3);
      expect(seen.sort()).toEqual([...ids].sort());
    });

    it("the release route clears the job off the queue end to end", async () => {
      const job = await seedJob(ORG_A);
      const svc = platformService();
      expect((await svc.listTenantExportJobs({ held: true }, undefined, 50)).items).toHaveLength(1);

      await svc.approveOversizedExport(job, APPROVER, {
        approvalReason: "reviewed record count + PHI scope with compliance; cleared for release",
      });

      const after = await svc.listTenantExportJobs({ held: true }, undefined, 50);
      expect(after.items).toHaveLength(0);
      // …and the job is still listed, now reported as fulfilled and not held.
      const all = await svc.listTenantExportJobs({}, undefined, 50);
      expect(all.items[0]?.status).toBe("fulfilled");
      expect(all.items[0]?.heldForOversizedApproval).toBe(false);
    });
  });

  // ── the PUSH half: the alert the worker port never emitted ──────────────────────────────────────
  describe("holdForOversizedApproval → m34.tenant_export.oversized_hold", () => {
    /**
     * Drive the real bound `tenantExport` ports exactly as `registerM34TenantExportWorker` does: the
     * ports are built INSIDE the per-job `withOrgContext` transaction (F09), not over the bare pool —
     * the repo issues plain Drizzle and RLS scopes it from the envelope. Building them outside would
     * hide every row from the NOBYPASSRLS app role and prove nothing about the real path.
     */
    function inOrg<T>(org: string, fn: (ports: TenantExportWorkerPorts) => Promise<T>): Promise<T> {
      return withOrgContext(appHandle.db, { organizationId: org, userId: "" }, (tx) =>
        fn(
          buildM34WorkerPorts({
            connection: {},
            db: tx as unknown as typeof appHandle.db,
            platformDb: platformHandle.db,
            // Mirror the registrar's per-job, immutable org binding.
            orgScope: org,
          }).tenantExport,
        ),
      );
    }

    it("emits the alert with the job id, org and bundle size — and no artifact handles", async () => {
      const emitter = recordingEmitter();
      registerSeam("AlertEmitter", emitter.seam);
      const jobId = await seedJob(ORG_A, { hold: false });

      await inOrg(ORG_A, async (p) => {
        await p.markGenerating(jobId);
        await p.holdForOversizedApproval({
          jobId,
          bundleMinioObjectKey: `exports/tenant/${jobId}.tar.gz`,
          bundleSha256: "deadbeef",
          bundleSizeBytes: 60 * 1024 * 1024 * 1024,
          recordCount: 20_000,
        });
      });

      expect(emitter.emitted).toHaveLength(1);
      const [alert] = emitter.emitted;
      expect(alert?.orgId).toBe(ORG_A);
      expect(alert?.eventType).toBe("m34.tenant_export.oversized_hold");
      expect(alert?.payload).toMatchObject({
        jobId,
        orgId: ORG_A,
        bundleSizeBytes: 60 * 1024 * 1024 * 1024,
        recordCount: 20_000,
      });
      // The object key + sha256 stay OUT: an alert body naming the artifact handle is a step toward a
      // bundle being fetched from a notification instead of through the audited release route.
      expect(alert?.payload.bundleMinioObjectKey).toBeUndefined();
      expect(alert?.payload.bundleSha256).toBeUndefined();
    });

    it("records the hold even when the alert emit THROWS — the ledger row is the load-bearing half", async () => {
      const emitter = recordingEmitter("throw");
      registerSeam("AlertEmitter", emitter.seam);
      const jobId = await seedJob(ORG_A, { hold: false });

      // Must not reject: an M36 outage that also lost the hold would leave a bundle assembled,
      // uploaded and unreachable by ANY path — the release route reads this exact ledger row.
      await expect(
        inOrg(ORG_A, async (p) => {
          await p.markGenerating(jobId);
          await p.holdForOversizedApproval({
            jobId,
            bundleMinioObjectKey: `exports/tenant/${jobId}.tar.gz`,
            bundleSha256: "deadbeef",
            bundleSizeBytes: 60 * 1024 * 1024 * 1024,
            recordCount: 20_000,
          });
        }),
      ).resolves.toBeUndefined();

      const { rows } = await admin.query(
        "SELECT event_kind FROM tenant_export_job_event WHERE tenant_export_job_id=$1",
        [jobId],
      );
      expect(rows.map((r) => r.event_kind)).toEqual(["generating", "oversized_hold"]);
      // …and the job the emit failed for is still discoverable through the pull surface.
      const page = await platformService().listTenantExportJobs({ held: true }, undefined, 50);
      expect(page.items.map((j) => j.id)).toEqual([jobId]);
    });
  });
});
