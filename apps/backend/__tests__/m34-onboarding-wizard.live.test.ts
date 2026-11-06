/**
 * M34 onboarding wizard v2 - LIVE Postgres, on the REAL runtime roles.
 *
 * The tenant surface runs as the NOBYPASSRLS `chartwarden_app` (a superuser connection would make every cross-tenant and
 * every "the tenant cannot write this" assertion vacuous); the platform surface runs on the BYPASSRLS
 * `chartwarden_platform_login` built by `scripts/db/provision-runtime-roles.ts` itself (executed here), so a missing
 * production grant fails in this suite, not in prod. It proves what the unit tests cannot:
 *   - migration 1327 seeds the ops wizard order, retires the dropped steps and backfills the tenant already mid-onboarding;
 *   - the strict sequence is refused server-side for both roles, and nothing changes;
 *   - an attestation is stored on the task with its evidence and attester, and the row audit records it;
 *   - the `auto`/`either` steps settle through the REAL fact readers (BAA register, MAC credential, org admin, officer);
 *   - the two-party go-live: attest -> approve -> active; approve without an attestation, and with a failing guard, are
 *     refused; revoke works; the sweep never activates; retired steps do not hold activation back;
 *   - the tenant role can neither approve (no UPDATE, a pending-only INSERT policy) nor write tenant_account.status.
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m34:onboarding-wizard:live   (SUPERUSER url, THROWAWAY database)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import { OnboardingRepository } from "@chartwarden/saas-tenant-platform";
import { registerPlatformJob } from "@chartwarden/tenancy";
import { ChartWardenError, type ResolvedActor, STEP_UP_POLICY } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createComplianceOfficerRoleBinder,
  createComplianceOfficerRoleUnbinder,
} from "../src/bootstrap/bind-compliance-officer-role";
import { createSessionAuthenticate } from "../src/bootstrap/index";
import { createOrganizationStageReader } from "../src/bootstrap/onboarding-org-gate";
import { buildDrizzleOrgProfilePort } from "../src/bootstrap/org-profile";
import {
  buildOrgAdminCountReader,
  buildOrgSeedFactsReader,
} from "../src/bootstrap/org-spine-facts";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { m34PlatformBypassAuditor } from "../src/index";
import {
  createOrganizationActivator,
  createOrganizationStatusReader,
} from "../src/modules/02-identity";
import {
  buildDrizzleOrgMacJurisdictionReader,
  buildMacFeedConfiguredReader,
} from "../src/modules/23-billing-medicare/jobs/mac-jurisdictions";
import { M34_OUTBOX_EVENTS } from "../src/modules/34-saas-tenant-platform/events-by-m34";
import {
  createOnboardingAdvancer,
  listPendingOrganizationActivations,
  recordOrganizationActivationReconciled,
  runOrganizationActivationReconcile,
} from "../src/modules/34-saas-tenant-platform/jobs/platform-sweeps-worker";
import type {
  PlatformActor,
  TenantActor,
} from "../src/modules/34-saas-tenant-platform/onboarding/model";
import { createOnboardingTenantReader } from "../src/modules/34-saas-tenant-platform/onboarding/onboarding-tenant-reader";
import {
  type OnboardingWizardDeps,
  createOnboardingWizard,
} from "../src/modules/34-saas-tenant-platform/onboarding/wizard-service";
import { createDrizzleWizardRunner } from "../src/modules/34-saas-tenant-platform/onboarding/wizard-store-drizzle";
import {
  type DrizzleTenantPlatformDeps,
  createDrizzleTenantPlatformBackend,
} from "../src/modules/34-saas-tenant-platform/routes/platform/service-drizzle";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const JOB_ID = "m34-onboarding-wizard-live-test";
const PLATFORM_PASSWORD = "platform-live-password-1234";

const ORG_A = "11111111-1111-4111-8111-111111117701";
const ORG_B = "22222222-2222-4222-8222-222222227702";
const ORG_L = "33333333-3333-4333-8333-333333337703"; // the tenant already mid-onboarding when 1327 lands
const T_A = "44444444-4444-4444-8444-444444447701";
const T_B = "55555555-5555-4555-8555-555555557702";
const T_L = "66666666-6666-4666-8666-666666667703";
const OPS_USER = "a0000000-0000-4000-8000-000000007701";
const OPS_MEMBERSHIP = "b0000000-0000-4000-8000-000000007701";

const OPS: PlatformActor = { kind: "platform", userId: OPS_USER, membershipId: OPS_MEMBERSHIP };

const EXPECTED_ORDER = [
  "account_created",
  "plan_contract",
  "baa_executed",
  "provisioning_complete",
  "ccn_registered",
  "locations_seeded",
  "clearinghouse_selected",
  "mac_configured",
  "payer_enrollment",
  "dosespot_kickoff_initiated",
  "first_admin_invited",
  "compliance_officer_assigned",
  "sample_data_loaded",
  "go_live_checklist_complete",
];
const LEGACY_KEYS = [
  "account_created",
  "org_seeded",
  "ccn_registered",
  "mac_configured",
  "dosespot_kickoff_initiated",
  "xero_connected",
  "payroll_connected",
  "locations_seeded",
  "first_admin_invited",
  "sample_data_loaded",
  "go_live_checklist_complete",
];

describe.skipIf(!DB_URL)("M34 onboarding wizard v2, LIVE Postgres on the real roles", () => {
  let admin: Client;
  let platform: ReturnType<typeof createDbClient>;
  let app: ReturnType<typeof createDbClient>;
  let appUrl = "";
  const alertCalls: string[] = [];
  const users: Record<string, string> = {};
  const memberships: Record<string, string> = {};

  const urlAs = (role: string, password: string): string => {
    const u = new URL(DB_URL as string);
    u.username = role;
    u.password = password;
    return u.toString();
  };
  const sqlFiles = () =>
    readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort();
  const apply = async (files: string[]) => {
    for (const f of files) await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  };

  async function person(org: string, label: string, roleKeys: string[]): Promise<TenantActor> {
    const userId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        `${label}@wizard.test`,
      ])
    ).rows[0].id as string;
    const membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userId, org],
      )
    ).rows[0].id as string;
    for (const key of roleKeys) {
      const role = await admin.query(
        `INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,'admin_executive')
         ON CONFLICT (organization_id, key) DO UPDATE SET name = excluded.name RETURNING id`,
        [org, key],
      );
      await admin.query(
        "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
        [org, membershipId, role.rows[0].id],
      );
    }
    users[label] = userId;
    memberships[label] = membershipId;
    return { kind: "tenant", userId, membershipId, roles: roleKeys };
  }

  let adminA: TenantActor;
  let officerA: TenantActor;
  let strangerB: TenantActor;
  let adminL: TenantActor;
  let officerL: TenantActor;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    const files = sqlFiles();
    const before = files.filter((f) => f < "1327");
    // A tenant already in onboarding when the wizard v2 migration lands: the OLD eleven-step catalog, some steps done.
    await apply(before);
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wiz-l','Legacy Hospice LLC','Legacy Hospice')",
      [ORG_L],
    );
    await admin.query(
      "INSERT INTO tenant_account (id, organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,'onboarding','Legacy Hospice LLC','b@l.test','p@l.test')",
      [T_L, ORG_L],
    );
    for (const key of LEGACY_KEYS) {
      const status = ["account_created", "org_seeded", "ccn_registered"].includes(key)
        ? "done"
        : "pending";
      await admin.query(
        "INSERT INTO onboarding_task (organization_id, tenant_account_id, template_key, status) VALUES ($1,$2,$3,$4)",
        [ORG_L, T_L, key, status],
      );
    }
    // A tenant org_admin role materialized BEFORE the onboarding.manage_own key existed (review fix: 1329 must backfill it).
    await admin.query(
      "INSERT INTO role (organization_id, key, name, category) VALUES ($1,'org_admin','org_admin','admin_executive')",
      [ORG_L],
    );
    await apply(files.filter((f) => f >= "1327"));

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
      [ORG_A, "wiz-a"],
      [ORG_B, "wiz-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
        [org, slug, slug],
      );
    }
    for (const [tenant, org, name] of [
      [T_A, ORG_A, "Alpha Hospice"],
      [T_B, ORG_B, "Beta Hospice"],
    ] as const) {
      await admin.query(
        "INSERT INTO tenant_account (id, organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,'onboarding',$3,'b@x.test','p@x.test')",
        [tenant, org, name],
      );
      // Provisioning materializes one task per ACTIVE template.
      await admin.query(
        `INSERT INTO onboarding_task (organization_id, tenant_account_id, template_key)
         SELECT $1, $2, key FROM onboarding_task_template WHERE retired_at IS NULL`,
        [org, tenant],
      );
    }
    // The platform operator is a real user: platform writes run with app.user_id = the operator, and the row-audit
    // trigger writes it to audit_event.actor_user_id (a foreign key to user).
    await admin.query(`INSERT INTO "user" (id, email) VALUES ($1, 'ops@wizard.test')`, [OPS_USER]);
    adminA = await person(ORG_A, "admin-a", ["org_admin"]);
    officerA = await person(ORG_A, "officer-a", ["compliance_officer"]);
    strangerB = await person(ORG_B, "stranger-b", ["org_admin"]);
    adminL = await person(ORG_L, "admin-l", ["org_admin"]);
    officerL = await person(ORG_L, "officer-l", ["compliance_officer"]);

    platform = createDbClient({
      connectionString: urlAs("chartwarden_platform_login", PLATFORM_PASSWORD),
    });
    registerPlatformJob(JOB_ID);
    appUrl = await appRoleConnectionString(admin, DB_URL as string);
    app = createDbClient({ connectionString: appUrl });
  }, 300_000);

  afterAll(async () => {
    await platform?.close();
    await app?.close();
    await admin?.end();
  });

  // ── assembly: every collaborator real, the alert emitter a spy ───────────────────────────────────────────
  const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M34_OUTBOX_EVENTS]));
  const outbox: DrizzleTenantPlatformDeps["outbox"] = {
    publish: (tx, input) => publisher.publish(tx, { ...input, callerModule: "m34" } as never),
  };
  const alerts: AlertEmitter = {
    async emit(_orgId, input) {
      alertCalls.push(input.eventType);
      return { alertId: `a-${alertCalls.length}`, resolvedRecipientCount: 0 };
    },
  };
  const facts = () => ({
    orgSeed: buildOrgSeedFactsReader(app.db),
    orgAdminCount: buildOrgAdminCountReader(app.db),
    macFeedConfigured: buildMacFeedConfiguredReader(buildDrizzleOrgMacJurisdictionReader(app.db)),
  });
  const advancer = () => createOnboardingAdvancer({ db: app.db, outbox, alerts, facts: facts() });
  const backend = (opts: Pick<DrizzleTenantPlatformDeps, "advanceOnboarding" | "warn"> = {}) =>
    createDrizzleTenantPlatformBackend({
      ...opts,
      platformDb: platform.db,
      enqueue: { enqueue: async (q, k) => ({ jobId: `${q}-${k}` }) },
      legalHoldClear: async () => true,
      invitationDelivery: {
        acceptBaseUrl: "http://localhost/x",
        send: async () => undefined as never,
      },
      provisionJobs: {
        status: async () => undefined as never,
        retry: async () => undefined as never,
      },
      auditBypass: m34PlatformBypassAuditor,
      outbox,
      organizations: { ensure: async () => undefined as never },
      featureFlags: {
        list: async () => undefined as never,
        upsert: async () => undefined as never,
        setKillSwitch: async () => undefined as never,
      },
      lifecycleAlerts: alerts,
      supportSessionPorts: {
        audit: { async emitCriticalAudit() {} },
        outbox: { async publish() {} },
        alerts: { async emitAlert() {} },
        now: () => new Date(),
      },
      platformJobId: JOB_ID,
    });
  const wizard = (withAdvance = true, extra: Partial<OnboardingWizardDeps> = {}) =>
    createOnboardingWizard({
      ...extra,
      runner: createDrizzleWizardRunner({
        db: app.db,
        platformDb: platform.db,
        auditBypass: m34PlatformBypassAuditor,
        platformJobId: JOB_ID,
        activation: backend().activateApprovedTenant,
        orgProfileFor: (tx) => buildDrizzleOrgProfilePort(tx),
      }),
      orgProfile: buildDrizzleOrgProfilePort(app.db),
      ...(withAdvance
        ? {
            advance: async ({ tenantAccountId, organizationId }) => {
              await advancer()({ tenantAccountId, orgId: organizationId });
            },
          }
        : {}),
    });

  const taskId = async (tenant: string, key: string): Promise<string> =>
    (
      await admin.query(
        "SELECT id FROM onboarding_task WHERE tenant_account_id=$1 AND template_key=$2",
        [tenant, key],
      )
    ).rows[0].id;
  const statusOf = async (tenant: string, key: string): Promise<string> =>
    (
      await admin.query(
        "SELECT status FROM onboarding_task WHERE tenant_account_id=$1 AND template_key=$2",
        [tenant, key],
      )
    ).rows[0].status;
  const tenantStatus = async (tenant: string): Promise<string> =>
    (await admin.query("SELECT status FROM tenant_account WHERE id=$1", [tenant])).rows[0].status;
  const refusal = async (p: Promise<unknown>): Promise<ChartWardenError> => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(ChartWardenError);
      return e as ChartWardenError;
    }
    throw new Error("expected a typed refusal");
  };
  const evidence = (note: string) => ({
    evidenceNote: note,
    evidenceRef: "DOC-1",
    reason: "confirmed with the customer",
  });
  const attestPlatform = (
    tenant: string,
    slug: string,
    key: string,
    note = "checked and on file",
  ) => taskId(tenant, key).then((id) => wizard().attestPlatform(slug, id, OPS, evidence(note)));
  const attestTenant = (
    actor: TenantActor,
    org: string,
    tenant: string,
    key: string,
    note = "confirmed by the administrator",
  ) =>
    taskId(tenant, key).then((id) => wizard().attestTask(actor, org, id, { evidenceNote: note }));

  // ── migration 1327 ───────────────────────────────────────────────────────────────────────────────────────
  it("seeds the ops wizard order with owners and modes, and retires the three dropped steps", async () => {
    const active = await admin.query(
      "SELECT key, required_role, completion_mode, is_optional FROM onboarding_task_template WHERE retired_at IS NULL ORDER BY canonical_order",
    );
    expect(active.rows.map((r) => r.key)).toEqual(EXPECTED_ORDER);
    const byKey = Object.fromEntries(active.rows.map((r) => [r.key, r]));
    expect(byKey.baa_executed).toMatchObject({
      completion_mode: "auto",
      required_role: "platform_ops",
    });
    expect(byKey.mac_configured).toMatchObject({
      completion_mode: "either",
      required_role: "either",
    });
    expect(byKey.sample_data_loaded).toMatchObject({ is_optional: true });
    expect(byKey.go_live_checklist_complete).toMatchObject({ required_role: "compliance_officer" });
    const retired = await admin.query(
      "SELECT key FROM onboarding_task_template WHERE retired_at IS NOT NULL ORDER BY key",
    );
    expect(retired.rows.map((r) => r.key)).toEqual([
      "org_seeded",
      "payroll_connected",
      "xero_connected",
    ]);
  });

  it("keeps a tenant already mid-onboarding: its history stays, the new steps arrive pending, retired ones are hidden", async () => {
    const view = await wizard(false).getPlatform("wiz-l");
    expect(view.steps.map((s) => s.key)).toEqual(EXPECTED_ORDER);
    expect(view.steps.find((s) => s.key === "account_created")?.status).toBe("done");
    expect(view.steps.find((s) => s.key === "plan_contract")?.status).toBe("pending");
    const rows = await admin.query(
      "SELECT template_key FROM onboarding_task WHERE tenant_account_id=$1",
      [T_L],
    );
    expect(rows.rowCount).toBe(11 + 6); // the eleven it had + the six new steps; the retired rows are kept
    expect(
      view.steps.some((s) => ["xero_connected", "payroll_connected", "org_seeded"].includes(s.key)),
    ).toBe(false);
  });

  it("registers the five new permission keys", async () => {
    const { rows } = await admin.query(
      "SELECT key FROM permission WHERE key = ANY($1) ORDER BY key",
      [
        [
          "go_live.approve_platform",
          "go_live.attest",
          "onboarding.manage_own",
          "onboarding.manage_platform",
          "platform_tenant_baa.write_platform",
        ],
      ],
    );
    expect(rows).toHaveLength(5);
  });

  // ── the strict sequence, on both roles ──────────────────────────────────────────────────────────────────
  it("review fix (code M2): 1329 gives onboarding.manage_own to org_admin roles that existed before the key, and re-applying it is idempotent", async () => {
    const holders = async (org: string) =>
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM role_permission rp JOIN role r ON r.id = rp.role_id
            WHERE rp.permission_key = 'onboarding.manage_own' AND r.key IN ('org_admin','administrator') AND r.organization_id = $1`,
          [org],
        )
      ).rows[0].n as number;
    // ORG_L's org_admin role was materialized BEFORE migration 1329; it holds the key because the migration backfilled it.
    expect(await holders(ORG_L)).toBe(1);
    await apply(sqlFiles().filter((f) => f.startsWith("1329_")));
    expect(await holders(ORG_L)).toBe(1); // ON CONFLICT DO NOTHING: no duplicate grant
    const duplicated = await admin.query(
      `SELECT role_id FROM role_permission WHERE permission_key = 'onboarding.manage_own' GROUP BY role_id HAVING count(*) > 1`,
    );
    expect(duplicated.rowCount).toBe(0);
  });

  it("refuses an out-of-order step on the platform and the tenant roles, and changes nothing", async () => {
    const ccn = await taskId(T_A, "ccn_registered");
    const platformRefusal = await refusal(
      wizard().attestPlatform("wiz-a", ccn, OPS, evidence("too early to attest")),
    );
    expect(platformRefusal).toMatchObject({
      code: "ONBOARDING_STEP_OUT_OF_ORDER",
      statusCode: 409,
    });
    expect(platformRefusal.details?.[0]?.code).toBe("account_created");
    expect((await refusal(wizard().startTask(adminA, ORG_A, ccn))).code).toBe(
      "ONBOARDING_STEP_OUT_OF_ORDER",
    );
    expect(await statusOf(T_A, "ccn_registered")).toBe("pending");
  });

  it("refuses a tenant org_admin the platform-owned step, and a foreign tenant's task id, with no write", async () => {
    const first = await taskId(T_A, "account_created");
    expect(
      (
        await refusal(
          wizard().attestTask(adminA, ORG_A, first, { evidenceNote: "not mine to attest" }),
        )
      ).code,
    ).toBe("ONBOARDING_STEP_OWNER_MISMATCH");
    // Beta's task id, addressed from Alpha, is a 404: RLS hides it from the tenant role, the slug scope from the platform.
    const foreign = await taskId(T_B, "account_created");
    expect(
      (
        await refusal(
          wizard().attestTask(adminA, ORG_A, foreign, { evidenceNote: "cross tenant attempt" }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await refusal(
          wizard().attestPlatform("wiz-a", foreign, OPS, evidence("cross tenant attempt")),
        )
      ).statusCode,
    ).toBe(404);
    expect(await statusOf(T_B, "account_created")).toBe("pending");
    expect(await statusOf(T_A, "account_created")).toBe("pending");
  });

  // ── attestation stored and audited ──────────────────────────────────────────────────────────────────────
  it("stores an attestation with its evidence and attester on the task, and the row audit records it", async () => {
    const step = await attestPlatform(
      T_A,
      "wiz-a",
      "account_created",
      "legal name and time zone confirmed by phone",
    );
    expect(step).toMatchObject({
      status: "done",
      evidence: { note: "legal name and time zone confirmed by phone", ref: "DOC-1" },
      attestedBy: { membershipId: OPS_MEMBERSHIP, actorKind: "platform_ops" },
    });
    const row = (await admin.query("SELECT * FROM onboarding_task WHERE id=$1", [step.id])).rows[0];
    expect(row).toMatchObject({
      status: "done",
      evidence_note: "legal name and time zone confirmed by phone",
      evidence_ref: "DOC-1",
      attested_by_membership_id: OPS_MEMBERSHIP,
      attested_by_actor_kind: "platform_ops",
    });
    expect(row.attested_at).toBeInstanceOf(Date);
    expect(row.completion_evidence.attestation.reason).toBe("confirmed with the customer");
    const audit = await admin.query(
      `SELECT after FROM audit_event WHERE resource_kind='onboarding_task' AND resource_id=$1 AND event_type='onboarding_task.update' ORDER BY created_at DESC LIMIT 1`,
      [step.id],
    );
    expect(audit.rows[0].after).toMatchObject({
      evidence_note: "legal name and time zone confirmed by phone",
      attested_by_membership_id: OPS_MEMBERSHIP,
      status: "done",
    });
  });

  it("the database refuses an attestation that has no attester or evidence it cannot hold", async () => {
    const id = await taskId(T_B, "account_created");
    await expect(
      admin.query("UPDATE onboarding_task SET evidence_note='x' WHERE id=$1", [id]),
    ).rejects.toThrow(/onboarding_task_attestation_ck/);
    await expect(
      admin.query(
        "UPDATE onboarding_task SET evidence_note=$2, attested_by_membership_id=$3, attested_by_actor_kind='tenant', attested_at=now() WHERE id=$1",
        [id, " ".repeat(5), OPS_MEMBERSHIP],
      ),
    ).rejects.toThrow(/onboarding_task_evidence_note_ck/);
  });

  // ── auto / either steps settle from real facts ──────────────────────────────────────────────────────────
  it("settles the BAA and provisioning steps from the real BAA register once the plan step is attested", async () => {
    await admin.query(
      `INSERT INTO platform_tenant_baa_record (organization_id, tenant_account_id, addendum_version, baa_status, executed_on, effective_on, expires_on)
       VALUES ($1,$2,'v1','executed','2026-10-01','2026-10-01', (now() + interval '2 years')::date)`,
      [ORG_A, T_A],
    );
    await attestPlatform(T_A, "wiz-a", "plan_contract", "order form countersigned");
    // The wizard's post-change advance ran the sweep for this tenant: both auto steps settled in one pass.
    expect(await statusOf(T_A, "baa_executed")).toBe("done");
    expect(await statusOf(T_A, "provisioning_complete")).toBe("done");
    expect(await statusOf(T_A, "ccn_registered")).toBe("pending");
  });

  it("re-opening a step keeps later steps as they are and re-locks the unsettled ones (history is kept)", async () => {
    const step = await wizard().reopenPlatform(
      "wiz-a",
      await taskId(T_A, "plan_contract"),
      OPS,
      "wrong plan tier on the order form",
    );
    expect(step).toMatchObject({ status: "in_progress", evidence: null, attestedBy: null });
    expect(await statusOf(T_A, "baa_executed")).toBe("done"); // later steps untouched
    const ccn = await taskId(T_A, "ccn_registered");
    expect(
      (
        await refusal(
          wizard().attestTask(adminA, ORG_A, ccn, { evidenceNote: "provider entity verified" }),
        )
      ).code,
    ).toBe("ONBOARDING_STEP_OUT_OF_ORDER");
    const bag = (
      await admin.query("SELECT completion_evidence FROM onboarding_task WHERE id=$1", [step.id])
    ).rows[0].completion_evidence;
    expect(bag.reopened[0]).toMatchObject({
      reason: "wrong plan tier on the order form",
      previous: { evidenceNote: "order form countersigned" },
    });
    await attestPlatform(T_A, "wiz-a", "plan_contract", "corrected order form countersigned");
  });

  it("the tenant org_admin attests its own step on the app role; an `either` step waits silently for its fact", async () => {
    const done = await attestTenant(
      adminA,
      ORG_A,
      T_A,
      "ccn_registered",
      "provider entity and NPI verified against NPPES",
    );
    expect(done.attestedBy).toMatchObject({
      membershipId: adminA.membershipId,
      actorKind: "tenant",
    });
    // locations_seeded is `either` with a fact (a location) that does not exist yet: no block, no alert, still pending.
    await advancer()({ tenantAccountId: T_A, orgId: ORG_A });
    expect(await statusOf(T_A, "locations_seeded")).toBe("pending");
    const blocked = await admin.query(
      "SELECT 1 FROM outbox_event WHERE event_type='m34.tenant.onboarding_step_blocked' AND organization_id=$1",
      [ORG_A],
    );
    expect(blocked.rowCount).toBe(0);
    await attestPlatform(T_A, "wiz-a", "locations_seeded", "two locations created, one primary");
    await attestTenant(adminA, ORG_A, T_A, "clearinghouse_selected", "bills through Claim.MD");
  });

  it("settles the MAC step from a real MAC credential, and not before", async () => {
    await advancer()({ tenantAccountId: T_A, orgId: ORG_A });
    expect(await statusOf(T_A, "mac_configured")).toBe("pending");
    await admin.query(
      `INSERT INTO mac_submitter_credential (organization_id, provider_entity_id, mac_jurisdiction, submitter_id, trading_partner_id, client_id, client_secret_cipher, client_secret_dek_version, set_by_membership_id)
       VALUES ($1, gen_random_uuid(), 'ngs_j6', 's', 't', 'c', 'cipher', 1, $2)`,
      [ORG_A, memberships["admin-a"]],
    );
    await advancer()({ tenantAccountId: T_A, orgId: ORG_A });
    expect(await statusOf(T_A, "mac_configured")).toBe("done");
  });

  it("settles the first-admin and compliance-officer steps from the org's members; the officer must be an active member", async () => {
    await attestPlatform(
      T_A,
      "wiz-a",
      "payer_enrollment",
      "enrolled with the MAC and two commercial payers",
    );
    await attestPlatform(
      T_A,
      "wiz-a",
      "dosespot_kickoff_initiated",
      "clinic registration submitted",
    );
    expect(await statusOf(T_A, "first_admin_invited")).toBe("done"); // an active org_admin exists
    expect(await statusOf(T_A, "compliance_officer_assigned")).toBe("pending");
    expect(
      (
        await refusal(
          wizard().setComplianceOfficer(adminA, ORG_A, memberships["stranger-b"] as string),
        )
      ).code,
    ).toBe("COMPLIANCE_OFFICER_NOT_A_MEMBER");
    await wizard().setComplianceOfficer(adminA, ORG_A, memberships["officer-a"] as string); // the tenant role's one-column UPDATE
    expect(
      (
        await admin.query(
          "SELECT compliance_officer_membership_id FROM tenant_account WHERE id=$1",
          [T_A],
        )
      ).rows[0].compliance_officer_membership_id,
    ).toBe(memberships["officer-a"]);
    expect(await statusOf(T_A, "compliance_officer_assigned")).toBe("done");
  });

  it("the org profile (time zone, display name) is validated and stored on the organization, by either surface", async () => {
    expect(
      (await refusal(wizard().setOrgProfile(adminA, ORG_A, { orgTimezone: "Mars/Olympus" }))).code,
    ).toBe("INVALID_ORG_TIMEZONE");
    expect(
      await wizard().setOrgProfilePlatform("wiz-a", OPS, {
        orgTimezone: "America/Chicago",
        displayName: "Alpha Hospice of Illinois",
      }),
    ).toEqual({
      orgTimezone: "America/Chicago",
      displayName: "Alpha Hospice of Illinois",
    });
    const org = (
      await admin.query("SELECT display_name, settings FROM organization WHERE id=$1", [ORG_A])
    ).rows[0];
    expect(org).toMatchObject({
      display_name: "Alpha Hospice of Illinois",
      settings: { org_timezone: "America/Chicago" },
    });
    expect(
      await wizard().setOrgProfile(adminA, ORG_A, { orgTimezone: "America/Denver" }),
    ).toMatchObject({ orgTimezone: "America/Denver" });
    expect((await wizard(false).getTenant(ORG_A)).orgProfile).toEqual({
      displayName: "Alpha Hospice of Illinois",
      orgTimezone: "America/Denver",
    });
  });

  // ── the tenant role is boxed in ─────────────────────────────────────────────────────────────────────────
  it("the tenant role cannot change the tenant's status, approve a go-live, or file anything but a pending one", async () => {
    const tenantClient = new Client({ connectionString: appUrl });
    await tenantClient.connect();
    try {
      await tenantClient.query("BEGIN");
      await tenantClient.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      await expect(
        tenantClient.query("UPDATE tenant_account SET status='active' WHERE id=$1", [T_A]),
      ).rejects.toThrow(/permission denied/);
      await tenantClient.query("ROLLBACK");
      await tenantClient.query("BEGIN");
      await tenantClient.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      await expect(
        tenantClient.query(
          `INSERT INTO tenant_go_live_attestation (organization_id, tenant_account_id, status, attested_by_membership_id, attested_by_user_id, approved_by_membership_id, approved_by_user_id, approved_at, approval_reason)
           VALUES ($1,$2,'approved',$3,$4,$5,$6,now(),'self approved by the tenant')`,
          [ORG_A, T_A, memberships["officer-a"], users["officer-a"], OPS_MEMBERSHIP, OPS_USER],
        ),
      ).rejects.toThrow(/row-level security/);
      await tenantClient.query("ROLLBACK");
      // The tenant role may VOID its own pending attestation (how a data change revokes a stale one in the same
      // transaction) and nothing more: never approve, never rewrite who attested, never revoke in another user's name.
      await admin.query(
        `INSERT INTO tenant_go_live_attestation (organization_id, tenant_account_id, attested_by_membership_id, attested_by_user_id)
         VALUES ($1,$2,$3,$4)`,
        [ORG_A, T_A, memberships["officer-a"], users["officer-a"]],
      );
      const asTenant = async (
        sqlText: string,
        params: unknown[] = [],
        userId: string = users["officer-a"] as string,
      ) => {
        await tenantClient.query("BEGIN");
        try {
          await tenantClient.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
          await tenantClient.query("SELECT set_config('app.user_id', $1, true)", [userId]);
          return await tenantClient.query(sqlText, params);
        } finally {
          await tenantClient.query("ROLLBACK");
        }
      };
      await expect(
        asTenant("UPDATE tenant_go_live_attestation SET status='approved'"),
      ).rejects.toThrow(/row-level security/);
      await expect(
        asTenant("UPDATE tenant_go_live_attestation SET attested_by_user_id = $1", [OPS_USER]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asTenant("UPDATE tenant_go_live_attestation SET approved_by_user_id = $1", [OPS_USER]),
      ).rejects.toThrow(/permission denied/);
      // revoking in someone else's name, or without a reason, is refused by the policy / the state CHECK
      await expect(
        asTenant(
          "UPDATE tenant_go_live_attestation SET status='revoked', revoked_by_user_id=$1, revoked_at=now(), revoke_reason='onboarding data changed after attestation'",
          [OPS_USER],
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        asTenant(
          "UPDATE tenant_go_live_attestation SET status='revoked', revoked_by_user_id=$1, revoked_at=now()",
          [users["officer-a"]],
        ),
      ).rejects.toThrow(/row-level security/);
      // the one thing it may do: void it as itself, with a reason
      const voided = await asTenant(
        "UPDATE tenant_go_live_attestation SET status='revoked', revoked_by_user_id=$1, revoked_at=now(), revoke_reason='onboarding data changed after attestation' RETURNING status",
        [users["officer-a"]],
      );
      expect(voided.rowCount).toBe(1);
      await admin.query("DELETE FROM tenant_go_live_attestation WHERE tenant_account_id=$1", [T_A]);
    } finally {
      await tenantClient.end();
    }
  });

  // ── the two-party go-live ───────────────────────────────────────────────────────────────────────────────
  it("approve with no attestation is refused, the manual status path is closed, and the sweep never activates", async () => {
    expect((await wizard(false).getPlatform("wiz-a")).goLive.state).toBe("awaiting_attestation");
    expect(
      (await refusal(wizard().approveGoLive("wiz-a", OPS, "reviewed the evidence and the BAA")))
        .code,
    ).toBe("GO_LIVE_NOT_ATTESTED");
    const manual = await refusal(
      backend().service.transitionStatus("wiz-a", OPS_MEMBERSHIP, {
        toStatus: "active",
        transitionReason: "activating by hand",
      }),
    );
    expect(manual).toMatchObject({ code: "GO_LIVE_TWO_PARTY_REQUIRED", statusCode: 409 });
    await advancer()({ tenantAccountId: T_A, orgId: ORG_A });
    expect(await tenantStatus(T_A)).toBe("onboarding");
  });

  it("only the compliance officer attests; then approval re-checks the guards at approval time and lists what failed", async () => {
    expect((await refusal(wizard().attestGoLive(adminA, ORG_A, undefined))).code).toBe(
      "GO_LIVE_NOT_COMPLIANCE_OFFICER",
    );
    const attested = await wizard().attestGoLive(officerA, ORG_A, "all checks reviewed");
    expect(attested.goLive).toMatchObject({
      state: "awaiting_approval",
      attestation: { status: "pending", attestedByMembershipId: officerA.membershipId },
    });
    expect(await statusOf(T_A, "go_live_checklist_complete")).toBe("in_progress");
    // The BAA now expires inside 90 days: the guard fails at APPROVAL time, so the tenant stays in onboarding.
    await admin.query(
      "UPDATE platform_tenant_baa_record SET expires_on=(now() + interval '30 days')::date WHERE tenant_account_id=$1",
      [T_A],
    );
    const failed = await refusal(
      wizard().approveGoLive("wiz-a", OPS, "reviewed the evidence and the BAA"),
    );
    expect(failed).toMatchObject({ code: "ACTIVATION_GUARDS_FAILED", statusCode: 409 });
    expect(failed.details?.map((d) => d.code)).toEqual(["baaExpiryClearsNinetyDays"]);
    expect(await tenantStatus(T_A)).toBe("onboarding");
    expect(
      (
        await admin.query(
          "SELECT status FROM tenant_go_live_attestation WHERE tenant_account_id=$1",
          [T_A],
        )
      ).rows[0].status,
    ).toBe("pending");
  });

  it("platform approval takes the tenant active, recording both actors, the ledger row and the completion event", async () => {
    await admin.query(
      "UPDATE platform_tenant_baa_record SET expires_on=(now() + interval '2 years')::date WHERE tenant_account_id=$1",
      [T_A],
    );
    const live = await wizard().approveGoLive("wiz-a", OPS, "reviewed the evidence and the BAA");
    expect(live).toMatchObject({
      tenantStatus: "active",
      goLive: {
        state: "live",
        attestation: { status: "approved", approvedByMembershipId: OPS_MEMBERSHIP },
      },
    });
    expect(await tenantStatus(T_A)).toBe("active");
    expect(await statusOf(T_A, "go_live_checklist_complete")).toBe("done");
    const att = (
      await admin.query("SELECT * FROM tenant_go_live_attestation WHERE tenant_account_id=$1", [
        T_A,
      ])
    ).rows[0];
    expect(att).toMatchObject({
      status: "approved",
      attested_by_membership_id: officerA.membershipId,
      approved_by_membership_id: OPS_MEMBERSHIP,
      approval_reason: "reviewed the evidence and the BAA",
    });
    const ledger = (
      await admin.query(
        "SELECT from_status, to_status, actor_kind, actor_membership_id FROM tenant_account_status_event WHERE tenant_account_id=$1 ORDER BY occurred_at DESC LIMIT 1",
        [T_A],
      )
    ).rows[0];
    expect(ledger).toMatchObject({
      from_status: "onboarding",
      to_status: "active",
      actor_kind: "platform_ops",
      actor_membership_id: OPS_MEMBERSHIP,
    });
    const event = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type='m34.tenant.onboarding_completed' AND organization_id=$1",
      [ORG_A],
    );
    expect(event.rowCount).toBe(1);
    expect(event.rows[0].payload).toMatchObject({ tenantAccountId: T_A, orgId: ORG_A });
    // both decisions are in the audit trail
    const audited = await admin.query(
      "SELECT event_type FROM audit_event WHERE resource_kind='tenant_go_live_attestation' AND resource_id=$1 ORDER BY created_at",
      [att.id],
    );
    expect(audited.rows.map((r) => r.event_type)).toEqual([
      "tenant_go_live_attestation.insert",
      "tenant_go_live_attestation.update",
    ]);
    // an active tenant's wizard is closed
    expect(
      (
        await refusal(
          wizard().attestPlatform(
            "wiz-a",
            await taskId(T_A, "sample_data_loaded"),
            OPS,
            evidence("too late for sample data"),
          ),
        )
      ).code,
    ).toBe("TENANT_NOT_ONBOARDING");
  });

  it("the platform login can approve or revoke but never rewrite who attested or what they said", async () => {
    const platformClient = new Client({
      connectionString: urlAs("chartwarden_platform_login", PLATFORM_PASSWORD),
    });
    await platformClient.connect();
    try {
      await expect(
        platformClient.query(
          "UPDATE tenant_go_live_attestation SET attestation_note='edited', attested_by_membership_id=$1",
          [OPS_MEMBERSHIP],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(platformClient.query("DELETE FROM tenant_go_live_attestation")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await platformClient.end();
    }
  });

  // ── the legacy tenant: retired steps do not hold activation back; revoke; the sweep ──────────────────────
  it("lets the legacy tenant go live although its retired steps (xero, payroll, org_seeded) are still open", async () => {
    // Everything required settled, the officer assigned, a long BAA: only the retired rows and sample data are not done.
    await admin.query(
      `UPDATE onboarding_task SET status='done' WHERE tenant_account_id=$1 AND template_key = ANY($2)`,
      [
        T_L,
        EXPECTED_ORDER.filter(
          (k) => !["go_live_checklist_complete", "sample_data_loaded"].includes(k),
        ),
      ],
    );
    await admin.query("UPDATE tenant_account SET compliance_officer_membership_id=$2 WHERE id=$1", [
      T_L,
      memberships["officer-l"],
    ]);
    await admin.query(
      `INSERT INTO platform_tenant_baa_record (organization_id, tenant_account_id, addendum_version, baa_status, executed_on, effective_on, expires_on)
       VALUES ($1,$2,'v1','executed','2026-10-01','2026-10-01', (now() + interval '2 years')::date)`,
      [ORG_L, T_L],
    );
    expect(await statusOf(T_L, "xero_connected")).toBe("pending");
    expect(await statusOf(T_L, "org_seeded")).toBe("done");

    // The sweep walks it and still does not activate.
    await advancer()({ tenantAccountId: T_L, orgId: ORG_L });
    expect(await tenantStatus(T_L)).toBe("onboarding");

    // attest -> platform revokes -> attest again -> approve
    await wizard().attestGoLive(officerL, ORG_L, undefined);
    const revoked = await wizard().revokeGoLive("wiz-l", OPS, "BAA addendum is being renegotiated");
    expect(revoked.goLive).toMatchObject({
      state: "awaiting_attestation",
      attestation: { status: "revoked", revokedByMembershipId: OPS_MEMBERSHIP },
    });
    expect(await statusOf(T_L, "go_live_checklist_complete")).toBe("pending");
    await wizard().attestGoLive(officerL, ORG_L, undefined);
    const live = await wizard().approveGoLive(
      "wiz-l",
      OPS,
      "addendum renegotiated; evidence reviewed",
    );
    expect(live.goLive.state).toBe("live");
    expect(await tenantStatus(T_L)).toBe("active");
    expect(await statusOf(T_L, "xero_connected")).toBe("pending"); // history untouched
    const history = await admin.query(
      "SELECT status FROM tenant_go_live_attestation WHERE tenant_account_id=$1 ORDER BY attested_at",
      [T_L],
    );
    expect(history.rows.map((r) => r.status)).toEqual(["revoked", "approved"]);
    expect(adminL.roles).toContain("org_admin");
  });

  it("tenant B was never touched, and the platform credential's bypass is audited for every platform entry", async () => {
    expect(await tenantStatus(T_B)).toBe("onboarding");
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM onboarding_task WHERE tenant_account_id=$1 AND status <> 'pending'",
          [T_B],
        )
      ).rows[0].n,
    ).toBe(0);
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE event_type='platform.bypass_invoked' AND correlation_id LIKE $1",
      [`platform-bypass:${JOB_ID}:%`],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(10);
    expect((await wizard(false).getTenant(ORG_B)).steps.every((s) => s.status === "pending")).toBe(
      true,
    );
    expect(strangerB.roles).toEqual(["org_admin"]);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════
  // Security review: go-live integrity. Fresh organisations, so the sequential story above is untouched.
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("go-live integrity (security review)", () => {
    const ORG_C = "77777777-7777-4777-8777-777777777c01";
    const ORG_D = "88888888-8888-4888-8888-888888888d01";
    const ORG_E = "99999999-9999-4999-8999-999999999e01";
    const ORG_PLATFORM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
    const T_C = "77777777-7777-4777-8777-777777777c02";
    const T_D = "88888888-8888-4888-8888-888888888d02";
    const T_E = "99999999-9999-4999-8999-999999999e02";

    let dual: { userId: string; tenantMembershipId: string; platformMembershipId: string };
    let officerC: TenantActor;
    let officerD1: TenantActor;
    let officerD2: TenantActor;
    let memberE: TenantActor;
    let inactiveE: TenantActor;
    let adminE: TenantActor;
    let officerE2: TenantActor;
    let adminC: TenantActor;
    let officerC2: TenantActor;
    let opsTwo: PlatformActor;

    /** A tenant whose every gating step is done and whose BAA is long: only go-live is left. */
    async function readyTenant(org: string, tenant: string, slug: string): Promise<void> {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [org, slug],
      );
      await admin.query(
        "INSERT INTO tenant_account (id, organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,'onboarding',$3,'b@x.test','p@x.test')",
        [tenant, org, slug],
      );
      await admin.query(
        `INSERT INTO onboarding_task (organization_id, tenant_account_id, template_key, status)
         SELECT $1, $2, key, CASE WHEN key = 'go_live_checklist_complete' THEN 'pending' ELSE 'done' END::onboarding_task_status
           FROM onboarding_task_template WHERE retired_at IS NULL`,
        [org, tenant],
      );
      await admin.query(
        `INSERT INTO platform_tenant_baa_record (organization_id, tenant_account_id, addendum_version, baa_status, executed_on, effective_on, expires_on)
         VALUES ($1,$2,'v1','executed','2026-10-01','2026-10-01', (now() + interval '2 years')::date)`,
        [org, tenant],
      );
    }
    const assignOfficer = (tenant: string, membership: string) =>
      admin.query("UPDATE tenant_account SET compliance_officer_membership_id=$2 WHERE id=$1", [
        tenant,
        membership,
      ]);
    const attestationRows = async (tenant: string) =>
      (
        await admin.query(
          "SELECT * FROM tenant_go_live_attestation WHERE tenant_account_id=$1 ORDER BY attested_at",
          [tenant],
        )
      ).rows;
    const stepped = (membershipId: string, userId: string): PlatformActor => ({
      kind: "platform",
      userId,
      membershipId,
    });

    beforeAll(async () => {
      for (const [org, tenant, slug] of [
        [ORG_C, T_C, "wiz-c"],
        [ORG_D, T_D, "wiz-d"],
        [ORG_E, T_E, "wiz-e"],
      ] as const) {
        await readyTenant(org, tenant, slug);
      }
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wiz-platform','ChartWarden Operations','ChartWarden Operations')",
        [ORG_PLATFORM],
      );
      // ONE human with two hats: the tenant's compliance officer (ORG_C) and a platform operator (the platform org).
      officerC = await person(ORG_C, "dual-tenant-hat", ["compliance_officer"]);
      const platformMembership = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [officerC.userId, ORG_PLATFORM],
        )
      ).rows[0].id as string;
      dual = {
        userId: officerC.userId,
        tenantMembershipId: officerC.membershipId,
        platformMembershipId: platformMembership,
      };
      await assignOfficer(T_C, officerC.membershipId);
      // The genuine second party: a different human with a platform membership.
      const second = await person(ORG_PLATFORM, "ops-two", []);
      opsTwo = stepped(second.membershipId, second.userId);

      officerD1 = await person(ORG_D, "officer-d1", ["compliance_officer"]);
      officerD2 = await person(ORG_D, "officer-d2", ["compliance_officer"]);
      await assignOfficer(T_D, officerD1.membershipId);

      memberE = await person(ORG_E, "member-e", ["compliance_officer"]);
      inactiveE = await person(ORG_E, "inactive-e", ["compliance_officer"]);
      await admin.query("UPDATE membership SET status='suspended' WHERE id=$1", [
        inactiveE.membershipId,
      ]);
      adminE = await person(ORG_E, "admin-e", ["org_admin"]);
      officerE2 = await person(ORG_E, "officer-e2", ["compliance_officer"]);
      adminC = await person(ORG_C, "admin-c", ["org_admin"]);
      officerC2 = await person(ORG_C, "officer-c2", ["compliance_officer"]);
    }, 120_000);

    // ── HIGH 1: two people, not two memberships ───────────────────────────────────────────────────────────
    it("refuses one human attesting AND approving through two memberships (tenant officer + platform operator)", async () => {
      await wizard(false).attestGoLive(officerC, ORG_C, "all checks reviewed");
      const samePerson = stepped(dual.platformMembershipId, dual.userId);

      const refused = await refusal(
        wizard(false).approveGoLive("wiz-c", samePerson, "reviewed the evidence and the BAA"),
      );

      expect(refused).toMatchObject({ code: "GO_LIVE_SAME_PERSON", statusCode: 409 });
      expect(await tenantStatus(T_C)).toBe("onboarding");
      expect((await attestationRows(T_C))[0]).toMatchObject({
        status: "pending",
        attested_by_user_id: dual.userId,
        attested_by_membership_id: dual.tenantMembershipId,
      });
    });

    it("the database itself refuses an approval by the same user, or the same membership, on the platform login", async () => {
      const platformClient = new Client({
        connectionString: urlAs("chartwarden_platform_login", PLATFORM_PASSWORD),
      });
      await platformClient.connect();
      try {
        const approve = (membership: string, user: string) =>
          platformClient.query(
            `UPDATE tenant_go_live_attestation
                SET status='approved', approved_by_membership_id=$2, approved_by_user_id=$3,
                    approved_at=now(), approval_reason='approved by the very same person', updated_at=now()
              WHERE tenant_account_id=$1 AND status='pending'`,
            [T_C, membership, user],
          );
        await expect(approve(dual.platformMembershipId, dual.userId)).rejects.toThrow(
          /tenant_go_live_attestation_state_ck/,
        );
        await expect(approve(opsTwo.membershipId, dual.userId)).rejects.toThrow(
          /tenant_go_live_attestation_state_ck/,
        );
        await expect(approve(dual.tenantMembershipId, opsTwo.userId)).rejects.toThrow(
          /tenant_go_live_attestation_state_ck/,
        );
      } finally {
        await platformClient.end();
      }
      expect((await attestationRows(T_C))[0]?.status).toBe("pending");
    });

    it("a different human approves it, and both users are recorded on the row", async () => {
      const live = await wizard(false).approveGoLive(
        "wiz-c",
        opsTwo,
        "reviewed the evidence and the BAA",
      );
      expect(live.goLive.state).toBe("live");
      expect(await tenantStatus(T_C)).toBe("active");
      expect((await attestationRows(T_C))[0]).toMatchObject({
        status: "approved",
        attested_by_user_id: dual.userId,
        approved_by_user_id: opsTwo.userId,
        approved_by_membership_id: opsTwo.membershipId,
      });
    });

    it("the tenant's own view of that approval carries no operator id, only ChartWarden operations, the reason and the time", async () => {
      const view = await wizard(false).getTenant(ORG_C);
      const body = JSON.stringify(view);
      expect(body).not.toContain(opsTwo.membershipId);
      expect(body).not.toContain(opsTwo.userId);
      expect(view.goLive.attestation).toMatchObject({
        status: "approved",
        approvedByMembershipId: null,
        approvedByLabel: "ChartWarden operations",
        approvalReason: "reviewed the evidence and the BAA",
        attestedByMembershipId: dual.tenantMembershipId,
      });
      expect(view.goLive.attestation?.approvedAt).not.toBeNull();
      // the platform's own view still names the operator
      expect(
        (await wizard(false).getPlatform("wiz-c")).goLive.attestation?.approvedByMembershipId,
      ).toBe(opsTwo.membershipId);
    });

    // ── MEDIUM 2: a stale or expired attestation is not approvable ───────────────────────────────────────
    const staleCase = async (label: string, change: () => Promise<unknown>, detail: string) => {
      await wizard(false).attestGoLive(officerD1, ORG_D, label);
      await change();
      const err = await refusal(
        wizard(false).approveGoLive("wiz-d", opsTwo, "reviewed the evidence and the BAA"),
      );
      expect(err).toMatchObject({ code: "GO_LIVE_ATTESTATION_STALE", statusCode: 409 });
      expect(err.details?.map((d) => d.code)).toEqual([detail]);
      expect(await tenantStatus(T_D)).toBe("onboarding");
      // platform operations revoke it, which frees the tenant's single pending slot
      await wizard(false).revokeGoLive("wiz-d", opsTwo, "attester changed; attestation voided");
    };

    it("refuses to approve once the attester is no longer an active member", async () => {
      await staleCase(
        "attested, then the officer was suspended",
        () =>
          admin.query("UPDATE membership SET status='suspended' WHERE id=$1", [
            officerD1.membershipId,
          ]),
        "attester_not_active",
      );
      await admin.query("UPDATE membership SET status='active' WHERE id=$1", [
        officerD1.membershipId,
      ]);
    });

    it("refuses to approve once the attester no longer holds compliance_officer", async () => {
      await staleCase(
        "attested, then the role was taken away",
        () =>
          admin.query(
            `DELETE FROM membership_role WHERE membership_id=$1
               AND role_id = (SELECT id FROM role WHERE organization_id=$2 AND key='compliance_officer')`,
            [officerD1.membershipId, ORG_D],
          ),
        "attester_not_compliance_officer",
      );
      await admin.query(
        `INSERT INTO membership_role (organization_id, membership_id, role_id)
         SELECT $1, $2, id FROM role WHERE organization_id=$1 AND key='compliance_officer'`,
        [ORG_D, officerD1.membershipId],
      );
    });

    it("refuses to approve once the attester is no longer the assigned officer", async () => {
      await staleCase(
        "attested, then another officer was assigned out of band",
        () => assignOfficer(T_D, officerD2.membershipId),
        "attester_not_assigned_officer",
      );
      await assignOfficer(T_D, officerD1.membershipId);
    });

    it("refuses to approve a 15-day-old attestation, blocks a fresh one until it is revoked, then approves the new one", async () => {
      await wizard(false).attestGoLive(officerD1, ORG_D, "attested a fortnight ago");
      await admin.query(
        "UPDATE tenant_go_live_attestation SET attested_at = now() - interval '15 days' WHERE tenant_account_id=$1 AND status='pending'",
        [T_D],
      );
      expect(
        (
          await refusal(
            wizard(false).approveGoLive("wiz-d", opsTwo, "reviewed the evidence and the BAA"),
          )
        ).code,
      ).toBe("GO_LIVE_ATTESTATION_EXPIRED");
      expect((await refusal(wizard(false).attestGoLive(officerD1, ORG_D, undefined))).code).toBe(
        "GO_LIVE_ATTESTATION_EXPIRED",
      );
      await wizard(false).revokeGoLive("wiz-d", opsTwo, "expired after fourteen days");
      await wizard(false).attestGoLive(officerD1, ORG_D, "attested again today");
      const live = await wizard(false).approveGoLive(
        "wiz-d",
        opsTwo,
        "reviewed the evidence and the BAA",
      );
      expect(live.goLive.state).toBe("live");
      expect((await attestationRows(T_D)).map((r) => r.status)).toEqual([
        "revoked",
        "revoked",
        "revoked",
        "revoked",
        "approved",
      ]);
    });

    // ── MEDIUM 3: the database refuses a forged or cross-organisation write ─────────────────────────────
    /** Runs `fn` on the NOBYPASSRLS app role inside a transaction that is always rolled back. */
    async function asTenant<T>(
      org: string,
      user: string,
      fn: (c: Client) => Promise<T>,
    ): Promise<T> {
      const client = new Client({ connectionString: appUrl });
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.org_id', $1, true)", [org]);
        await client.query("SELECT set_config('app.user_id', $1, true)", [user]);
        return await fn(client);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
      }
    }
    const file = (
      c: Client,
      v: { org: string; tenant: string; membership: string; user: string },
    ) =>
      c.query(
        `INSERT INTO tenant_go_live_attestation (organization_id, tenant_account_id, attested_by_membership_id, attested_by_user_id)
         VALUES ($1,$2,$3,$4)`,
        [v.org, v.tenant, v.membership, v.user],
      );
    const RLS = /row-level security/;

    it("lets a tenant session file an attestation as itself (the positive control for every refusal below)", async () => {
      await asTenant(ORG_E, memberE.userId, async (c) => {
        const out = await file(c, {
          org: ORG_E,
          tenant: T_E,
          membership: memberE.membershipId,
          user: memberE.userId,
        });
        expect(out.rowCount).toBe(1);
      });
    });

    it("refuses an attestation filed in another user's name, or by a membership of another organisation", async () => {
      await asTenant(ORG_E, memberE.userId, async (c) => {
        await expect(
          file(c, {
            org: ORG_E,
            tenant: T_E,
            membership: memberE.membershipId,
            user: officerD1.userId,
          }),
        ).rejects.toThrow(RLS);
      });
      // The user binding holds (the session user is officer D1) but the membership belongs to ANOTHER organisation.
      await asTenant(ORG_E, officerD1.userId, async (c) => {
        await expect(
          file(c, {
            org: ORG_E,
            tenant: T_E,
            membership: officerD1.membershipId,
            user: officerD1.userId,
          }),
        ).rejects.toThrow(RLS);
      });
    });

    it("refuses an attestation by an inactive membership, and one filed into another organisation", async () => {
      await asTenant(ORG_E, inactiveE.userId, async (c) => {
        await expect(
          file(c, {
            org: ORG_E,
            tenant: T_E,
            membership: inactiveE.membershipId,
            user: inactiveE.userId,
          }),
        ).rejects.toThrow(RLS);
      });
      await asTenant(ORG_E, memberE.userId, async (c) => {
        await expect(
          file(c, {
            org: ORG_D,
            tenant: T_D,
            membership: memberE.membershipId,
            user: memberE.userId,
          }),
        ).rejects.toThrow(RLS);
      });
    });

    it("refuses a row that pairs this organisation with ANOTHER organisation's tenant (composite foreign key)", async () => {
      await asTenant(ORG_E, memberE.userId, async (c) => {
        await expect(
          file(c, {
            org: ORG_E,
            tenant: T_D,
            membership: memberE.membershipId,
            user: memberE.userId,
          }),
        ).rejects.toThrow(/tenant_go_live_attestation_tenant_org_fk/);
      });
    });

    const setOfficer = (c: Client, tenant: string, membership: string | null) =>
      c.query("UPDATE tenant_account SET compliance_officer_membership_id=$2 WHERE id=$1", [
        tenant,
        membership,
      ]);

    it("lets the tenant set its officer to an active member of its own organisation", async () => {
      await asTenant(ORG_E, memberE.userId, async (c) => {
        expect((await setOfficer(c, T_E, memberE.membershipId)).rowCount).toBe(1);
      });
    });

    it("refuses to point the officer at another organisation's member, an inactive member, or nobody", async () => {
      await asTenant(ORG_E, memberE.userId, async (c) => {
        await expect(setOfficer(c, T_E, officerD1.membershipId)).rejects.toThrow(RLS);
      });
      await asTenant(ORG_E, memberE.userId, async (c) => {
        await expect(setOfficer(c, T_E, inactiveE.membershipId)).rejects.toThrow(RLS);
      });
      await asTenant(ORG_E, memberE.userId, async (c) => {
        await expect(setOfficer(c, T_E, null)).rejects.toThrow(RLS);
      });
    });

    it("touches no row of another organisation's tenant", async () => {
      await asTenant(ORG_E, memberE.userId, async (c) => {
        expect((await setOfficer(c, T_D, memberE.membershipId)).rowCount).toBe(0);
      });
      expect(
        (
          await admin.query(
            "SELECT compliance_officer_membership_id AS m FROM tenant_account WHERE id=$1",
            [T_D],
          )
        ).rows[0].m,
      ).toBe(officerD1.membershipId);
    });

    it("lets the officer change while the tenant is onboarding or ACTIVE, and freezes it otherwise", async () => {
      // Decision: a compliance officer legitimately changes after go-live (staff turnover), so `active` is allowed;
      // a suspended or closing tenant is frozen. T_D went active above.
      expect(await tenantStatus(T_D)).toBe("active");
      await asTenant(ORG_D, officerD2.userId, async (c) => {
        expect((await setOfficer(c, T_D, officerD2.membershipId)).rowCount).toBe(1);
      });
      for (const frozen of ["suspended", "offboarding_initiated"]) {
        await admin.query("UPDATE tenant_account SET status=$2 WHERE id=$1", [T_E, frozen]);
        await asTenant(ORG_E, memberE.userId, async (c) => {
          expect((await setOfficer(c, T_E, memberE.membershipId)).rowCount).toBe(0);
        });
      }
      await admin.query("UPDATE tenant_account SET status='onboarding' WHERE id=$1", [T_E]);
    });

    // ── MEDIUM 4: a platform officer assignment is attributed and says why ───────────────────────────────
    it("a platform assignment needs a reason, and names the operator, the organisation and the reason in the audit trail", async () => {
      const reason = "customer named a new officer on the call";
      expect(
        (
          await refusal(
            wizard(false).setComplianceOfficerPlatform(
              "wiz-e",
              OPS,
              officerE2.membershipId,
              "short",
            ),
          )
        ).code,
      ).toBe("ONBOARDING_REASON_REQUIRED");

      await wizard(false).setComplianceOfficerPlatform(
        "wiz-e",
        OPS,
        officerE2.membershipId,
        reason,
      );

      expect(
        (
          await admin.query(
            "SELECT compliance_officer_membership_id AS m FROM tenant_account WHERE id=$1",
            [T_E],
          )
        ).rows[0].m,
      ).toBe(officerE2.membershipId);
      // the explicit entry: operator, organisation, reason, and who it replaced
      const entry = await admin.query(
        `SELECT context FROM audit_event WHERE event_type='m34.onboarding.compliance_officer_assigned' AND resource_id=$1`,
        [T_E],
      );
      expect(entry.rowCount).toBe(1);
      expect(entry.rows[0].context).toMatchObject({
        organizationId: ORG_E,
        operatorUserId: OPS_USER,
        operatorMembershipId: OPS_MEMBERSHIP,
        reason,
        newOfficerMembershipId: officerE2.membershipId,
      });
      // and the row trigger now names the operator too (app.user_id is set on the platform transaction)
      const row = await admin.query(
        `SELECT actor_user_id FROM audit_event WHERE event_type='tenant_account.update' AND resource_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [T_E],
      );
      expect(row.rows[0].actor_user_id).toBe(OPS_USER);
    });

    it("refuses an officer who is a member of the organisation but does not hold the compliance_officer role", async () => {
      expect(
        (await refusal(wizard(false).setComplianceOfficer(adminE, ORG_E, adminE.membershipId)))
          .code,
      ).toBe("COMPLIANCE_OFFICER_LACKS_ROLE");
      expect(
        (
          await refusal(
            wizard(false).setComplianceOfficerPlatform(
              "wiz-e",
              OPS,
              adminE.membershipId,
              "trying an org_admin as the officer",
            ),
          )
        ).statusCode,
      ).toBe(422);
    });

    it("a tenant org_admin's reassignment voids the pending attestation (on a platform transaction, as the admin)", async () => {
      await wizard(false).setComplianceOfficer(adminE, ORG_E, memberE.membershipId);
      await wizard(false).attestGoLive(memberE, ORG_E, "ready from where I sit");
      expect((await attestationRows(T_E)).map((r) => r.status)).toEqual(["pending"]);

      await wizard(false).setComplianceOfficer(adminE, ORG_E, officerE2.membershipId);

      const [voided] = await attestationRows(T_E);
      expect(voided).toMatchObject({
        status: "revoked",
        revoked_by_membership_id: adminE.membershipId,
      });
      expect(voided.revoke_reason).toContain("reassigned");
      expect(await statusOf(T_E, "go_live_checklist_complete")).toBe("pending");
      expect(
        (
          await refusal(
            wizard(false).approveGoLive("wiz-e", opsTwo, "reviewed the evidence and the BAA"),
          )
        ).code,
      ).toBe("GO_LIVE_NOT_ATTESTED");
      // the new officer attests; the previous one no longer may
      expect((await refusal(wizard(false).attestGoLive(memberE, ORG_E, undefined))).code).toBe(
        "GO_LIVE_NOT_ASSIGNED_OFFICER",
      );
      await wizard(false).attestGoLive(officerE2, ORG_E, undefined);
      expect((await attestationRows(T_E)).map((r) => r.status)).toEqual(["revoked", "pending"]);
    });

    it("changes the officer of an ACTIVE tenant on the real roles, and refuses a frozen one", async () => {
      expect(await tenantStatus(T_C)).toBe("active");
      await wizard(false).setComplianceOfficer(adminC, ORG_C, officerC2.membershipId);
      expect(
        (
          await admin.query(
            "SELECT compliance_officer_membership_id AS m FROM tenant_account WHERE id=$1",
            [T_C],
          )
        ).rows[0].m,
      ).toBe(officerC2.membershipId);
      await admin.query("UPDATE tenant_account SET status='suspended' WHERE id=$1", [T_C]);
      expect(
        (await refusal(wizard(false).setComplianceOfficer(adminC, ORG_C, officerC.membershipId)))
          .code,
      ).toBe("COMPLIANCE_OFFICER_LOCKED");
      await admin.query("UPDATE tenant_account SET status='active' WHERE id=$1", [T_C]);
    });

    // ── LOW: the sweep's write is compare-and-set ───────────────────────────────────────────────────────
    it("a sweep that read `pending` cannot overwrite a step that has since moved", async () => {
      const id = await taskId(T_E, "go_live_checklist_complete");
      await admin.query("UPDATE onboarding_task SET status='in_progress' WHERE id=$1", [id]);

      const missed = await new OnboardingRepository(platform.db).updateTaskStatus(id, "pending", {
        status: "done",
        completedAt: new Date(),
      });
      expect(missed).toBeNull();
      expect(await statusOf(T_E, "go_live_checklist_complete")).toBe("in_progress");

      const landed = await new OnboardingRepository(platform.db).updateTaskStatus(
        id,
        "in_progress",
        { status: "pending" },
      );
      expect(landed?.status).toBe("pending");
    });
  });
  // ── the Docker-stack smoke-test gaps (slice 1 fixes) ───────────────────────────────────────────────────────
  describe("smoke-test gaps: BAA register writes on the real platform carrier", () => {
    const ORG_S = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01";
    const T_S = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02";
    // A second tenant for the advance-pass tests: the first test ends its BAA `terminated`, which would govern here.
    const ORG_S2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb03";
    const T_S2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb04";
    // A third for the review-fix tests, which leave executed BAA records behind.
    const ORG_S3 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb07";
    const T_S3 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb08";

    beforeAll(async () => {
      for (const [org, tenant, slug] of [
        [ORG_S, T_S, "wiz-s"],
        [ORG_S2, T_S2, "wiz-s2"],
        [ORG_S3, T_S3, "wiz-s3"],
      ] as const) {
        await admin.query(
          "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
          [org, slug],
        );
        await admin.query(
          "INSERT INTO tenant_account (id, organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,'onboarding',$3,'b@x.test','p@x.test')",
          [tenant, org, slug],
        );
        await admin.query(
          `INSERT INTO onboarding_task (organization_id, tenant_account_id, template_key)
           SELECT $1, $2, key FROM onboarding_task_template WHERE retired_at IS NULL`,
          [org, tenant],
        );
      }
    }, 60_000);

    const baaRow = async (id: string) =>
      (await admin.query("SELECT * FROM platform_tenant_baa_record WHERE id=$1", [id])).rows[0];

    it("creates and updates a BAA record on the real platform carrier (the register was a 42501 before)", async () => {
      const created = await backend().service.createBaaRecord(OPS_USER, {
        tenantAccountId: T_S,
        addendumVersion: "v1",
        baaStatus: "executed",
        executedOn: "2026-10-01",
        effectiveOn: "2026-10-01",
        expiresOn: "2028-10-01",
        breachNotificationContactEmail: "privacy@wiz-s.test",
        breachNotificationContactPhone: null,
        documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001",
      });
      expect(await baaRow(created.id)).toMatchObject({
        organization_id: ORG_S,
        tenant_account_id: T_S,
        baa_status: "executed",
        breach_notification_contact_email: "privacy@wiz-s.test",
      });

      const updated = await backend().service.updateBaaRecord(created.id, OPS_USER, {
        baaStatus: "terminated",
        breachNotificationContactEmail: "privacy2@wiz-s.test",
      });
      expect(updated.baaStatus).toBe("terminated");
      expect(await baaRow(created.id)).toMatchObject({
        baa_status: "terminated",
        breach_notification_contact_email: "privacy2@wiz-s.test",
      });
    });

    it("migration 1332 alone grants the same (a database where the carrier already exists when it lands)", async () => {
      const can = async (priv: "INSERT" | "UPDATE", column: string) =>
        (
          await admin.query(
            "SELECT has_column_privilege('chartwarden_platform','platform_tenant_baa_record',$1,$2) AS ok",
            [column, priv],
          )
        ).rows[0].ok as boolean;
      await admin.query(
        "REVOKE INSERT, UPDATE ON platform_tenant_baa_record FROM chartwarden_platform",
      );
      expect(await can("INSERT", "baa_status")).toBe(false);
      expect(await can("UPDATE", "baa_status")).toBe(false);

      await apply(sqlFiles().filter((f) => f.startsWith("1332_")));

      for (const column of [
        "organization_id",
        "tenant_account_id",
        "addendum_version",
        "baa_status",
        "executed_on",
        "effective_on",
        "expires_on",
        "breach_notification_contact_email",
        "breach_notification_contact_phone",
        "document_id",
        "recorded_by_user_id",
      ]) {
        expect(await can("INSERT", column), `INSERT ${column}`).toBe(true);
      }
      // The INSERT grant is a column list: not the subcontractor set, not the tenant officer's attestation, not the key.
      for (const column of [
        "id",
        "subcontractor_disclosure_set",
        "compliance_officer_attestation_membership_id",
        "attested_at",
        "updated_by_user_id",
      ]) {
        expect(await can("INSERT", column), `INSERT ${column}`).toBe(false);
      }
      for (const column of [
        "baa_status",
        "executed_on",
        "effective_on",
        "expires_on",
        "breach_notification_contact_email",
        "breach_notification_contact_phone",
        "document_id",
        "updated_by_user_id",
      ]) {
        expect(await can("UPDATE", column), `UPDATE ${column}`).toBe(true);
      }
      for (const column of [
        "attested_at",
        "organization_id",
        "tenant_account_id",
        "recorded_by_user_id",
      ]) {
        expect(await can("UPDATE", column), `UPDATE ${column}`).toBe(false);
      }
    });

    it("review fix M4: an executed BAA needs its document (422), on create and on update, and a row records who filed and who last changed it", async () => {
      const base = {
        tenantAccountId: T_S3,
        addendumVersion: "v-doc",
        executedOn: "2026-10-01",
        effectiveOn: "2026-10-01",
        expiresOn: "2028-10-01",
        breachNotificationContactEmail: null,
        breachNotificationContactPhone: null,
      };
      const refused = await refusal(
        backend().service.createBaaRecord(OPS_USER, {
          ...base,
          baaStatus: "executed",
          documentId: null,
        }),
      );
      expect(refused.code).toBe("BAA_DOCUMENT_REQUIRED");
      expect(refused.statusCode).toBe(422);
      expect(
        (
          await admin.query(
            "SELECT 1 FROM platform_tenant_baa_record WHERE addendum_version='v-doc'",
          )
        ).rowCount,
      ).toBe(0);

      const pending = await backend().service.createBaaRecord(OPS_USER, {
        ...base,
        baaStatus: "pending",
        documentId: null,
      });
      expect(await baaRow(pending.id)).toMatchObject({
        recorded_by_user_id: OPS_USER,
        updated_by_user_id: null,
      });
      const noDoc = await refusal(
        backend().service.updateBaaRecord(pending.id, OPS_USER, { baaStatus: "executed" }),
      );
      expect(noDoc.code).toBe("BAA_DOCUMENT_REQUIRED");
      expect(await baaRow(pending.id)).toMatchObject({
        baa_status: "pending",
        updated_by_user_id: null,
      });

      await backend().service.updateBaaRecord(pending.id, OPS_USER, {
        baaStatus: "executed",
        documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002",
      });
      expect(await baaRow(pending.id)).toMatchObject({
        baa_status: "executed",
        document_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002",
        recorded_by_user_id: OPS_USER,
        updated_by_user_id: OPS_USER,
      });
    });

    it("review fix (INSERT grant): the platform login can file a record's columns but not the subcontractor set or the officer's attestation", async () => {
      const login = new Client({
        connectionString: urlAs("chartwarden_platform_login", PLATFORM_PASSWORD),
      });
      await login.connect();
      try {
        for (const column of [
          "subcontractor_disclosure_set",
          "attested_at",
          "compliance_officer_attestation_membership_id",
        ]) {
          await expect(
            login.query(
              `INSERT INTO platform_tenant_baa_record (organization_id, tenant_account_id, addendum_version, baa_status, ${column})
               VALUES ($1,$2,$3,'pending', ${column === "subcontractor_disclosure_set" ? "'[]'::jsonb" : column === "attested_at" ? "now()" : `'${OPS_MEMBERSHIP}'`})`,
              [ORG_S3, T_S3, `v-grant-${column}`],
            ),
            column,
          ).rejects.toMatchObject({ code: "42501" });
        }
      } finally {
        await login.end();
      }
    });

    it("review fix (security M3): a BAA write voids a pending go-live attestation in the same transaction, on the platform carrier", async () => {
      const officer = await person(ORG_S3, "officer-s3", ["compliance_officer"]);
      const attested = (
        await admin.query(
          `INSERT INTO tenant_go_live_attestation (organization_id, tenant_account_id, attested_by_membership_id, attested_by_user_id)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [ORG_S3, T_S3, officer.membershipId, officer.userId],
        )
      ).rows[0].id as string;
      await admin.query(
        "UPDATE onboarding_task SET status='in_progress' WHERE tenant_account_id=$1 AND template_key='go_live_checklist_complete'",
        [T_S3],
      );
      await backend().service.createBaaRecord(OPS_USER, {
        tenantAccountId: T_S3,
        addendumVersion: "v-void",
        baaStatus: "pending",
        executedOn: null,
        effectiveOn: null,
        expiresOn: null,
        breachNotificationContactEmail: null,
        breachNotificationContactPhone: null,
        documentId: null,
      });
      const row = (
        await admin.query("SELECT * FROM tenant_go_live_attestation WHERE id=$1", [attested])
      ).rows[0];
      expect(row).toMatchObject({
        status: "revoked",
        revoke_reason: "onboarding data changed after attestation",
        revoked_by_user_id: OPS_USER,
        revoked_by_membership_id: null,
      });
      expect(await statusOf(T_S3, "go_live_checklist_complete")).toBe("pending");
    });

    it("review fix (security M4): the operator who recorded the governing BAA cannot approve the go-live (real roles)", async () => {
      const ORG_W = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb05";
      const T_W = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb06";
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wiz-w','wiz-w','wiz-w')",
        [ORG_W],
      );
      await admin.query(
        "INSERT INTO tenant_account (id, organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,'onboarding','wiz-w','b@x.test','p@x.test')",
        [T_W, ORG_W],
      );
      await admin.query(
        `INSERT INTO onboarding_task (organization_id, tenant_account_id, template_key, status)
         SELECT $1, $2, key, CASE WHEN key = 'go_live_checklist_complete' THEN 'pending' ELSE 'done' END::onboarding_task_status
           FROM onboarding_task_template WHERE retired_at IS NULL`,
        [ORG_W, T_W],
      );
      const officer = await person(ORG_W, "officer-w", ["compliance_officer"]);
      await admin.query(
        "UPDATE tenant_account SET compliance_officer_membership_id=$2 WHERE id=$1",
        [T_W, officer.membershipId],
      );
      // OPS files the executed BAA (with its document) through the real service, then the officer attests.
      await backend().service.createBaaRecord(OPS_USER, {
        tenantAccountId: T_W,
        addendumVersion: "v1",
        baaStatus: "executed",
        executedOn: "2026-10-01",
        effectiveOn: "2026-10-01",
        expiresOn: (await admin.query("SELECT (now() + interval '2 years')::date AS d")).rows[0].d
          .toISOString()
          .slice(0, 10),
        breachNotificationContactEmail: null,
        breachNotificationContactPhone: null,
        documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0003",
      });
      await wizard(false).attestGoLive(officer, ORG_W, "ready");

      const err = await refusal(
        wizard(false).approveGoLive("wiz-w", OPS, "reviewed the evidence and the BAA"),
      );
      expect(err.code).toBe("GO_LIVE_APPROVER_WROTE_BAA");
      expect(await tenantStatus(T_W)).toBe("onboarding");

      // A different operator approves.
      const OTHER_OPS = "a0000000-0000-4000-8000-000000007799";
      await admin.query(`INSERT INTO "user" (id, email) VALUES ($1, 'ops2@wizard.test')`, [
        OTHER_OPS,
      ]);
      const other: PlatformActor = {
        kind: "platform",
        userId: OTHER_OPS,
        membershipId: "b0000000-0000-4000-8000-000000007799",
      };
      const live = await wizard(false).approveGoLive(
        "wiz-w",
        other,
        "reviewed the evidence and the BAA",
      );
      expect(live.goLive.state).toBe("live");
    });

    it("a BAA write runs the advance pass for that tenant at once: the blocked step settles without waiting for the sweep", async () => {
      await attestPlatform(T_S2, "wiz-s2", "account_created", "organisation confirmed");
      await attestPlatform(T_S2, "wiz-s2", "plan_contract", "order form countersigned");
      await advancer()({ tenantAccountId: T_S2, orgId: ORG_S2 });
      expect(await statusOf(T_S2, "baa_executed")).toBe("blocked"); // no BAA yet: an auto step blocks

      const advanced: string[] = [];
      const warned: string[] = [];
      await backend({
        warn: (message, context) => warned.push(`${message} ${JSON.stringify(context)}`),
        advanceOnboarding: async (tenant) => {
          advanced.push(tenant.tenantAccountId);
          await advancer()({
            tenantAccountId: tenant.tenantAccountId,
            orgId: tenant.organizationId,
          });
        },
      }).service.createBaaRecord(OPS_USER, {
        tenantAccountId: T_S2,
        addendumVersion: "v-advance",
        baaStatus: "executed",
        executedOn: "2026-10-01",
        effectiveOn: "2026-10-01",
        expiresOn: "2028-10-01",
        breachNotificationContactEmail: null,
        breachNotificationContactPhone: null,
        documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001",
      });

      expect(warned).toEqual([]);
      expect(advanced).toEqual([T_S2]);
      expect(await statusOf(T_S2, "baa_executed")).toBe("done");
      expect(await statusOf(T_S2, "provisioning_complete")).toBe("done");
    });

    it("an advance failure after a BAA write is logged, never thrown: the write stays", async () => {
      const warnings: string[] = [];
      const created = await backend({
        advanceOnboarding: async () => {
          throw new Error("advance pass unavailable");
        },
        warn: (message) => warnings.push(message),
      }).service.createBaaRecord(OPS_USER, {
        tenantAccountId: T_S2,
        addendumVersion: "v-advance-fails",
        baaStatus: "pending",
        executedOn: null,
        effectiveOn: null,
        expiresOn: null,
        breachNotificationContactEmail: null,
        breachNotificationContactPhone: null,
        documentId: null,
      });
      expect(await baaRow(created.id)).toMatchObject({ baa_status: "pending" });
      expect(warnings).toHaveLength(1);
    });

    it("the grant is narrow: the platform login cannot rewrite the tenant, the version or the officer's attestation", async () => {
      const row = (
        await admin.query(
          `INSERT INTO platform_tenant_baa_record (organization_id, tenant_account_id, addendum_version, baa_status)
           VALUES ($1,$2,'v-narrow','pending') RETURNING id`,
          [ORG_S, T_S],
        )
      ).rows[0];
      const login = new Client({
        connectionString: urlAs("chartwarden_platform_login", PLATFORM_PASSWORD),
      });
      await login.connect();
      try {
        for (const set of [
          "attested_at = now()",
          `compliance_officer_attestation_membership_id = '${OPS_MEMBERSHIP}'`,
          `organization_id = '${ORG_A}'`,
          "addendum_version = 'v9'",
          "subcontractor_disclosure_set = '[]'::jsonb",
        ]) {
          await expect(
            login.query(`UPDATE platform_tenant_baa_record SET ${set} WHERE id = $1`, [row.id]),
            set,
          ).rejects.toMatchObject({ code: "42501" });
        }
      } finally {
        await login.end();
      }
    });
  });

  describe("smoke-test gaps: designating a new tenant's compliance officer", () => {
    const ORG_O = "cccccccc-cccc-4ccc-8ccc-cccccccccc01";
    const T_O = "cccccccc-cccc-4ccc-8ccc-cccccccccc02";
    const ORG_NR = "cccccccc-cccc-4ccc-8ccc-cccccccccc03"; // an organization that has no compliance_officer role row
    const T_NR = "cccccccc-cccc-4ccc-8ccc-cccccccccc04";
    const REASON = "customer named its administrator as the compliance officer";
    let adminO: TenantActor;
    let secondAdminO: TenantActor;
    let adminNr: TenantActor;
    const bound: Array<[string, string]> = [];
    const withBinder = () =>
      wizard(false, {
        bindComplianceOfficerRole: createComplianceOfficerRoleBinder(app.db, (org, user) =>
          bound.push([org, user]),
        ),
      });
    const grants = async (membershipId: string) =>
      (
        await admin.query(
          `SELECT r.key, mr.granted_by, mr.expires_at, mr.organization_id FROM membership_role mr
             JOIN role r ON r.id = mr.role_id WHERE mr.membership_id = $1 AND r.key = 'compliance_officer'`,
          [membershipId],
        )
      ).rows;
    const officerOf = async (tenant: string) =>
      (
        await admin.query(
          "SELECT compliance_officer_membership_id AS m FROM tenant_account WHERE id=$1",
          [tenant],
        )
      ).rows[0].m as string | null;

    beforeAll(async () => {
      for (const [org, tenant, slug] of [
        [ORG_O, T_O, "wiz-o"],
        [ORG_NR, T_NR, "wiz-nr"],
      ] as const) {
        await admin.query(
          "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
          [org, slug],
        );
        await admin.query(
          "INSERT INTO tenant_account (id, organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,'onboarding',$3,'b@x.test','p@x.test')",
          [tenant, org, slug],
        );
      }
      // The org's role rows exist (provisioning materializes them); nobody holds compliance_officer yet.
      await person(ORG_O, "seed-officer-o", ["compliance_officer"]);
      await admin.query("DELETE FROM membership_role WHERE membership_id = $1", [
        memberships["seed-officer-o"],
      ]);
      adminO = await person(ORG_O, "admin-o", ["org_admin"]);
      secondAdminO = await person(ORG_O, "admin-o2", ["org_admin"]);
      adminNr = await person(ORG_NR, "admin-nr", ["org_admin"]);
    }, 60_000);

    it("the tenant's own route stays strict: its org_admin cannot designate a member who lacks the role", async () => {
      const err = await refusal(
        withBinder().setComplianceOfficer(adminO, ORG_O, adminO.membershipId),
      );
      expect(err.code).toBe("COMPLIANCE_OFFICER_LACKS_ROLE");
      expect(await grants(adminO.membershipId)).toEqual([]);
      expect(await officerOf(T_O)).toBeNull();
    });

    it("the platform route binds the role on the tenant's RLS scope, designates the member, and audits operator, organisation and reason", async () => {
      bound.length = 0;
      const out = await withBinder().setComplianceOfficerPlatform(
        "wiz-o",
        OPS,
        adminO.membershipId,
        REASON,
      );
      expect(out).toEqual({ complianceOfficerMembershipId: adminO.membershipId });

      expect(await officerOf(T_O)).toBe(adminO.membershipId);
      expect(await grants(adminO.membershipId)).toEqual([
        {
          key: "compliance_officer",
          granted_by: OPS_USER,
          expires_at: null,
          organization_id: ORG_O,
        },
      ]);
      expect(bound).toEqual([[ORG_O, adminO.userId]]);

      const role = await admin.query(
        `SELECT actor_user_id, organization_id, after FROM audit_event
          WHERE event_type='m3.role.assigned' AND resource_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [adminO.membershipId],
      );
      expect(role.rows[0]).toMatchObject({
        actor_user_id: OPS_USER,
        organization_id: ORG_O,
        after: {
          roleKey: "compliance_officer",
          assignedBy: "platform_ops",
          operatorUserId: OPS_USER,
          operatorMembershipId: OPS_MEMBERSHIP,
          tenantAccountId: T_O,
          reason: REASON,
        },
      });
      const assigned = await admin.query(
        `SELECT context FROM audit_event WHERE event_type='m34.onboarding.compliance_officer_assigned' AND resource_id=$1`,
        [T_O],
      );
      expect(assigned.rows[0].context).toMatchObject({
        operatorUserId: OPS_USER,
        organizationId: ORG_O,
        reason: REASON,
        roleBoundByOperator: "true",
      });
    });

    it("a repeat assignment binds nothing new", async () => {
      bound.length = 0;
      await withBinder().setComplianceOfficerPlatform("wiz-o", OPS, adminO.membershipId, REASON);
      expect(bound).toEqual([]);
      expect(await grants(adminO.membershipId)).toHaveLength(1);
    });

    it("binds only while the tenant is onboarding: once it is live the platform route needs the role already", async () => {
      await admin.query("UPDATE tenant_account SET status='active' WHERE id=$1", [T_O]);
      try {
        const err = await refusal(
          withBinder().setComplianceOfficerPlatform(
            "wiz-o",
            OPS,
            secondAdminO.membershipId,
            REASON,
          ),
        );
        expect(err.code).toBe("COMPLIANCE_OFFICER_LACKS_ROLE");
        expect(await grants(secondAdminO.membershipId)).toEqual([]);
      } finally {
        await admin.query("UPDATE tenant_account SET status='onboarding' WHERE id=$1", [T_O]);
      }
    });

    it("never reaches across tenants: another organization's member is refused and keeps no grant", async () => {
      const err = await refusal(
        withBinder().setComplianceOfficerPlatform("wiz-o", OPS, strangerB.membershipId, REASON),
      );
      expect(err.code).toBe("COMPLIANCE_OFFICER_NOT_A_MEMBER");
      // The binder itself, as the NOBYPASSRLS tenant role, refuses a membership of another org too.
      const bind = createComplianceOfficerRoleBinder(app.db);
      await expect(
        bind({
          organizationId: ORG_O,
          tenantAccountId: T_O,
          membershipId: strangerB.membershipId,
          operator: { userId: OPS_USER, membershipId: OPS_MEMBERSHIP },
          reason: REASON,
        }),
      ).rejects.toMatchObject({ code: "COMPLIANCE_OFFICER_NOT_A_MEMBER" });
      expect(await grants(strangerB.membershipId)).toEqual([]);
    });

    it("review fix: the unbinder expires a grant the assignment bound (history kept, audited), and does nothing for a member without one", async () => {
      const bind = createComplianceOfficerRoleBinder(app.db);
      const unbind = createComplianceOfficerRoleUnbinder(app.db, (org, user) =>
        bound.push([org, user]),
      );
      const input = {
        organizationId: ORG_O,
        tenantAccountId: T_O,
        membershipId: secondAdminO.membershipId,
        operator: { userId: OPS_USER, membershipId: OPS_MEMBERSHIP },
        reason: REASON,
      };
      await bind(input);
      expect(await grants(secondAdminO.membershipId)).toHaveLength(1);

      bound.length = 0;
      await unbind(input);
      const rows = (
        await admin.query(
          `SELECT mr.expires_at FROM membership_role mr JOIN role r ON r.id = mr.role_id
            WHERE mr.membership_id = $1 AND r.key = 'compliance_officer'`,
          [secondAdminO.membershipId],
        )
      ).rows;
      expect(rows).toHaveLength(1); // expired, never deleted
      expect(new Date(rows[0].expires_at).getTime()).toBeLessThanOrEqual(Date.now());
      expect(bound).toEqual([[ORG_O, secondAdminO.userId]]);
      const audit = await admin.query(
        `SELECT actor_user_id, after FROM audit_event WHERE event_type='m3.role.revoked' AND resource_id=$1`,
        [secondAdminO.membershipId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].actor_user_id).toBe(OPS_USER);
      expect(audit.rows[0].after).toMatchObject({
        roleKey: "compliance_officer",
        revokedBy: "platform_ops",
      });

      bound.length = 0;
      await unbind(input); // nothing live to expire: a no-op, no second audit row
      expect(bound).toEqual([]);
      expect(
        (
          await admin.query(
            `SELECT 1 FROM audit_event WHERE event_type='m3.role.revoked' AND resource_id=$1`,
            [secondAdminO.membershipId],
          )
        ).rowCount,
      ).toBe(1);
    });

    it("an organization with no compliance_officer role is refused with a typed 422 and nothing is bound", async () => {
      const err = await refusal(
        withBinder().setComplianceOfficerPlatform("wiz-nr", OPS, adminNr.membershipId, REASON),
      );
      expect(err.code).toBe("COMPLIANCE_OFFICER_ROLE_UNAVAILABLE");
      expect(err.statusCode).toBe(422);
      expect(await officerOf(T_NR)).toBeNull();
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM membership_role WHERE organization_id=$1",
            [ORG_NR],
          )
        ).rows[0].n,
      ).toBe(1); // admin-nr's own org_admin grant only
    });
  });

  describe("review fix H2: ChartWarden platform staff are never the compliance officer or the go-live attester", () => {
    const ORG_S = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01";
    const T_S = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02";
    const ORG_HOME = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee03"; // the operators' home organization
    const REASON = "customer named its administrator as the compliance officer";
    let adminS: TenantActor;
    let audienceBound: TenantActor; // an operator bound to platform_alert_audience in the tenant, holding compliance_officer
    let homeHolder: TenantActor; // a plain tenant membership whose USER holds platform_ops at home
    let opsOwn: TenantActor; // the acting operator's own membership in the tenant
    const grants = async (membershipId: string) =>
      (
        await admin.query(
          `SELECT r.key FROM membership_role mr JOIN role r ON r.id = mr.role_id
            WHERE mr.membership_id = $1 AND r.key = 'compliance_officer'`,
          [membershipId],
        )
      ).rows;
    const withBinder = () =>
      wizard(false, { bindComplianceOfficerRole: createComplianceOfficerRoleBinder(app.db) });
    const platformRole = async (key: string): Promise<string> =>
      (
        await admin.query(
          `INSERT INTO role (organization_id, key, name, category, scope_level)
           VALUES (NULL, $1, $1, 'platform_staff', 'organization')
           ON CONFLICT (key) WHERE organization_id IS NULL DO UPDATE SET name = excluded.name RETURNING id`,
          [key],
        )
      ).rows[0].id as string;

    beforeAll(async () => {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'h2-tenant','h2-tenant','h2-tenant'), ($2,'h2-home','h2-home','h2-home')",
        [ORG_S, ORG_HOME],
      );
      await admin.query(
        "INSERT INTO tenant_account (id, organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,'onboarding','h2-tenant','b@x.test','p@x.test')",
        [T_S, ORG_S],
      );
      adminS = await person(ORG_S, "admin-s", ["org_admin"]);
      await person(ORG_S, "seed-officer-s", ["compliance_officer"]); // materializes the org's role rows
      await admin.query("DELETE FROM membership_role WHERE membership_id = $1", [
        memberships["seed-officer-s"],
      ]);
      audienceBound = await person(ORG_S, "colleague-s", ["compliance_officer"]);
      homeHolder = await person(ORG_S, "home-holder-s", ["org_admin"]);
      // The operators: platform_ops at home (platform-owned role row), audience-bound in the tenant.
      const platformOps = await platformRole("platform_ops");
      const audience = await platformRole("platform_alert_audience");
      await admin.query(
        "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
        [ORG_S, audienceBound.membershipId, audience],
      );
      for (const user of [audienceBound.userId, homeHolder.userId, OPS_USER]) {
        const home = (
          await admin.query(
            `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
            [user, ORG_HOME],
          )
        ).rows[0].id as string;
        await admin.query(
          "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
          [ORG_HOME, home, platformOps],
        );
      }
      // The acting operator also has a plain membership in the tenant (every operator does).
      const own = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [OPS_USER, ORG_S],
        )
      ).rows[0].id as string;
      opsOwn = { kind: "tenant", userId: OPS_USER, membershipId: own, roles: [] };
    }, 60_000);

    it("the platform route refuses the operator's own membership, an audience-bound colleague and a home-org platform role holder, and binds nothing", async () => {
      for (const member of [opsOwn, audienceBound, homeHolder]) {
        const err = await refusal(
          withBinder().setComplianceOfficerPlatform("h2-tenant", OPS, member.membershipId, REASON),
        );
        expect(err.code, member.membershipId).toBe("COMPLIANCE_OFFICER_PLATFORM_STAFF");
        expect(err.statusCode).toBe(422);
        expect(await grants(member.membershipId), member.membershipId).toEqual(
          member === audienceBound ? [{ key: "compliance_officer" }] : [],
        );
      }
      const officer = await admin.query(
        "SELECT compliance_officer_membership_id AS m FROM tenant_account WHERE id=$1",
        [T_S],
      );
      expect(officer.rows[0].m).toBeNull();
    });

    it("the real binder refuses the same members on its own, as the tenant role", async () => {
      const bind = createComplianceOfficerRoleBinder(app.db);
      for (const member of [opsOwn, homeHolder]) {
        await expect(
          bind({
            organizationId: ORG_S,
            tenantAccountId: T_S,
            membershipId: member.membershipId,
            operator: { userId: OPS_USER, membershipId: OPS_MEMBERSHIP },
            reason: REASON,
          }),
        ).rejects.toMatchObject({ code: "COMPLIANCE_OFFICER_PLATFORM_STAFF", statusCode: 422 });
        expect(await grants(member.membershipId)).toEqual([]);
      }
    });

    it("the tenant route refuses platform staff even when they already hold the role, on the tenant role's own holder read", async () => {
      const err = await refusal(
        wizard(false).setComplianceOfficer(adminS, ORG_S, audienceBound.membershipId),
      );
      expect(err.code).toBe("COMPLIANCE_OFFICER_PLATFORM_STAFF");
    });

    it("a platform operator who already holds the role and is the assigned officer cannot attest go-live", async () => {
      await admin.query(
        `INSERT INTO onboarding_task (organization_id, tenant_account_id, template_key, status)
         SELECT $1, $2, key, CASE WHEN key = 'go_live_checklist_complete' THEN 'pending' ELSE 'done' END::onboarding_task_status
           FROM onboarding_task_template WHERE retired_at IS NULL`,
        [ORG_S, T_S],
      );
      await admin.query(
        `INSERT INTO platform_tenant_baa_record (organization_id, tenant_account_id, addendum_version, baa_status, executed_on, effective_on, expires_on)
         VALUES ($1,$2,'v1','executed','2026-10-01','2026-10-01', (now() + interval '2 years')::date)`,
        [ORG_S, T_S],
      );
      await admin.query(
        "UPDATE tenant_account SET compliance_officer_membership_id=$2 WHERE id=$1",
        [T_S, audienceBound.membershipId],
      );
      const err = await refusal(wizard(false).attestGoLive(audienceBound, ORG_S, "ready"));
      expect(err.code).toBe("COMPLIANCE_OFFICER_PLATFORM_STAFF");
      expect(
        (
          await admin.query("SELECT 1 FROM tenant_go_live_attestation WHERE tenant_account_id=$1", [
            T_S,
          ])
        ).rowCount,
      ).toBe(0);
    });

    it("an attestation whose attester is now platform staff is stale at approval, read on the platform pool", async () => {
      const ordinary = await person(ORG_S, "ordinary-officer-s", ["compliance_officer"]);
      await admin.query(
        "UPDATE tenant_account SET compliance_officer_membership_id=$2 WHERE id=$1",
        [T_S, ordinary.membershipId],
      );
      await wizard(false).attestGoLive(ordinary, ORG_S, "ready");
      const platformOps = await platformRole("platform_ops");
      const home = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [ordinary.userId, ORG_HOME],
        )
      ).rows[0].id as string;
      await admin.query(
        "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
        [ORG_HOME, home, platformOps],
      );
      const err = await refusal(
        wizard(false).approveGoLive("h2-tenant", OPS, "reviewed the evidence and the BAA"),
      );
      expect(err.code).toBe("GO_LIVE_ATTESTATION_STALE");
      expect(err.details?.map((d) => d.code)).toEqual(["attester_platform_staff"]);
      expect(await tenantStatus(T_S)).toBe("onboarding");
    });
  });

  describe("review fix L3 / security M3: the org-profile write is one transaction with its status check and the attestation void", () => {
    const ORG_P = "ffffffff-ffff-4fff-8fff-ffffffffff11";
    const T_P = "ffffffff-ffff-4fff-8fff-ffffffffff12";
    let adminP: TenantActor;
    let officerP: TenantActor;
    const displayName = async () =>
      (await admin.query("SELECT display_name FROM organization WHERE id=$1", [ORG_P])).rows[0]
        .display_name as string;

    beforeAll(async () => {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'l3-profile','l3-profile','Before')",
        [ORG_P],
      );
      await admin.query(
        "INSERT INTO tenant_account (id, organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,'onboarding','l3-profile','b@x.test','p@x.test')",
        [T_P, ORG_P],
      );
      await admin.query(
        `INSERT INTO onboarding_task (organization_id, tenant_account_id, template_key, status)
         SELECT $1, $2, key, CASE WHEN key = 'go_live_checklist_complete' THEN 'pending' ELSE 'done' END::onboarding_task_status
           FROM onboarding_task_template WHERE retired_at IS NULL`,
        [ORG_P, T_P],
      );
      await admin.query(
        `INSERT INTO platform_tenant_baa_record (organization_id, tenant_account_id, addendum_version, baa_status, executed_on, effective_on, expires_on)
         VALUES ($1,$2,'v1','executed','2026-10-01','2026-10-01', (now() + interval '2 years')::date)`,
        [ORG_P, T_P],
      );
      adminP = await person(ORG_P, "admin-p", ["org_admin"]);
      officerP = await person(ORG_P, "officer-p", ["compliance_officer"]);
      await admin.query(
        "UPDATE tenant_account SET compliance_officer_membership_id=$2 WHERE id=$1",
        [T_P, officerP.membershipId],
      );
    }, 60_000);

    it("an edit that waits behind an activation re-reads the status under the lock and is refused, writing nothing", async () => {
      const holder = new Client({ connectionString: DB_URL });
      await holder.connect();
      try {
        await holder.query("BEGIN");
        // go-live approval's lock: EXCLUSIVE on the same key the onboarding-data writes and this edit take SHARED
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
          `tenant-onboarding:${ORG_P}`,
        ]);
        const racing = wizard(false)
          .setOrgProfile(adminP, ORG_P, { displayName: "Racing Edit" })
          .then(
            () => null,
            (e) => e as ChartWardenError,
          );
        await new Promise((resolve) => setTimeout(resolve, 400)); // it is now parked on the shared lock
        await holder.query("UPDATE tenant_account SET status='active' WHERE id=$1", [T_P]);
        await holder.query("COMMIT");
        const refused = await racing;
        expect(refused?.code).toBe("TENANT_NOT_ONBOARDING");
        expect(await displayName()).toBe("Before");
      } finally {
        await holder.end();
        await admin.query("UPDATE tenant_account SET status='onboarding' WHERE id=$1", [T_P]);
      }
    });

    it("an edit voids the pending attestation in the same transaction, as the real tenant and platform roles", async () => {
      await wizard(false).attestGoLive(officerP, ORG_P, "ready");
      await wizard(false).setOrgProfile(adminP, ORG_P, { displayName: "After Tenant Edit" });
      const row = (
        await admin.query(
          "SELECT status, revoke_reason, revoked_by_user_id FROM tenant_go_live_attestation WHERE tenant_account_id=$1 ORDER BY created_at DESC LIMIT 1",
          [T_P],
        )
      ).rows[0];
      expect(row).toMatchObject({
        status: "revoked",
        revoke_reason: "onboarding data changed after attestation",
        revoked_by_user_id: adminP.userId,
      });
      expect(await displayName()).toBe("After Tenant Edit");
      expect(await statusOf(T_P, "go_live_checklist_complete")).toBe("pending");

      await wizard(false).attestGoLive(officerP, ORG_P, "ready again");
      await wizard(false).setOrgProfilePlatform("l3-profile", OPS, {
        orgTimezone: "America/Chicago",
      });
      const second = (
        await admin.query(
          "SELECT status, revoked_by_user_id, revoked_by_membership_id FROM tenant_go_live_attestation WHERE tenant_account_id=$1 ORDER BY created_at DESC LIMIT 1",
          [T_P],
        )
      ).rows[0];
      expect(second).toMatchObject({
        status: "revoked",
        revoked_by_user_id: OPS_USER,
        revoked_by_membership_id: OPS_MEMBERSHIP,
      });
    });
  });

  describe("review fix M3: a go-live whose organization activation failed is recoverable", () => {
    const ORG_R = "ffffffff-ffff-4fff-8fff-ffffffffff01";
    const T_R = "ffffffff-ffff-4fff-8fff-ffffffffff02";
    const ORG_Q = "ffffffff-ffff-4fff-8fff-ffffffffff03";
    const T_Q = "ffffffff-ffff-4fff-8fff-ffffffffff04";
    let officerR: TenantActor;
    const orgStatus = async (org: string) =>
      (await admin.query("SELECT status FROM organization WHERE id=$1", [org])).rows[0]
        .status as string;
    const sweepDeps = () => ({ platformDb: platform.db, auditBypass: m34PlatformBypassAuditor });
    const activator = () =>
      createOrganizationActivator(app.db, createOnboardingTenantReader(app.db));

    beforeAll(async () => {
      registerPlatformJob("m34.platform_ops");
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'m3-recover','m3-recover','m3-recover'), ($2,'m1-baa-pick','m1-baa-pick','m1-baa-pick')",
        [ORG_R, ORG_Q],
      );
      for (const [org, tenant, slug] of [
        [ORG_R, T_R, "m3-recover"],
        [ORG_Q, T_Q, "m1-baa-pick"],
      ] as const) {
        await admin.query(
          "INSERT INTO tenant_account (id, organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,'onboarding',$3,'b@x.test','p@x.test')",
          [tenant, org, slug],
        );
        await admin.query(
          `INSERT INTO onboarding_task (organization_id, tenant_account_id, template_key, status)
           SELECT $1, $2, key, CASE WHEN key = 'go_live_checklist_complete' THEN 'pending' ELSE 'done' END::onboarding_task_status
             FROM onboarding_task_template WHERE retired_at IS NULL`,
          [org, tenant],
        );
        await admin.query(
          `INSERT INTO platform_tenant_baa_record (organization_id, tenant_account_id, addendum_version, baa_status, executed_on, effective_on, expires_on)
           VALUES ($1,$2,'v1','executed','2026-10-01','2026-10-01', (now() + interval '2 years')::date)`,
          [org, tenant],
        );
      }
      officerR = await person(ORG_R, "officer-r", ["compliance_officer"]);
      await admin.query(
        "UPDATE tenant_account SET compliance_officer_membership_id=$2 WHERE id=$1",
        [T_R, officerR.membershipId],
      );
    }, 60_000);

    it("a first approval whose organization activation fails leaves the tenant live and the organization `created`; repeating the approval opens it", async () => {
      await wizard(false).attestGoLive(officerR, ORG_R, "ready");
      const failing = wizard(false, {
        activateOrganization: async () => {
          throw new Error("organization update unavailable");
        },
      });
      const err = await refusal(
        failing.approveGoLive("m3-recover", OPS, "reviewed the evidence and the BAA"),
      );
      expect(err.code).toBe("ORGANIZATION_ACTIVATION_FAILED");
      expect(err.statusCode).toBe(503);
      expect(await tenantStatus(T_R)).toBe("active");
      expect(await orgStatus(ORG_R)).toBe("created");

      const repeat = wizard(false, {
        activateOrganization: async ({ organizationId, operator, reason }) => {
          await activator()(organizationId, {
            reason: `go-live approved: ${reason}`,
            actorUserId: operator.userId,
            actorMembershipId: operator.membershipId,
          });
        },
      });
      const view = await repeat.approveGoLive(
        "m3-recover",
        OPS,
        "completing the organization activation",
      );
      expect(view.goLive.state).toBe("live");
      expect(await orgStatus(ORG_R)).toBe("active");
      // the tenant was activated once and the attestation was approved once
      const approved = await admin.query(
        "SELECT count(*)::int AS n FROM tenant_go_live_attestation WHERE tenant_account_id=$1 AND status='approved'",
        [T_R],
      );
      expect(approved.rows[0].n).toBe(1);
    });

    it("the daily reconcile opens an organization still `created` whose tenant is active with an approved go-live, audited, and leaves live ones alone", async () => {
      await admin.query("UPDATE organization SET status='created' WHERE id=$1", [ORG_R]);
      const listed = await listPendingOrganizationActivations(sweepDeps());
      // Earlier suites in this file approved go-lives without opening their organizations: those are pending too.
      expect(listed.map((p) => p.organizationId)).toContain(ORG_R);
      expect(listed.find((p) => p.organizationId === ORG_R)).toMatchObject({
        tenantAccountId: T_R,
        approvedByUserId: OPS_USER,
      });

      const result = await runOrganizationActivationReconcile({
        listPending: () => listPendingOrganizationActivations(sweepDeps()),
        activate: async (input) => {
          await activator()(input.organizationId, {
            reason: input.reason,
            actorUserId: input.operatorUserId,
            actorMembershipId: input.operatorMembershipId,
          });
        },
        recordReconciled: (entry) => recordOrganizationActivationReconciled(sweepDeps(), entry),
      });
      expect(result).toEqual({ pending: listed.length, activated: listed.length, failed: 0 });
      expect(await orgStatus(ORG_R)).toBe("active");
      const audit = await admin.query(
        "SELECT context FROM audit_event WHERE event_type='m34.onboarding.organization_activation_reconciled' AND resource_id=$1",
        [T_R],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].context).toMatchObject({ organizationId: ORG_R, actor: "system" });
      // nothing left to do on the next tick
      expect(await listPendingOrganizationActivations(sweepDeps())).toEqual([]);
    });

    it("review fix M1: an undated pending renewal does not hide the executed BAA from the advance sweep", async () => {
      // `ORDER BY executed_on DESC` puts the undated pending row FIRST in Postgres; the sweep used rows[0] and read it as
      // "not executed", so the BAA step stuck. The governing BAA is the newest DATED one.
      await admin.query(
        `INSERT INTO platform_tenant_baa_record (organization_id, tenant_account_id, addendum_version, baa_status)
         VALUES ($1,$2,'v2','pending')`,
        [ORG_Q, T_Q],
      );
      await admin.query(
        "UPDATE onboarding_task SET status='pending' WHERE tenant_account_id=$1 AND template_key IN ('baa_executed','provisioning_complete')",
        [T_Q],
      );
      await advancer()({ tenantAccountId: T_Q, orgId: ORG_Q });
      expect(await statusOf(T_Q, "baa_executed")).toBe("done");
    });
  });

  describe("smoke-test gaps: a new tenant's first admin during onboarding (organization still `created`)", () => {
    const ORG_G = "dddddddd-dddd-4ddd-8ddd-dddddddddd01";
    const T_G = "dddddddd-dddd-4ddd-8ddd-dddddddddd02";
    const ORG_X = "dddddddd-dddd-4ddd-8ddd-dddddddddd03"; // a created organization nobody provisioned: no tenant account
    const ORG_Y = "dddddddd-dddd-4ddd-8ddd-dddddddddd04"; // created, but its tenant is suspended
    const T_Y = "dddddddd-dddd-4ddd-8ddd-dddddddddd05";
    let adminG: TenantActor;
    let officerG: TenantActor;
    const orgStatus = async (org: string) =>
      (await admin.query("SELECT status FROM organization WHERE id=$1", [org])).rows[0]
        .status as string;

    const stage = createOrganizationStageReader(() =>
      createOrganizationStatusReader(app.db)(ORG_G),
    );
    const readerFor = (org: string) =>
      createOrganizationStageReader(() => createOrganizationStatusReader(app.db)(org));

    /** The real authenticate hook, a stub session, the REAL organization-status reader on the real tenant role. */
    const hookFor = (org: string, reader: ReturnType<typeof readerFor>, user: TenantActor) => {
      const actor: ResolvedActor = {
        userId: user.userId,
        membershipId: user.membershipId,
        organizationId: org,
        roles: [...user.roles],
        providerEntityIds: [],
        locationIds: [],
        sessionClass: "staff",
        portalAccountId: null,
        sessionPatientId: null,
        deviceAttestation: null,
        externalActorId: null,
      };
      return createSessionAuthenticate({
        getSnapshot: async () => ({
          sessionId: "s-1",
          userId: user.userId,
          activeOrganizationId: org,
        }),
        getResolver: () => ({
          resolveActor: async () => actor,
          resolveStepUpState: async () => null,
          resolveStepUpPolicy: async () => ({
            qualifyingFactors: STEP_UP_POLICY.qualifyingFactors,
            maxAgeSec: STEP_UP_POLICY.defaultMaxAgeSec,
          }),
        }),
        organizationStage: reader,
      });
    };
    const req = (method: string, url: string, template?: string) =>
      ({
        method,
        url,
        // Fastify sets the matched route template before the onRequest hooks run; the gate decides on it.
        routeOptions: { url: template ?? url.split("?")[0] },
        headers: {},
        context: {
          userId: "",
          organizationId: "",
          roles: [],
          providerEntityIds: [],
          locationIds: [],
          attributes: {},
        },
      }) as unknown as FastifyRequest;

    beforeAll(async () => {
      // G: a tenant ready to go live (every gating step done, a long BAA, an assigned officer) whose organization is `created`.
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wiz-g','wiz-g','wiz-g')",
        [ORG_G],
      );
      await admin.query(
        "INSERT INTO tenant_account (id, organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,'onboarding','wiz-g','b@x.test','p@x.test')",
        [T_G, ORG_G],
      );
      await admin.query(
        `INSERT INTO onboarding_task (organization_id, tenant_account_id, template_key, status)
         SELECT $1, $2, key, CASE WHEN key = 'go_live_checklist_complete' THEN 'pending' ELSE 'done' END::onboarding_task_status
           FROM onboarding_task_template WHERE retired_at IS NULL`,
        [ORG_G, T_G],
      );
      await admin.query(
        `INSERT INTO platform_tenant_baa_record (organization_id, tenant_account_id, addendum_version, baa_status, executed_on, effective_on, expires_on)
         VALUES ($1,$2,'v1','executed','2026-10-01','2026-10-01', (now() + interval '2 years')::date)`,
        [ORG_G, T_G],
      );
      adminG = await person(ORG_G, "admin-g", ["org_admin"]);
      officerG = await person(ORG_G, "officer-g", ["compliance_officer"]);
      await admin.query(
        "UPDATE tenant_account SET compliance_officer_membership_id=$2 WHERE id=$1",
        [T_G, officerG.membershipId],
      );
      // X and Y: created organizations that must NOT be admitted.
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wiz-x','wiz-x','wiz-x'), ($2,'wiz-y','wiz-y','wiz-y')",
        [ORG_X, ORG_Y],
      );
      await admin.query(
        "INSERT INTO tenant_account (id, organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,'suspended','wiz-y','b@x.test','p@x.test')",
        [T_Y, ORG_Y],
      );
    }, 60_000);

    it("the onboarding-tenant fact, read as the tenant role, is true only for a provisioning or onboarding tenant of that organization", async () => {
      const reader = createOnboardingTenantReader(app.db);
      expect(await reader.isOnboarding(ORG_G)).toBe(true);
      expect(await reader.isOnboarding(ORG_X)).toBe(false); // no tenant account
      expect(await reader.isOnboarding(ORG_Y)).toBe(false); // suspended tenant
      expect(await reader.isOnboarding("00000000-0000-4000-8000-000000000000")).toBe(false);
      await admin.query("UPDATE tenant_account SET status='provisioning' WHERE id=$1", [T_G]);
      try {
        expect(await reader.isOnboarding(ORG_G)).toBe(true);
      } finally {
        await admin.query("UPDATE tenant_account SET status='onboarding' WHERE id=$1", [T_G]);
      }
    });

    it("while the organization is created, the admin's session reaches the onboarding routes and is refused every clinical route", async () => {
      expect(await orgStatus(ORG_G)).toBe("created");
      const hook = hookFor(ORG_G, stage, adminG);
      for (const [method, url] of [
        ["GET", "/api/v1/tenant/onboarding"],
        ["POST", "/api/v1/tenant/go-live/attest"],
        ["GET", "/api/v1/me/permissions"],
      ] as const) {
        await expect(hook(req(method, url)), `${method} ${url}`).resolves.toBeUndefined();
      }
      for (const [method, url] of [
        ["GET", "/api/v1/patients"],
        ["POST", "/api/v1/patients"],
        ["GET", "/api/v1/admissions"],
      ] as const) {
        await expect(hook(req(method, url)), `${method} ${url}`).rejects.toMatchObject({
          code: "ORGANIZATION_ONBOARDING",
          statusCode: 403,
        });
      }
    });

    it("go-live approval activates the organization on the real roles: audited as the operator, the gate lifts at once", async () => {
      const attested = await wizard(false).attestGoLive(officerG, ORG_G, "all checks reviewed");
      expect(attested.goLive.state).toBe("awaiting_approval");
      expect(await orgStatus(ORG_G)).toBe("created"); // an attestation opens nothing

      const activateOrg = createOrganizationActivator(
        app.db,
        createOnboardingTenantReader(app.db),
        undefined,
        (org) => stage.invalidate(org),
      );
      const live = await wizard(false, {
        activateOrganization: async ({ organizationId, operator, reason }) => {
          await activateOrg(organizationId, {
            reason: `go-live approved: ${reason}`,
            actorUserId: operator.userId,
            actorMembershipId: operator.membershipId,
          });
        },
      }).approveGoLive("wiz-g", OPS, "reviewed the evidence and the BAA");

      expect(live.goLive.state).toBe("live");
      expect(await tenantStatus(T_G)).toBe("active");
      expect(await orgStatus(ORG_G)).toBe("active");
      const audit = await admin.query(
        `SELECT actor_user_id, before, after, context FROM audit_event
          WHERE event_type='m2.organization.activated' AND organization_id=$1`,
        [ORG_G],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].actor_user_id).toBe(OPS_USER);
      expect(JSON.stringify(audit.rows[0])).toContain(
        "go-live approved: reviewed the evidence and the BAA",
      );

      // The same session, no new sign-in: the clinical routes are open now.
      expect(await stage.isConfined(ORG_G)).toBe(false);
      await expect(
        hookFor(ORG_G, stage, adminG)(req("GET", "/api/v1/patients")),
      ).resolves.toBeUndefined();
    });

    it("security L1: a real `suspended` organization is confined to the allowlist too (the gate used to fail open for it)", async () => {
      const ORG_SUSP = "dddddddd-dddd-4ddd-8ddd-dddddddddd09";
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'wiz-susp','wiz-susp','wiz-susp','suspended')",
        [ORG_SUSP],
      );
      const hook = hookFor(ORG_SUSP, readerFor(ORG_SUSP), adminG);
      await expect(hook(req("GET", "/api/v1/patients"))).rejects.toMatchObject({
        code: "ORGANIZATION_ONBOARDING",
      });
      await expect(
        hook(req("GET", "/api/v1/tenant/dsar-export-jobs", "/api/v1/tenant/dsar-export-jobs")),
      ).rejects.toMatchObject({ code: "ORGANIZATION_ONBOARDING" });
      await expect(hook(req("GET", "/api/v1/tenant/onboarding"))).resolves.toBeUndefined();
    });

    it("an organization with no onboarding tenant is not admitted by the fact, and the gate reads its real status", async () => {
      // Nothing about X or Y becomes pre-activation-allowed: the select-organization fact is false for both (above), so no
      // session can be bound to them; the gate still treats a `created` organization as pre-activation if one ever were.
      const hook = hookFor(ORG_X, readerFor(ORG_X), adminG);
      await expect(hook(req("GET", "/api/v1/patients"))).rejects.toMatchObject({
        code: "ORGANIZATION_ONBOARDING",
      });
    });
  });
});
