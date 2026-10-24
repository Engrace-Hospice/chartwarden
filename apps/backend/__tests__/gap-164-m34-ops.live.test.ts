/**
 * GAP-164 / GAP-163 - the M34 platform-ops read/skip service and the tenant account + feature-flag service, LIVE
 * Postgres, on the REAL runtime roles.
 *
 * The platform service runs on the BYPASSRLS `chartwarden_platform_login` built by `scripts/db/provision-runtime-roles.ts`
 * itself (executed here), so a missing production grant - the `onboarding_task` UPDATE this work added - fails in this
 * suite, not in prod. It pins what a unit test cannot: the cross-tenant DSAR keyset cursor pages microsecond-distinct
 * rows without skipping or duplicating any (the JS-Date-vs-timestamptz trap), the skip UPDATE asserts its row count and
 * is tenant-scoped, and the tenant account read is RLS-bound to the caller's own org.
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:gap-164:live   (SUPERUSER url, THROWAWAY database)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { registerPlatformJob } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrizzleFeatureFlagAdmin } from "../src/bootstrap/feature-flag-store";
import { m34PlatformBypassAuditor } from "../src/index";
import { createDrizzlePlatformOpsService } from "../src/modules/34-saas-tenant-platform/routes/platform/ops-service";
import { createDrizzleTenantAccountFlagsService } from "../src/modules/34-saas-tenant-platform/routes/tenant/account-flags-service";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const JOB_ID = "m34-ops-live-test";
const PLATFORM_PASSWORD = "platform-live-password-1234";

const ORG_A = "11111111-1111-4111-8111-111111116401";
const ORG_B = "22222222-2222-4222-8222-222222226402";
const T_A = "33333333-3333-4333-8333-333333336401";
const T_B = "44444444-4444-4444-8444-444444446402";
const MEMBERSHIP = "55555555-5555-4555-8555-555555556401";
const USER = "a0000000-0000-4000-8000-000000006401";

describe.skipIf(!DB_URL)("GAP-164 M34 ops service, LIVE Postgres on the real roles", () => {
  let admin: Client;
  let platform: ReturnType<typeof createDbClient>;
  let app: ReturnType<typeof createDbClient>;
  let firstKey = "";
  let secondKey = "";
  const urlAs = (role: string, password: string): string => {
    const u = new URL(DB_URL as string);
    u.username = role;
    u.password = password;
    return u.toString();
  };

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
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }

    // The REAL provisioning script: the carrier role with its enumerated grants + the BYPASSRLS login.
    const provisioned = spawnSync("bun", ["run", "scripts/db/provision-runtime-roles.ts"], {
      cwd: join(__dirname, "../../.."),
      env: {
        ...process.env,
        PROVISION_DATABASE_URL: DB_URL,
        CHARTWARDEN_PLATFORM_PASSWORD: PLATFORM_PASSWORD,
      },
      encoding: "utf8",
    });
    expect(provisioned.status, provisioned.stderr).toBe(0);

    for (const [org, slug] of [
      [ORG_A, "ops64a"],
      [ORG_B, "ops64b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
        [org, slug, slug],
      );
    }
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'ops64@test.test')`, [USER]);
    for (const [id, org, name] of [
      [T_A, ORG_A, "Alpha Hospice"],
      [T_B, ORG_B, "Beta Hospice"],
    ] as const) {
      await admin.query(
        "INSERT INTO tenant_account (id, organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,'onboarding',$3,'b@x.test','p@x.test')",
        [id, org, name],
      );
    }
    // The 11 canonical templates are seeded by migration; take the first two by order for this suite.
    const tpl = await admin.query(
      "SELECT key FROM onboarding_task_template WHERE is_canonical ORDER BY canonical_order LIMIT 2",
    );
    const keys: string[] = tpl.rows.map((r) => r.key);
    expect(keys).toHaveLength(2);
    [firstKey, secondKey] = keys as [string, string];
    for (const [tenant, org] of [
      [T_A, ORG_A],
      [T_B, ORG_B],
    ] as const) {
      for (const key of [firstKey, secondKey]) {
        await admin.query(
          "INSERT INTO onboarding_task (organization_id, tenant_account_id, template_key, status) VALUES ($1,$2,$3,'pending')",
          [org, tenant, key],
        );
      }
    }
    // Three DSAR jobs whose requested_at differ only in MICROSECONDS (same millisecond), plus one in org B.
    const dsar = (org: string, ts: string, status: string) =>
      admin.query(
        "INSERT INTO dsar_export_job (organization_id, patient_id, request_source, requestor_identity_verification_evidence, requesting_membership_id, status, requested_at, sla_due_at) VALUES ($1, gen_random_uuid(), 'patient', 'id-checked', $2, $3, $4::timestamptz, $4::timestamptz + interval '30 days')",
        [org, MEMBERSHIP, status, ts],
      );
    await dsar(ORG_A, "2026-09-01 10:00:00.000100+00", "requested");
    await dsar(ORG_A, "2026-09-01 10:00:00.000200+00", "requested");
    await dsar(ORG_A, "2026-09-01 10:00:00.000300+00", "fulfilled");
    await dsar(ORG_B, "2026-07-01 10:00:00.000100+00", "requested");

    platform = createDbClient({
      connectionString: urlAs("chartwarden_platform_login", PLATFORM_PASSWORD),
    });
    registerPlatformJob(JOB_ID);
    app = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
  }, 300_000);

  afterAll(async () => {
    await platform?.close();
    await app?.close();
    await admin?.end();
  });

  const ops = (now = new Date("2026-10-15T00:00:00Z")) =>
    createDrizzlePlatformOpsService({
      platformDb: platform.db,
      auditBypass: m34PlatformBypassAuditor,
      platformJobId: JOB_ID,
      now: () => now,
    });

  it("lists DSAR jobs across tenants, flags SLA breaches, and carries no patient id", async () => {
    const all = await ops().listDsarJobs({}, undefined, 50);
    expect(all.items).toHaveLength(4);
    expect(JSON.stringify(all.items)).not.toMatch(/patientId|patient_id/);
    const breached = await ops().listDsarJobs({ slaBreached: true }, undefined, 50);
    // Open + past SLA at 2026-10-15: the 2026-07 job (due 07-31) and the 2026-09-01 open ones (due 10-01).
    expect(breached.items.map((j) => j.orgSlug).sort()).toEqual(["ops64a", "ops64a", "ops64b"]);
    const within = await ops().listDsarJobs({ slaBreached: false }, undefined, 50);
    expect(within.items.map((j) => j.status)).toEqual(["fulfilled"]);
    expect((await ops().listDsarJobs({ organizationId: ORG_B }, undefined, 50)).items).toHaveLength(
      1,
    );
  });

  it("pages microsecond-distinct rows with the keyset cursor: no skip, no duplicate", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 6; i++) {
      const page = await ops().listDsarJobs({ organizationId: ORG_A }, cursor, 1);
      seen.push(...page.items.map((j) => j.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    const { rows } = await admin.query(
      "SELECT id FROM dsar_export_job WHERE organization_id = $1 ORDER BY requested_at DESC, id DESC",
      [ORG_A],
    );
    expect(seen).toEqual(rows.map((r) => r.id));
  });

  it("reads a tenant's onboarding with the current step, and 404s an unknown slug", async () => {
    const view = await ops().getOnboarding("ops64a");
    expect(view.tenantStatus).toBe("onboarding");
    expect(view.tasks).toHaveLength(2);
    expect(view.currentStep).toBe(firstKey);
    await expect(ops().getOnboarding("no-such-tenant")).rejects.toThrow(/not found/i);
  });

  it("skips a task with a recorded rationale on the platform credential, then refuses a settled or foreign task", async () => {
    const view = await ops().getOnboarding("ops64a");
    const task = view.tasks.find((t) => t.templateKey === firstKey);
    const skipped = await ops().skipOnboardingTask(
      "ops64a",
      task?.id as string,
      { userId: USER, membershipId: MEMBERSHIP },
      "tenant migrating from another system",
    );
    expect(skipped).toMatchObject({
      status: "skipped",
      skipRationale: "tenant migrating from another system",
    });
    const { rows } = await admin.query(
      "SELECT status, completion_evidence FROM onboarding_task WHERE id = $1",
      [task?.id],
    );
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].completion_evidence.skip.skippedByMembershipId).toBe(MEMBERSHIP);
    expect((await ops().getOnboarding("ops64a")).currentStep).toBe(secondKey);

    // Settled: refused (409), never rewritten.
    await expect(
      ops().skipOnboardingTask(
        "ops64a",
        task?.id as string,
        { userId: USER, membershipId: MEMBERSHIP },
        "second skip attempt",
      ),
    ).rejects.toThrow(/cannot be skipped/);
    // Another tenant's task id addressed through THIS tenant's slug: 404, and the foreign row is untouched.
    const foreign = await admin.query(
      "SELECT id FROM onboarding_task WHERE tenant_account_id = $1 LIMIT 1",
      [T_B],
    );
    await expect(
      ops().skipOnboardingTask(
        "ops64a",
        foreign.rows[0].id,
        { userId: USER, membershipId: MEMBERSHIP },
        "cross tenant attempt",
      ),
    ).rejects.toThrow(/not found/i);
    const untouched = await admin.query("SELECT status FROM onboarding_task WHERE id = $1", [
      foreign.rows[0].id,
    ]);
    expect(untouched.rows[0].status).toBe("pending");
  });

  it("the platform credential's bypass audit row is written for each entry", async () => {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'platform.bypass_invoked' AND correlation_id LIKE $1",
      [`platform-bypass:${JOB_ID}:%`],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(5);
  });

  it("tenant account read is RLS-bound to the caller's own org", async () => {
    const flags = createDrizzleFeatureFlagAdmin(platform.db);
    const svc = createDrizzleTenantAccountFlagsService({ db: app.db, flags });
    const a = await svc.getAccount(ORG_A);
    expect(a).toMatchObject({ organizationId: ORG_A, legalBusinessName: "Alpha Hospice" });
    expect((await svc.getAccount(ORG_B)).legalBusinessName).toBe("Beta Hospice");
    await expect(svc.getAccount("99999999-9999-4999-8999-999999999999")).rejects.toThrow(
      /not found/i,
    );
  });

  it("tenant flags: effective view, toggle persists on the tenant's own row only", async () => {
    const flags = createDrizzleFeatureFlagAdmin(platform.db);
    const svc = createDrizzleTenantAccountFlagsService({ db: app.db, flags });
    await flags.upsert(USER, {
      flagKey: "portal.beta",
      organizationId: null,
      flagKind: "product",
      valueType: "bool",
      value: false,
      rolloutPercent: null,
      rationale: null,
    });
    await flags.upsert(USER, {
      flagKey: "portal.beta",
      organizationId: ORG_A,
      flagKind: "product",
      valueType: "bool",
      value: false,
      rolloutPercent: null,
      rationale: null,
    });
    await flags.upsert(USER, {
      flagKey: "portal.beta",
      organizationId: ORG_B,
      flagKind: "product",
      valueType: "bool",
      value: false,
      rolloutPercent: null,
      rationale: null,
    });
    await flags.upsert(USER, {
      flagKey: "platform.only",
      organizationId: null,
      flagKind: "product",
      valueType: "bool",
      value: true,
      rolloutPercent: null,
      rationale: null,
    });

    const toggled = await svc.writeFlag(ORG_A, USER, "portal.beta", true);
    expect(toggled).toMatchObject({
      flagKey: "portal.beta",
      value: true,
      scope: "tenant",
      tenantToggleable: true,
    });
    const { rows } = await admin.query(
      "SELECT organization_id, value FROM feature_flag WHERE flag_key = 'portal.beta' ORDER BY organization_id NULLS FIRST",
    );
    expect(rows.map((r) => [r.organization_id, r.value])).toEqual([
      [null, false],
      [ORG_A, true],
      [ORG_B, false],
    ]);

    const eff = await svc.listFlags(ORG_A);
    expect(eff.find((f) => f.flagKey === "portal.beta")).toMatchObject({
      scope: "tenant",
      value: true,
    });
    expect(eff.find((f) => f.flagKey === "platform.only")).toMatchObject({
      scope: "platform",
      tenantToggleable: false,
    });
    await expect(svc.writeFlag(ORG_A, USER, "platform.only", false)).rejects.toThrow(
      /platform-managed/,
    );
  });
});
