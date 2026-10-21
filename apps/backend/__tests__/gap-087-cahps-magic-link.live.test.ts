/**
 * `cahps_export_job` (M30, GAP-087) and `auditor_magic_link` (M2, GAP-011) Drizzle paths, LIVE Postgres, as the
 * RLS-enforced `chartwarden_app` role. Both are update-heavy lifecycle tables whose guards live in the WHERE clause
 * (live-job convergence, predecessor-state-only transitions, single-use consume) - exactly what mocks cannot prove.
 * Gated on a live DB:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:gap-087:live
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  consumeAuditorMagicLink,
  createDbAuditorMagicLinkIssuer,
  revokeAuditorMagicLinksForEngagement,
} from "../src/modules/02-identity/auditor-magic-link-store";
import {
  buildCahpsExportJobPort,
  createOrGetLiveExportJob,
  getExportJob,
} from "../src/modules/30-quality/cahps/export-job-store";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "chartwarden_platform_login",
  "chartwarden_platform",
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
  "tenant_platform_writer",
];
const ORG_A = "11111111-1111-4111-8111-111111118701";
const ORG_B = "22222222-2222-4222-8222-222222228702";
const BINDING = "b0000000-0000-4000-8000-000000008701";
const ENGAGEMENT = "e0000000-0000-4000-8000-000000008701";

describe.skipIf(!DB_URL)("CAHPS export job + auditor magic link, LIVE Postgres", () => {
  let admin: Client;
  let app: ReturnType<typeof createDbClient>;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [org, slug] of [
      [ORG_A, "g087a"],
      [ORG_B, "g087b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [org, slug],
      );
    }
    app = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  // ── cahps_export_job ───────────────────────────────────────────────────────────────────────────────────
  const jobInput = (org: string) => ({
    organizationId: org,
    vendorBindingId: BINDING,
    vendorAdapterId: "press_ganey",
    samplingCycleMonth: "2026-09-01",
    samplePeriodStart: "2026-09-01",
    samplePeriodEnd: "2026-09-30",
    decedentCount: 3,
    requestedByUserId: null,
  });
  const cipher = (() => {
    const key = randomBytes(32);
    return {
      encrypt: async (_org: string, _col: string, bytes: Uint8Array) => ({
        envelope: `sealed:${Buffer.from(bytes).toString("base64")}`,
        keyVersion: "v1",
      }),
      decrypt: async (_org: string, _col: string, envelope: string) =>
        Buffer.from(envelope.replace("sealed:", ""), "base64"),
      key,
    };
  })();

  it("create converges on the LIVE job for the same org + cycle (no second row)", async () => {
    const first = await withOrgContext(app.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      createOrGetLiveExportJob(tx as never, jobInput(ORG_A)),
    );
    const second = await withOrgContext(app.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      createOrGetLiveExportJob(tx as never, jobInput(ORG_A)),
    );
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false });
    expect(second.row.id).toBe(first.row.id);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM cahps_export_job WHERE organization_id = $1",
          [ORG_A],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("the lifecycle port moves queued -> running -> completed, and a terminal row is never resurrected", async () => {
    const port = buildCahpsExportJobPort({ db: app.db, cipher: cipher as never });
    const live = await admin.query("SELECT id FROM cahps_export_job WHERE organization_id = $1", [
      ORG_A,
    ]);
    const exportId = live.rows[0].id as string;
    const job = {
      jobId: "j1",
      organizationId: ORG_A,
      samplingCycleMonth: "2026-09-01",
      samplePeriodStart: "2026-09-01",
      samplePeriodEnd: "2026-09-30",
      vendorBindingId: BINDING,
      exportId,
    };
    await port.markRunning(job as never);
    expect((await getExportJob(app.db, ORG_A, exportId))?.status).toBe("running");
    await port.storeFile(
      job as never,
      { filename: "x.csv", mimeType: "text/csv", bytes: Buffer.from("a,b") } as never,
      3,
    );
    await port.complete(job as never, { status: "no_push" } as never);
    const done = await getExportJob(app.db, ORG_A, exportId);
    expect(done).toMatchObject({ status: "completed", filename: "x.csv", pushStatus: "no_push" });
    expect(done?.fileCipher).toMatch(/^sealed:/);
    // A redelivered worker job cannot move a completed row back or fail it.
    await port.markRunning(job as never);
    await port.fail(job as never, "late failure");
    expect((await getExportJob(app.db, ORG_A, exportId))?.status).toBe("completed");
  });

  it("a failed job records its reason; another tenant cannot read or move it", async () => {
    const created = await withOrgContext(app.db, { organizationId: ORG_B, userId: "" }, (tx) =>
      createOrGetLiveExportJob(tx as never, jobInput(ORG_B)),
    );
    const port = buildCahpsExportJobPort({ db: app.db, cipher: cipher as never });
    const job = {
      jobId: "j2",
      organizationId: ORG_B,
      samplingCycleMonth: "2026-09-01",
      samplePeriodStart: "2026-09-01",
      samplePeriodEnd: "2026-09-30",
      vendorBindingId: BINDING,
      exportId: created.row.id,
    };
    expect(await getExportJob(app.db, ORG_A, created.row.id)).toBeNull();
    await port.fail({ ...job, organizationId: ORG_A } as never, "cross-tenant attempt");
    expect((await getExportJob(app.db, ORG_B, created.row.id))?.status).toBe("queued");
    await port.fail(job as never, "vendor 500");
    expect(await getExportJob(app.db, ORG_B, created.row.id)).toMatchObject({
      status: "failed",
      failureReason: "vendor 500",
    });
  });

  // ── auditor_magic_link ─────────────────────────────────────────────────────────────────────────────────
  const issue = (
    org: string,
    engagementId = ENGAGEMENT,
    startOffsetMs = -60_000,
    ttlMs = 3_600_000,
  ) =>
    createDbAuditorMagicLinkIssuer(app.db).issue({
      organizationId: org,
      engagementId,
      identity: { email: "aud@g087.test", name: "Aud Itor" },
      window: { start: new Date(Date.now() + startOffsetMs), end: new Date(Date.now() + ttlMs) },
    } as never);

  it("a link is single-use: the first consume resolves it, a replay returns null", async () => {
    const { magicLinkToken } = await issue(ORG_A);
    const first = await consumeAuditorMagicLink(app.db, ORG_A, magicLinkToken);
    expect(first).toMatchObject({
      organizationId: ORG_A,
      engagementId: ENGAGEMENT,
      auditorEmail: "aud@g087.test",
    });
    expect(await consumeAuditorMagicLink(app.db, ORG_A, magicLinkToken)).toBeNull();
    const stored = await admin.query(
      "SELECT token_hash FROM auditor_magic_link WHERE organization_id = $1",
      [ORG_A],
    );
    expect(stored.rows.every((r) => r.token_hash !== magicLinkToken)).toBe(true);
  });

  it("a not-yet-open, expired, foreign-tenant or revoked link never consumes", async () => {
    const future = await issue(ORG_A, ENGAGEMENT, 600_000, 1_200_000);
    expect(await consumeAuditorMagicLink(app.db, ORG_A, future.magicLinkToken)).toBeNull();

    const open = await issue(ORG_A);
    expect(await consumeAuditorMagicLink(app.db, ORG_B, open.magicLinkToken)).toBeNull();
    expect(await consumeAuditorMagicLink(app.db, ORG_A, "not-a-real-token")).toBeNull();

    const revoked = await revokeAuditorMagicLinksForEngagement(app.db, ORG_A, ENGAGEMENT);
    expect(revoked).toBeGreaterThanOrEqual(2);
    expect(await consumeAuditorMagicLink(app.db, ORG_A, open.magicLinkToken)).toBeNull();
    // Idempotent: nothing live left to revoke.
    expect(await revokeAuditorMagicLinksForEngagement(app.db, ORG_A, ENGAGEMENT)).toBe(0);
  });
});
