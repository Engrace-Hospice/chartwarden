/**
 * M34 — the two reads the platform console's tenant hub and onboarding wizard rest on, LIVE Postgres on the real roles.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m34:tenant-hub-reads:live   (SUPERUSER url, THROWAWAY database)
 *
 *   progress   `readOnboardingProgress`, on the audited platform credential: the tenant list's "7 of 13, current step, go-live state".
 *              It counts the gating steps only, so a task kept as history on a retired template, an optional step and a
 *              tenant-added step never move it, and it reads a whole inventory in one batch.
 *   members    `listMembers`, on the NOBYPASSRLS `chartwarden_app` tenant pool scoped to the TARGET org: a tenant's ACTIVE staff
 *              (a suspended member is absent), with the roles each holds NOW (an expired grant is not one), and nothing of any
 *              other tenant. The read leaves one audit row that names the operator and the count, never a name or an email.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { registerPlatformJob, withPlatformContext } from "@chartwarden/tenancy";
import type { AlertEmitter } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { m34PlatformBypassAuditor } from "../src/index";
import { M34_OUTBOX_EVENTS } from "../src/modules/34-saas-tenant-platform/events-by-m34";
import {
  type OnboardingOperator,
  buildDrizzleOnboardingDataService,
  buildPlatformTenantResolver,
} from "../src/modules/34-saas-tenant-platform/index";
import { listActiveMembers } from "../src/modules/34-saas-tenant-platform/routes/platform/onboarding-members";
import { readOnboardingProgress } from "../src/modules/34-saas-tenant-platform/routes/platform/onboarding-progress-drizzle";
import { createDrizzleTenantPlatformBackend } from "../src/modules/34-saas-tenant-platform/routes/platform/service-drizzle";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const PLATFORM_PASSWORD = "platform-live-password-hub-reads";
const JOB_ID = "m34-tenant-hub-reads-live-test";

const PLATFORM_ORG = "a0000000-0000-4000-8000-0000000000a0";
const ORG_PROVISIONING = "b1000000-0000-4000-8000-0000000000b1";
const ORG_ONBOARDING = "b2000000-0000-4000-8000-0000000000b2";
const ORG_AWAITING = "b3000000-0000-4000-8000-0000000000b3";
const ORG_ACTIVE = "b4000000-0000-4000-8000-0000000000b4";
const OPERATOR = "c3000000-0000-4000-8000-0000000000c3";
const OPERATOR_MEMBERSHIP = "e5000000-0000-4000-8000-0000000000e5";

const U_ADA = "d1000000-0000-4000-8000-0000000000d1";
const U_NAMELESS = "d2000000-0000-4000-8000-0000000000d2";
const U_SUSPENDED = "d3000000-0000-4000-8000-0000000000d3";
const U_OTHER_TENANT = "d4000000-0000-4000-8000-0000000000d4";
const M_ADA = "f1000000-0000-4000-8000-0000000000f1";
const M_NAMELESS = "f2000000-0000-4000-8000-0000000000f2";
const M_SUSPENDED = "f3000000-0000-4000-8000-0000000000f3";
const M_OTHER_TENANT = "f4000000-0000-4000-8000-0000000000f4";

const OPERATOR_CONTEXT: OnboardingOperator = {
  userId: OPERATOR,
  membershipId: OPERATOR_MEMBERSHIP,
  organizationId: PLATFORM_ORG,
  roles: ["platform_ops"],
  stepUpRecent: true,
  request: { correlationId: "corr-hub-reads", requestId: "req-hub-reads" },
};

describe.skipIf(!DB_URL)("M34 tenant hub reads, LIVE Postgres on the real roles", () => {
  let admin: Client;
  let tenantPool: ReturnType<typeof createDbClient>;
  let platformPool: ReturnType<typeof createDbClient>;
  const accountIds = new Map<string, string>();

  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await admin.query(text, params)).rows as T[];

  const insertTask = async (org: string, templateKey: string, status: string) =>
    admin.query(
      `INSERT INTO onboarding_task (organization_id, tenant_account_id, template_key, status)
       VALUES ($1,$2,$3,$4)`,
      [org, accountIds.get(org), templateKey, status],
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await admin.query("CREATE SCHEMA IF NOT EXISTS public");
    await dropLiveRoles(admin);
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [id, slug] of [
      [PLATFORM_ORG, "cw-platform"],
      [ORG_PROVISIONING, "hub-provisioning"],
      [ORG_ONBOARDING, "hub-onboarding"],
      [ORG_AWAITING, "hub-awaiting"],
      [ORG_ACTIVE, "hub-active"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    }
    for (const [org, status] of [
      [ORG_PROVISIONING, "provisioning"],
      [ORG_ONBOARDING, "onboarding"],
      [ORG_AWAITING, "onboarding"],
      [ORG_ACTIVE, "active"],
    ] as const) {
      const [row] = await q<{ id: string }>(
        `INSERT INTO tenant_account (organization_id, status, legal_business_name, billing_contact_email, breach_notification_email)
         VALUES ($1,$2,$3,'b@x.test','p@x.test') RETURNING id`,
        [org, status, `Tenant ${status}`],
      );
      accountIds.set(org, (row as { id: string }).id);
    }

    // ── progress fixtures ──
    // ONBOARDING: two gating steps settled (one done, one skipped), plus three rows that must not count: an optional step,
    // a task kept as history on a RETIRED template, and a pending gating step.
    await insertTask(ORG_ONBOARDING, "account_created", "done");
    await insertTask(ORG_ONBOARDING, "plan_contract", "skipped");
    await insertTask(ORG_ONBOARDING, "sample_data_loaded", "done");
    await insertTask(ORG_ONBOARDING, "xero_connected", "done");
    await insertTask(ORG_ONBOARDING, "baa_executed", "pending");
    // AWAITING: every gating step but go-live settled, and a pending go-live attestation.
    const gating = await q<{ key: string }>(
      `SELECT key FROM onboarding_task_template
        WHERE retired_at IS NULL AND is_canonical AND NOT is_optional AND key <> 'go_live_checklist_complete'`,
    );
    for (const t of gating) await insertTask(ORG_AWAITING, t.key, "done");
    await insertTask(ORG_AWAITING, "go_live_checklist_complete", "pending");

    // ── members fixtures ──
    for (const [id, email, name] of [
      [OPERATOR, "ops-hub@test.test", null],
      [U_ADA, "ada@clinic.test", "Ada Admin"],
      [U_NAMELESS, "zed@clinic.test", null],
      [U_SUSPENDED, "sam@clinic.test", "Sam Suspended"],
      [U_OTHER_TENANT, "olga@other.test", "Olga Other"],
    ] as const) {
      await admin.query(`INSERT INTO "user" (id,email,name) VALUES ($1,$2,$3)`, [id, email, name]);
    }
    for (const [id, user, org, status] of [
      [M_ADA, U_ADA, ORG_ONBOARDING, "active"],
      [M_NAMELESS, U_NAMELESS, ORG_ONBOARDING, "active"],
      [M_SUSPENDED, U_SUSPENDED, ORG_ONBOARDING, "suspended"],
      [M_OTHER_TENANT, U_OTHER_TENANT, ORG_ACTIVE, "active"],
      [OPERATOR_MEMBERSHIP, OPERATOR, PLATFORM_ORG, "active"],
    ] as const) {
      await admin.query(
        "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,$4)",
        [id, user, org, status],
      );
    }
    // Roles are the organisation's own rows (the migrations seed only platform templates).
    const roleId = async (org: string, key: string, category: string) =>
      (
        await q<{ id: string }>(
          `INSERT INTO role (organization_id, key, name, category, scope_level)
           VALUES ($1,$2,$2,$3,'organization')
           ON CONFLICT (organization_id, key) DO UPDATE SET name = excluded.name RETURNING id`,
          [org, key, category],
        )
      )[0]?.id as string;
    const grant = (membership: string, org: string, role: string, expires: string | null) =>
      admin.query(
        "INSERT INTO membership_role (organization_id, membership_id, role_id, expires_at) VALUES ($1,$2,$3,$4)",
        [org, membership, role, expires],
      );
    const officer = await roleId(ORG_ONBOARDING, "compliance_officer", "compliance_quality");
    await grant(
      M_ADA,
      ORG_ONBOARDING,
      await roleId(ORG_ONBOARDING, "org_admin", "admin_executive"),
      null,
    );
    await grant(M_ADA, ORG_ONBOARDING, officer, null);
    // An EXPIRED grant is not a role the member holds now.
    await grant(M_NAMELESS, ORG_ONBOARDING, officer, "2020-01-01T00:00:00Z");
    await grant(
      M_OTHER_TENANT,
      ORG_ACTIVE,
      await roleId(ORG_ACTIVE, "org_admin", "admin_executive"),
      null,
    );
    // The pending go-live attestation of AWAITING (attested by a member of that org).
    const U_OFFICER = "d5000000-0000-4000-8000-0000000000d5";
    const M_OFFICER = "f5000000-0000-4000-8000-0000000000f5";
    await admin.query(
      `INSERT INTO "user" (id,email,name) VALUES ($1,'officer@clinic.test','Officer')`,
      [U_OFFICER],
    );
    await admin.query(
      "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active')",
      [M_OFFICER, U_OFFICER, ORG_AWAITING],
    );
    await admin.query(
      `INSERT INTO tenant_go_live_attestation
         (organization_id, tenant_account_id, status, attested_by_membership_id, attested_by_user_id)
       VALUES ($1,$2,'pending',$3,$4)`,
      [ORG_AWAITING, accountIds.get(ORG_AWAITING), M_OFFICER, U_OFFICER],
    );

    tenantPool = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
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
    const platformUrl = new URL(DB_URL as string);
    platformUrl.username = "chartwarden_platform_login";
    platformUrl.password = PLATFORM_PASSWORD;
    platformPool = createDbClient({ connectionString: platformUrl.toString() });
    registerPlatformJob(JOB_ID);
  }, 300_000);

  afterAll(async () => {
    await tenantPool?.close();
    await platformPool?.close();
    await admin?.end();
  });

  const progressOf = async (orgs: readonly string[]) =>
    withPlatformContext<DbClient, ReadonlyMap<string, unknown>>(
      platformPool.db,
      { jobId: JOB_ID, reason: "live test: tenant list onboarding progress", crossTenant: true },
      m34PlatformBypassAuditor,
      async (tx) =>
        readOnboardingProgress(
          tx,
          orgs.map((org) => ({
            id: accountIds.get(org) as string,
            status: ["provisioning", "onboarding", "onboarding", "active"][
              [ORG_PROVISIONING, ORG_ONBOARDING, ORG_AWAITING, ORG_ACTIVE].indexOf(org)
            ] as string,
          })),
        ),
    );

  it("counts only the gating steps: retired history, an optional step and a pending step do not move the number", async () => {
    const [{ n }] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM onboarding_task_template
        WHERE retired_at IS NULL AND is_canonical AND NOT is_optional`,
    );
    const progress = await progressOf([ORG_ONBOARDING]);
    expect(progress.get(accountIds.get(ORG_ONBOARDING) as string)).toEqual({
      doneCount: 2,
      totalCount: n,
      currentStepKey: "baa_executed",
      goLiveState: "not_ready",
    });
    expect(n).toBeGreaterThanOrEqual(13);
  });

  it("reads a whole inventory in one batch and tells the go-live states apart", async () => {
    const all = [ORG_PROVISIONING, ORG_ONBOARDING, ORG_AWAITING, ORG_ACTIVE];
    const progress = await progressOf(all);
    const of = (org: string) =>
      progress.get(accountIds.get(org) as string) as { goLiveState: string; doneCount: number };
    expect(of(ORG_AWAITING).goLiveState).toBe("awaiting_approval");
    expect(of(ORG_ACTIVE).goLiveState).toBe("live");
    expect(of(ORG_PROVISIONING).goLiveState).toBe("closed");
    expect(of(ORG_PROVISIONING).doneCount).toBe(0);
  });

  const service = () =>
    buildDrizzleOnboardingDataService({
      db: tenantPool.db,
      resolveTenant: buildPlatformTenantResolver({
        platformDb: platformPool.db,
        auditBypass: m34PlatformBypassAuditor,
        platformJobId: JOB_ID,
      }),
    });

  it("lists a tenant's ACTIVE staff with the roles held now, on the tenant's own scope", async () => {
    const { items } = await service().listMembers(OPERATOR_CONTEXT, "hub-onboarding");
    expect(items).toEqual([
      {
        membershipId: M_ADA,
        displayName: "Ada Admin",
        email: "ada@clinic.test",
        roleKeys: ["compliance_officer", "org_admin"],
      },
      // no name on file: the email is the label, and an EXPIRED compliance_officer grant is not a role held now
      { membershipId: M_NAMELESS, displayName: null, email: "zed@clinic.test", roleKeys: [] },
    ]);
  });

  it("says when the list was cut, and always cuts the same members: named ones first, by name, then by id", async () => {
    const whole = await listActiveMembers(tenantPool.db, ORG_ONBOARDING, OPERATOR);
    expect(whole.truncated).toBe(false);
    const cut = await listActiveMembers(tenantPool.db, ORG_ONBOARDING, OPERATOR, 1);
    expect(cut.truncated).toBe(true);
    expect(cut.items.map((m) => m.membershipId)).toEqual([M_ADA]);
  });

  it("never returns a suspended member or another tenant's staff", async () => {
    const { items } = await service().listMembers(OPERATOR_CONTEXT, "hub-onboarding");
    const ids = items.map((m) => m.membershipId);
    expect(ids).not.toContain(M_SUSPENDED);
    expect(ids).not.toContain(M_OTHER_TENANT);
    const other = await service().listMembers(OPERATOR_CONTEXT, "hub-active");
    expect(other.items.map((m) => m.membershipId)).toEqual([M_OTHER_TENANT]);
  });

  it("answers 404 for an unknown tenant and audits a read as the operator, naming a count and no person", async () => {
    await expect(service().listMembers(OPERATOR_CONTEXT, "no-such-tenant")).rejects.toMatchObject({
      statusCode: 404,
    });
    const rows = await q<{
      actor_user_id: string;
      outcome: string;
      context: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, outcome, context FROM audit_event
        WHERE organization_id=$1 AND event_type='m34.tenant_onboarding.data_read' AND resource_kind='membership'`,
      [ORG_ONBOARDING],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ actor_user_id: OPERATOR, outcome: "success" });
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("ada@clinic.test");
    expect(serialized).not.toContain("Ada Admin");
    expect(rows[0]?.context).toMatchObject({ count: 2, targetOrgSlug: "hub-onboarding" });
  });

  // The inventory and the overview as the platform-ops routes read them (the Drizzle service on the real platform credential).
  function platformService() {
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M34_OUTBOX_EVENTS]));
    const unused = async (): Promise<never> => {
      throw new Error("not used by this suite");
    };
    return createDrizzleTenantPlatformBackend({
      platformDb: platformPool.db,
      enqueue: { enqueue: async (queue, jobKey) => ({ jobId: `${queue}-${jobKey}` }) },
      legalHoldClear: async () => true,
      invitationDelivery: { acceptBaseUrl: "http://localhost/tenant-invite", send: unused },
      provisionJobs: { status: unused, retry: unused },
      auditBypass: m34PlatformBypassAuditor,
      outbox: {
        publish: (tx, input) => publisher.publish(tx, { ...input, callerModule: "m34" } as never),
      },
      organizations: { ensure: unused },
      featureFlags: { list: unused, upsert: unused, setKillSwitch: unused },
      lifecycleAlerts: {
        emit: async () => ({ alertId: "none", resolvedRecipientCount: 0 }),
      } as AlertEmitter,
      supportSessionPorts: {
        audit: { async emitCriticalAudit() {} },
        outbox: { async publish() {} },
        alerts: { async emitAlert() {} },
        now: () => new Date(),
      },
      platformJobId: JOB_ID,
    }).service;
  }

  it("the inventory carries each tenant's progress, one page at a time, and the status filter narrows it", async () => {
    const service = platformService();
    const first = await service.listTenants({}, undefined, 2);
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await service.listTenants({}, first.nextCursor ?? undefined, 2);
    const slugs = [...first.items, ...second.items].map((t) => t.orgSlug).sort();
    expect(slugs).toEqual(["hub-active", "hub-awaiting", "hub-onboarding", "hub-provisioning"]);
    for (const t of [...first.items, ...second.items]) expect(t.onboardingProgress).not.toBeNull();

    const onboarding = await service.listTenants({ status: "onboarding" }, undefined, undefined);
    const bySlug = new Map(onboarding.items.map((t) => [t.orgSlug, t.onboardingProgress]));
    expect([...bySlug.keys()].sort()).toEqual(["hub-awaiting", "hub-onboarding"]);
    expect(bySlug.get("hub-onboarding")).toMatchObject({
      doneCount: 2,
      currentStepKey: "baa_executed",
    });
    expect(bySlug.get("hub-awaiting")).toMatchObject({ goLiveState: "awaiting_approval" });
  });

  it("the overview's older onboarding counts follow the same rule: no retired history, the first open gating step", async () => {
    const overview = await platformService().getTenantOverview("hub-onboarding");
    const [{ n }] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM onboarding_task_template
        WHERE retired_at IS NULL AND is_canonical AND NOT is_optional`,
    );
    expect(overview.onboarding).toEqual({
      totalTasks: n,
      doneTasks: 2,
      currentStep: "baa_executed",
    });
    expect(overview.onboardingProgress).toMatchObject({ doneCount: 2, totalCount: n });
  });
});
