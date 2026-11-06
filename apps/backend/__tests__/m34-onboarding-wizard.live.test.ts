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
import { ChartWardenError } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDrizzleOrgProfilePort } from "../src/bootstrap/org-profile";
import {
  buildOrgAdminCountReader,
  buildOrgSeedFactsReader,
} from "../src/bootstrap/org-spine-facts";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { m34PlatformBypassAuditor } from "../src/index";
import {
  buildDrizzleOrgMacJurisdictionReader,
  buildMacFeedConfiguredReader,
} from "../src/modules/23-billing-medicare/jobs/mac-jurisdictions";
import { M34_OUTBOX_EVENTS } from "../src/modules/34-saas-tenant-platform/events-by-m34";
import { createOnboardingAdvancer } from "../src/modules/34-saas-tenant-platform/jobs/platform-sweeps-worker";
import type {
  PlatformActor,
  TenantActor,
} from "../src/modules/34-saas-tenant-platform/onboarding/model";
import { createOnboardingWizard } from "../src/modules/34-saas-tenant-platform/onboarding/wizard-service";
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
  const wizard = (withAdvance = true) =>
    createOnboardingWizard({
      runner: createDrizzleWizardRunner({
        db: app.db,
        platformDb: platform.db,
        auditBypass: m34PlatformBypassAuditor,
        platformJobId: JOB_ID,
        activation: backend().activateApprovedTenant,
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
      await tenantClient.query("BEGIN");
      await tenantClient.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      await expect(
        tenantClient.query("UPDATE tenant_go_live_attestation SET status='approved'"),
      ).rejects.toThrow(/permission denied/);
      await tenantClient.query("ROLLBACK");
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

    beforeAll(async () => {
      for (const [org, tenant, slug] of [
        [ORG_S, T_S, "wiz-s"],
        [ORG_S2, T_S2, "wiz-s2"],
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
      const can = async (priv: string, column?: string) =>
        (
          await admin.query(
            column
              ? "SELECT has_column_privilege('chartwarden_platform','platform_tenant_baa_record',$1,'UPDATE') AS ok"
              : "SELECT has_table_privilege('chartwarden_platform','platform_tenant_baa_record',$1) AS ok",
            [column ?? priv],
          )
        ).rows[0].ok as boolean;
      await admin.query(
        "REVOKE INSERT, UPDATE ON platform_tenant_baa_record FROM chartwarden_platform",
      );
      expect(await can("INSERT")).toBe(false);
      expect(await can("UPDATE", "baa_status")).toBe(false);

      await apply(sqlFiles().filter((f) => f.startsWith("1332_")));

      expect(await can("INSERT")).toBe(true);
      for (const column of [
        "baa_status",
        "executed_on",
        "effective_on",
        "expires_on",
        "breach_notification_contact_email",
        "breach_notification_contact_phone",
        "document_id",
      ]) {
        expect(await can("UPDATE", column), column).toBe(true);
      }
      for (const column of ["attested_at", "organization_id", "tenant_account_id"]) {
        expect(await can("UPDATE", column), column).toBe(false);
      }
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
});
