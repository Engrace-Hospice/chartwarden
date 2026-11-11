/**
 * M23 — each tenant's own clearinghouse (ADR-0053 amendment 2026-11-06), LIVE Postgres on the real roles.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m23:tenant-clearinghouse:live   (SUPERUSER url, THROWAWAY database)
 *
 * The tenant surface runs as the NOBYPASSRLS `chartwarden_app` (a superuser connection would make every cross-tenant
 * assertion vacuous); the slug lookup of the platform surface runs on the BYPASSRLS `chartwarden_platform_login` built by
 * `scripts/db/provision-runtime-roles.ts` itself. Vendor calls are mocks (no network, obvious fake credentials). Proves:
 *   - a tenant chooses, verifies and activates its own clearinghouse; the credential is sealed, never returned, never in the
 *     table in the clear, never in an audit row (the trigger scrubs it);
 *   - RLS: a tenant reads and writes only its own row; it cannot delete, cannot rewrite another org's, and an insert for
 *     another org is refused;
 *   - per-org transport resolution against the real table picks each org's OWN vendor and mode, and nothing for `outside`, a
 *     draft, or an org with no row (the env fallback serves only the org an operator named);
 *   - the claims-billing gate allows / refuses per choice (enforce), through the real seams;
 *   - a platform operator sets the same config on the tenant's behalf only while it is onboarding (409 after), with an audit
 *     row naming operator + org + reason, and wizard step 7 settles through the real advance pass;
 *   - vendor and mode lock once a production submission exists (except while the BAA is revoked: see the revoke cases below); a
 *     credential rotation drops a live config back to draft (D6);
 *   - the tenant-held vendor BAA: the tenant records it, a platform operator verifies it (a live tenant too), and the table's
 *     CHECK and the activation both refuse `active` without it (D2); the sealed credential's audit trigger says THAT it changed;
 *   - a platform operator revokes a tenant's vendor BAA (migration 1468): the new CHECKs and the guard trigger hold under the real
 *     app role, the revoke (and its outbox announcement) rolls back with a failing audit insert, the revoked config resolves unbound
 *     and the worker pre-flight holds its jobs, the tenant's view never carries the ticket, no free text can be stored, the vendor
 *     lock is set aside for the TENANT lane only and not beyond the vendor it left (against the real attempt table), and the revoke
 *     works whatever the state of the credential;
 *   - the org-level `billing.clearinghouse.*` keys: a holder of only the provider-entity-scoped MAC keys is refused (D3);
 *   - the tenant routes write a field-level audit row (names, never values); a switch is refused while claims are queued;
 *   - a suspended subscription still refuses new claims work through the real seams (D1); a claim job for a draft config is held.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { auditPlatformEvent } from "@chartwarden/audit";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { type DbClient, createDbClient } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import {
  getRequestContext,
  registerPlatformJob,
  withOrgContext,
  withPlatformContext,
} from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import { InMemoryAttemptStore } from "@chartwarden/x12-837-client";
import { createInMemoryHarness } from "@chartwarden/x12-837-client/testing";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimsBillingVerdict,
  configureClaimsBillingGate,
} from "../src/bootstrap/claims-billing-gate";
import { buildServer } from "../src/bootstrap/index";
import type { OnboardingClearinghousePort } from "../src/bootstrap/onboarding-clearinghouse-port";
import {
  buildOrgAdminCountReader,
  buildOrgSeedFactsReader,
} from "../src/bootstrap/org-spine-facts";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { getSeam, registerSeam } from "../src/bootstrap/seams/registry";
import { m34PlatformBypassAuditor } from "../src/index";
import { buildClearinghouseAuditPort } from "../src/m23-clearinghouse-audit";
import {
  M23_OUTBOX_EVENTS,
  buildDrizzleM23WriteService,
} from "../src/modules/23-billing-medicare/index";
import { __resetClearinghouseAlertMemoryForTest } from "../src/modules/23-billing-medicare/jobs/clearinghouse-unbound-hold";
import { holdBeforeRun } from "../src/modules/23-billing-medicare/jobs/m23-jobs";
import {
  buildDrizzleOrgMacJurisdictionReader,
  buildMacFeedConfiguredReader,
} from "../src/modules/23-billing-medicare/jobs/mac-jurisdictions";
import { M23_QUEUES } from "../src/modules/23-billing-medicare/jobs/queues";
import { buildExternalNoticeOnboardingPort } from "../src/modules/23-billing-medicare/services/external-notice-onboarding-port";
import { priorElectionClosureForOrg } from "../src/modules/23-billing-medicare/services/prior-election-closure";
import {
  M23_PLATFORM_CREDENTIAL_CHECK_JOB_ID,
  checkHeldCredentials,
  createDrizzleConfigStore,
} from "../src/modules/23-billing-medicare/tenant-clearinghouse/config-store";
import { unknownFingerprintKeyIds } from "../src/modules/23-billing-medicare/tenant-clearinghouse/fingerprint-key-check";
import { buildTenantClearinghouseOnboardingPort } from "../src/modules/23-billing-medicare/tenant-clearinghouse/onboarding-port";
import { registerM23TenantClearinghouseSeams } from "../src/modules/23-billing-medicare/tenant-clearinghouse/register";
import { createTenantClearinghouseRuntime } from "../src/modules/23-billing-medicare/tenant-clearinghouse/resolver";
import { reportRevokedResponsesPending } from "../src/modules/23-billing-medicare/tenant-clearinghouse/revoked-responses-alert";
import { registerTenantClearinghouseRoutes } from "../src/modules/23-billing-medicare/tenant-clearinghouse/routes";
import {
  buildClearinghouseSecretCipher,
  deriveFingerprintSubkey,
} from "../src/modules/23-billing-medicare/tenant-clearinghouse/secret-cipher";
import { createTenantClearinghouseService } from "../src/modules/23-billing-medicare/tenant-clearinghouse/service";
import { buildDrizzleTenantClearinghouseRouteService } from "../src/modules/23-billing-medicare/tenant-clearinghouse/tenant-service";
import {
  countQueuedClaims,
  countQueuedClaimsOn,
} from "../src/modules/23-billing-medicare/tenant-clearinghouse/waiting-work";
import { M34_OUTBOX_EVENTS } from "../src/modules/34-saas-tenant-platform/events-by-m34";
import {
  buildDrizzleOnboardingDataService,
  buildPlatformTenantResolver,
  mountTenantPlatformRoutes,
} from "../src/modules/34-saas-tenant-platform/index";
import { createOnboardingAdvancer } from "../src/modules/34-saas-tenant-platform/jobs/platform-sweeps-worker";
import { buildPricingOnboardingPort } from "../src/modules/34-saas-tenant-platform/onboarding/pricing-port";
import { createSettleOnboardingForOrg } from "../src/modules/34-saas-tenant-platform/onboarding/settle-for-org";
import { createDrizzleSubscriptionWorkBlockReader } from "../src/modules/35-subscription/addon/entitlement";
import { reconcileThenStatement } from "../src/modules/35-subscription/billing-runtime/workers";
import { M35_OUTBOX_EVENTS } from "../src/modules/35-subscription/events-by-m35";
import {
  type ContractService,
  buildContractService,
  orgHasContract,
} from "../src/modules/35-subscription/pricing/contract-service";
import { SYSTEM_TRIGGER, modeTriggerOf } from "../src/modules/35-subscription/pricing/mode-trigger";
import { buildOnboardingBillingModePort } from "../src/modules/35-subscription/pricing/onboarding-billing-mode-port";
import { createOutsideModeReconciler } from "../src/modules/35-subscription/pricing/outside-reconcile";
import {
  type PricingPlanService,
  buildPricingPlanService,
} from "../src/modules/35-subscription/pricing/plan-service";
import { buildPlatformAuditPort } from "../src/modules/35-subscription/pricing/ports";
import {
  countQueuedCommercialSubmissions,
  countQueuedCommercialSubmissionsOn,
} from "../src/modules/41-billing-commercial/index";
import { modeInForce } from "./_billing-mode";
import {
  appRoleConnectionString,
  appRoleUrl,
  dropLiveRoles,
  resetPublicSchema,
} from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const PLATFORM_PASSWORD = "platform-live-password-clearinghouse";
const JOB_ID = "m23-tenant-clearinghouse-live-test";

const PLATFORM_ORG = "a0000000-0000-4000-8000-0000000000a0";
const ORG_A = "a1000000-0000-4000-8000-0000000000a1"; // an ACTIVE tenant: claimmd, chosen through its own routes
const ORG_B = "b2000000-0000-4000-8000-0000000000b2"; // onboarding: set by the platform operator
const ORG_C = "c3000000-0000-4000-8000-0000000000c3"; // outside
const ORG_D = "d4000000-0000-4000-8000-0000000000d4"; // chose nothing
const ORG_E = "e5000000-0000-4000-8000-0000000000e5"; // named in the env fallback list, no row
const ORG_F = "f6000000-0000-4000-8000-0000000000f6"; // onboarding: chooses outside through the platform route
const ORG_G = "a7000000-0000-4000-8000-0000000000a7"; // stedi, active
const ORG_H = "a8000000-0000-4000-8000-0000000000a8"; // only the operator's list of external filings reads it (nothing else seeds here)
const ORG_I = "a9000000-0000-4000-8000-0000000000a9"; // a live tenant with a signed contract: its own outside choice sets billing mode none
const ORG_J = "aa000000-0000-4000-8000-0000000000aa"; // onboarding with a signed contract: an operator moves it out of outside
const ORG_K = "ab000000-0000-4000-8000-0000000000ab"; // live, no contract: its own switch out of outside is allowed
const ORG_L = "ac000000-0000-4000-8000-0000000000ac"; // outside with a mode that is not none: the hourly sweep's backstop applies the rule
const ORG_N = "ad000000-0000-4000-8000-0000000000ad"; // outside with a PAUSED contract: the tenant's own switch is still refused, the operator's names the mode
const ORG_O = "ae000000-0000-4000-8000-0000000000ae"; // the race: the system sets none between the operator's mode write and the vendor commit
const ORG_P = "af000000-0000-4000-8000-0000000000af"; // two mode writers at once (the subscription row is the lock)
const ORG_Q = "b0000000-0000-4000-8000-0000000000b0"; // tries to seal org A's Claim.MD account (migration 1434)
const ORG_R = "b3000000-0000-4000-8000-0000000000b3"; // races ORG_S to seal one new key (migration 1435's index serialises them)
const ORG_S = "b4000000-0000-4000-8000-0000000000b4";
/** BAA revoke (migration 1468): one live Claim.MD tenant per case, each a tenant_account `active` (a live tenant is the point). */
const REV_ORG_K = "c7100000-0000-4000-8000-000000000071"; // revoked while a production attempt is in flight; leaves for `outside`
const REV_ORG_L = "c7200000-0000-4000-8000-000000000072"; // never revoked: the control, and the cross-tenant bystander
const REV_ORG_M = "c7300000-0000-4000-8000-000000000073"; // revoked, a production attempt sent yesterday; leaves for Stedi
const REV_ORG_N = "c7400000-0000-4000-8000-000000000074"; // revoked, then records a new BAA: the lock is back
const REV_ORG_O = "c7500000-0000-4000-8000-000000000075"; // revoked; A -> B -> C and A -> B -> outside (the exception is not one-shot)
const REV_ORG_P = "c7600000-0000-4000-8000-000000000076"; // sealed before migration 1434 (a credential, no fingerprint): the revoke needs no KEK
const REV_ORG_Q = "c7700000-0000-4000-8000-000000000077"; // its credential is held by another organization: the revoke needs no reservation
const REVOKE_ORGS = [
  [REV_ORG_K, "rev-k"],
  [REV_ORG_L, "rev-l"],
  [REV_ORG_M, "rev-m"],
  [REV_ORG_N, "rev-n"],
  [REV_ORG_O, "rev-o"],
  [REV_ORG_P, "rev-p"],
  [REV_ORG_Q, "rev-q"],
] as const;
/**
 * The vendor / mode lock window against the real query (`hasRecentProductionAttempts`): one organization per case, each with ONE
 * attempt row and a draft Claim.MD config that tries to switch to Stedi. The lock holds while a production attempt is `reserved` (any
 * age: it is in flight) or `sent` within CLEARINGHOUSE_RELEASE_QUIET_DAYS (90); nothing else locks.
 */
const LOCK_WINDOW_CASES = [
  {
    org: "b1000000-0000-4000-8000-0000000000b1",
    usage: "production",
    status: "sent",
    daysAgo: 89,
    locked: true,
  },
  {
    org: "b2000000-0000-4000-8000-0000000000c2",
    usage: "production",
    status: "sent",
    daysAgo: 91,
    locked: false,
  },
  {
    org: "b3000000-0000-4000-8000-0000000000c3",
    usage: "production",
    status: "reserved",
    daysAgo: 120,
    locked: true,
  },
  {
    org: "b4000000-0000-4000-8000-0000000000c4",
    usage: "test",
    status: "sent",
    daysAgo: 1,
    locked: false,
  },
  {
    org: "b5000000-0000-4000-8000-0000000000c5",
    usage: "production",
    status: "released",
    daysAgo: 1,
    locked: false,
  },
  {
    org: "b6000000-0000-4000-8000-0000000000c6",
    usage: "production",
    status: "voided",
    daysAgo: 1,
    locked: false,
  },
] as const;
const OPERATOR = "c9000000-0000-4000-8000-0000000000c9";
const MEMBERSHIP = "e9000000-0000-4000-8000-0000000000e9";
const TENANT_ADMIN = "7a000000-0000-4000-8000-0000000000a7";
const ENTITY_MANAGER = "7b000000-0000-4000-8000-0000000000b7"; // a billing manager scoped to ONE provider entity (MAC keys only)
const REASON = "Customer asked support to set up their clearinghouse, ticket CHG-5001";
const BAA = {
  heldBy: "tenant",
  effectiveDate: "2026-01-15",
  documentRef: "Claim.MD BAA, signed 2026-01-15, contract folder 7",
} as const;

const KEY_A = "fake-claimmd-key-A#live-1";
const KEY_A2 = "fake-claimmd-key-A#live-2-rotated";
const KEY_B = "fake-claimmd-key-B#live-1";
const KEY_G = "fake-stedi-key-G-live-1";
const KEY_BAD = "fake-bad-key-live-1";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId = MEMBERSHIP;
  if (request.headers["x-step-up"] === "fresh") request.context.attributes.stepUpRecent = true;
}

describe.skipIf(!DB_URL)("M23 tenant clearinghouse, LIVE Postgres on the real roles", () => {
  let admin: Client;
  let tenantPool: ReturnType<typeof createDbClient>;
  let platformPool: ReturnType<typeof createDbClient>;
  let server: FastifyInstance;
  let plans: PricingPlanService;
  /** The `updatedAt` pin a write on an existing version carries (what an operator read). */
  const pinOf = async (id: string): Promise<string> => (await plans.get(id)).updatedAt;
  let contracts: ContractService;
  /** The real clearinghouse adapter (over the real service), for a data service a story wraps with its own fault or race. */
  let realPort: OnboardingClearinghousePort;
  let realSettle: ReturnType<typeof createSettleOnboardingForOrg>;
  let seq = 0;
  const probed: { secret: string; mode: string }[] = [];
  const cipher = buildClearinghouseSecretCipher(Buffer.alloc(32, 11));

  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await admin.query(text, params)).rows as T[];
  const errorCode = (res: { json: () => Record<string, unknown> }): unknown => {
    const body = res.json();
    return (body.error as { code?: string } | undefined)?.code ?? body.code;
  };
  const OPS = {
    "x-test-user": OPERATOR,
    "x-test-org": PLATFORM_ORG,
    "x-test-roles": "platform_ops",
  };
  const opsWrite = () => ({ ...OPS, "x-step-up": "fresh", "idempotency-key": `live-${++seq}` });
  const tenantRead = (org: string) => ({
    "x-test-user": TENANT_ADMIN,
    "x-test-org": org,
    "x-test-roles": "org_admin",
  });
  const tenantWrite = (org: string) => ({
    ...tenantRead(org),
    "x-step-up": "fresh",
    "idempotency-key": `live-${++seq}`,
  });
  const tenantCall = (
    method: "GET" | "PUT" | "POST",
    org: string,
    path: string,
    payload?: object,
    extra: Record<string, string> = {},
  ) =>
    server.inject({
      method,
      url: `/api/v1/tenant/clearinghouse${path}`,
      headers: { ...(method === "GET" ? tenantRead(org) : tenantWrite(org)), ...extra },
      ...(payload ? { payload } : {}),
    });
  const platformCall = (
    method: "GET" | "PUT" | "POST",
    slug: string,
    path: string,
    payload?: object,
    extra: Record<string, string> = {},
  ) =>
    server.inject({
      method,
      url: `/api/v1/platform/tenants/${slug}/clearinghouse${path}`,
      headers: { ...(method === "GET" ? OPS : opsWrite()), ...extra },
      ...(payload ? { payload } : {}),
    });

  /** One query on the REAL `chartwarden_app` role, scoped to `org` exactly as a tenant request is. */
  const asTenant = async <T>(org: string, sql: string): Promise<T[]> => {
    const client = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.org_id', $1, true)", [org]);
      const { rows } = await client.query(sql);
      await client.query("ROLLBACK");
      return rows as T[];
    } finally {
      await client.end();
    }
  };
  const step7 = (org: string) =>
    q<{ status: string }>(
      "SELECT status FROM onboarding_task WHERE organization_id=$1 AND template_key='clearinghouse_selected'",
      [org],
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
      [ORG_A, "ch-a"],
      [ORG_B, "ch-b"],
      [ORG_C, "ch-c"],
      [ORG_D, "ch-d"],
      [ORG_E, "ch-e"],
      [ORG_F, "ch-f"],
      [ORG_G, "ch-g"],
      [ORG_H, "ch-h"],
      [ORG_I, "ch-i"],
      [ORG_J, "ch-j"],
      [ORG_K, "ch-k"],
      [ORG_L, "ch-l"],
      [ORG_N, "ch-n"],
      [ORG_O, "ch-o"],
      [ORG_P, "ch-p"],
      [ORG_Q, "ch-q"],
      [ORG_R, "ch-r"],
      [ORG_S, "ch-s"],
      ...REVOKE_ORGS,
      ...LOCK_WINDOW_CASES.map((c, i) => [c.org, `ch-lock-${i}`] as const),
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    }
    // The row-audit trigger writes app.user_id to audit_event.actor_user_id (a foreign key to user): both actors are real users.
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'ops-clearinghouse@test.test')`, [
      OPERATOR,
    ]);
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'admin-clearinghouse@test.test')`, [
      TENANT_ADMIN,
    ]);
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'entity-clearinghouse@test.test')`,
      [ENTITY_MANAGER],
    );
    for (const [org, status] of [
      [ORG_A, "active"],
      [ORG_B, "onboarding"],
      [ORG_F, "onboarding"],
      [ORG_H, "active"],
      [ORG_I, "onboarding"],
      [ORG_J, "onboarding"],
      [ORG_K, "active"],
      [ORG_L, "onboarding"],
      [ORG_N, "onboarding"],
      [ORG_O, "onboarding"],
      [ORG_P, "onboarding"],
      [ORG_Q, "active"], // the platform release of its earlier credentials (migration 1435) resolves its tenant account
      ...REVOKE_ORGS.map(([org]) => [org, "active"] as const), // the BAA revoke is not onboarding-gated
    ] as const) {
      await admin.query(
        "INSERT INTO tenant_account (organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,$3,'b@x.test','p@x.test')",
        [org, status, `Tenant ${status}`],
      );
    }
    // Wizard tasks for the two onboarding tenants; steps 1-6 are done so step 7 (clearinghouse_selected) is the one in play.
    for (const org of [ORG_B, ORG_F, ORG_J, ORG_L, ORG_N, ORG_O, ORG_P]) {
      await admin.query(
        `INSERT INTO onboarding_task (organization_id, tenant_account_id, template_key)
         SELECT $1, (SELECT id FROM tenant_account WHERE organization_id=$1), key FROM onboarding_task_template WHERE retired_at IS NULL`,
        [org],
      );
      await admin.query(
        "UPDATE onboarding_task SET status='done' WHERE organization_id=$1 AND template_key = ANY($2)",
        [
          org,
          [
            "account_created",
            "plan_contract",
            "baa_executed",
            "provisioning_complete",
            "ccn_registered",
            "locations_seeded",
          ],
        ],
      );
    }

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

    // The seams the gate and the wizard read, over the real tenant pool; the env fallback names ORG_E only. The gate also asks
    // M35 whether the subscription is suspended / paused / canceled (owner decision D1): the real reader.
    registerSeam(
      "SubscriptionWorkBlockReader",
      createDrizzleSubscriptionWorkBlockReader(tenantPool.db),
    );
    registerM23TenantClearinghouseSeams({
      db: tenantPool.db,
      env: { CLEARINGHOUSE_VENDOR: "in_memory", CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS: ORG_E },
    });
    configureClaimsBillingGate({ mode: "enforce", log: () => {} });

    // The real advance pass, with the clearinghouse fact read through the real seam.
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M34_OUTBOX_EVENTS]));
    const alerts: AlertEmitter = {
      async emit() {
        return { alertId: "a", resolvedRecipientCount: 0 };
      },
    };
    const advance = createOnboardingAdvancer({
      db: tenantPool.db,
      outbox: {
        publish: (tx, input) => publisher.publish(tx, { ...input, callerModule: "m34" } as never),
      },
      alerts,
      facts: {
        orgSeed: buildOrgSeedFactsReader(tenantPool.db),
        orgAdminCount: buildOrgAdminCountReader(tenantPool.db),
        macFeedConfigured: buildMacFeedConfiguredReader(
          buildDrizzleOrgMacJurisdictionReader(tenantPool.db),
        ),
        clearinghouseSettled: async (orgId) => {
          const choice = await getSeam("TenantClearinghouseReader").choiceForOrg(orgId);
          return choice.vendor !== null && choice.status === "active";
        },
      },
    });
    // Slice 5: the REAL pricing contract service on the real platform credential, run the way the composition root runs it (an audited
    // `withPlatformContext` per platform transaction). The wizard is a double: only the plan_contract step is read and attested.
    const m35Publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M35_OUTBOX_EVENTS]));
    const signedSlugs = new Set<string>();
    const wizardDouble = {
      getPlatform: async (slug: string) =>
        ({
          steps: [
            {
              key: "plan_contract",
              id: `task-${slug}`,
              status: signedSlugs.has(slug) ? "done" : "pending",
              lockedBy: null,
            },
          ],
        }) as never,
      attestPlatform: async (slug: string) => {
        signedSlugs.add(slug);
        return {} as never;
      },
    };
    const m35Runner = <T>(fn: (tx: DbClient) => Promise<T>): Promise<T> =>
      withPlatformContext(
        platformPool.db,
        { jobId: JOB_ID, reason: "attribution live suite", crossTenant: true },
        m34PlatformBypassAuditor,
        (tx) => fn(tx as unknown as DbClient),
      );
    const m35Audit = buildPlatformAuditPort((tx, row) => auditPlatformEvent(tx as never, row));
    plans = buildPricingPlanService({ platformRunner: m35Runner, audit: m35Audit });
    contracts = buildContractService({
      db: tenantPool.db,
      platformRunner: m35Runner,
      outbox: {
        publish: (tx, e) => m35Publisher.publish(tx as never, { ...e, callerModule: "m35" }),
      },
      audit: m35Audit,
      onboarding: buildPricingOnboardingPort({ wizard: wizardDouble as never }),
      // The same binding the composition root makes: the real choice, read when asked.
      billsOutside: async (organizationId) =>
        (await getSeam("TenantClearinghouseReader").choiceForOrg(organizationId)).vendor ===
        "outside",
    });
    const settleOnboarding = createSettleOnboardingForOrg({
      db: tenantPool.db,
      advance: async ({ tenantAccountId, organizationId }) => {
        await advance({ tenantAccountId, orgId: organizationId });
      },
      // A live tenant has nothing for the sweep, but a switch to outside still reaches its billing mode: the same two steps the
      // composition root takes (the wizard's sync reads the choice; the glue attributes the change to the ambient request's actor).
      afterChange: async (organizationId) => {
        const choice = await getSeam("TenantClearinghouseReader").choiceForOrg(organizationId);
        if (choice.vendor !== "outside") return;
        await contracts.setModeNoneForOutsideBilling(
          organizationId,
          modeTriggerOf(getRequestContext(), organizationId),
        );
      },
    });

    const m23Publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M23_OUTBOX_EVENTS]));
    const service = createTenantClearinghouseService({
      cipher,
      // A switch is refused while claims or commercial submissions are queued (the same real counters the composition root binds).
      waitingWork: async (organizationId, tx) => ({
        claims: tx
          ? await countQueuedClaimsOn(tx, organizationId)
          : await countQueuedClaims(tenantPool.db, organizationId),
        commercialSubmissions: tx
          ? await countQueuedCommercialSubmissionsOn(tx, organizationId)
          : await countQueuedCommercialSubmissions(tenantPool.db, organizationId),
      }),
      // The tenant's own switch out of outside is refused while a pricing contract exists (the real read, on the service's own tx).
      hasPricingContract: async (organizationId, tx) =>
        tx ? orgHasContract(tx, organizationId) : contracts.hasContract(organizationId),
      // The Claim.MD connection test is a mock: no network. It records what it was handed.
      probes: {
        claimmd: async (secret, mode) => {
          probed.push({ secret, mode });
          return secret.includes("bad") ? "credential_rejected" : "ok";
        },
      },
    });
    realPort = buildTenantClearinghouseOnboardingPort({ db: tenantPool.db, service });
    realSettle = settleOnboarding;
    const dataService = buildDrizzleOnboardingDataService({
      db: tenantPool.db,
      resolveTenant: buildPlatformTenantResolver({
        platformDb: platformPool.db,
        auditBypass: m34PlatformBypassAuditor,
        platformJobId: JOB_ID,
      }),
      clearinghouse: buildTenantClearinghouseOnboardingPort({
        db: tenantPool.db,
        service,
        // the REAL catalog-validating publisher (callerModule m23): the revoke's announcement is validated against the catalog and
        // committed with the revoke
        outbox: {
          publish: (tx, e) =>
            m23Publisher.publish(tx as never, { ...e, callerModule: "m23" } as never),
        },
      }),
      notices: buildExternalNoticeOnboardingPort(),
      billingMode: buildOnboardingBillingModePort(() => contracts),
      settleOnboarding,
    });

    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: PLATFORM_ORG,
          userId: OPERATOR,
          grants: [
            {
              roleKey: "platform_ops",
              enabled: true,
              expiresAt: null,
              permissionKeys: [
                "tenant_onboarding_data.read_platform",
                "tenant_clearinghouse.read_platform",
                "tenant_clearinghouse.write_platform",
                "tenant_clearinghouse.verify_baa_platform",
                "tenant_clearinghouse.revoke_baa_platform",
                "tenant_clearinghouse.release_credential_platform",
                "tenant_notice_filing.withdraw_platform",
                // naming a billing mode on the switch is also a pricing write
                "subscription.onboard_platform",
              ],
            },
          ],
        },
        ...[
          ORG_A,
          ORG_B,
          ORG_G,
          ORG_I,
          ORG_K,
          ORG_N,
          ORG_Q,
          ORG_R,
          ORG_S,
          ...REVOKE_ORGS.map(([org]) => org),
          ...LOCK_WINDOW_CASES.map((c) => c.org),
        ].map((orgId) => ({
          orgId,
          userId: TENANT_ADMIN,
          grants: [
            {
              roleKey: "org_admin",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["billing.clearinghouse.read", "billing.clearinghouse.admin"],
            },
          ],
        })),
        // D3: a billing manager scoped to one provider entity holds the entity-scoped MAC credential keys and NOT the org-level pair
        ...[ORG_A, ORG_B].map((orgId) => ({
          orgId,
          userId: ENTITY_MANAGER,
          grants: [
            {
              roleKey: "billing_manager",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["billing.mac_credential.read", "billing.mac_credential.admin"],
            },
          ],
        })),
        { orgId: ORG_D, userId: TENANT_ADMIN, grants: [] },
      ]).store,
    );
    const reg = createPredicateRegistry();
    reg.register("tenant_lifecycle_platform_ops", async (c) => c.roles.includes("platform_ops"));
    reg.register("step_up_recent", async (c) => c.attributes.stepUpRecent === true);
    registerAbacRegistry(reg);
    server = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    mountTenantPlatformRoutes(server, tenantPool.db, { onboardingData: { service: dataService } });
    registerTenantClearinghouseRoutes(server, {
      tenantClearinghouseService: buildDrizzleTenantClearinghouseRouteService({
        db: tenantPool.db,
        service,
        audit: buildClearinghouseAuditPort(),
        onChanged: settleOnboarding,
      }),
    });
  }, 300_000);

  afterAll(async () => {
    await server?.close();
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    configureClaimsBillingGate({ mode: "shadow" });
    await tenantPool?.close();
    await platformPool?.close();
    await admin?.end();
  });

  it("a tenant admin chooses Claim.MD: 201 draft, the credential sealed and never returned", async () => {
    expect((await tenantCall("GET", ORG_A, "")).json()).toMatchObject({
      vendor: null,
      source: "none",
    });
    const res = await tenantCall("PUT", ORG_A, "", {
      vendor: "claimmd",
      mode: "test",
      secret: KEY_A,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      vendor: "claimmd",
      mode: "test",
      status: "draft",
      hasSecret: true,
      source: "tenant",
    });
    expect(res.body).not.toContain(KEY_A);
    const [row] = await q<{ secret_cipher: string }>(
      "SELECT secret_cipher FROM tenant_clearinghouse_config WHERE organization_id=$1",
      [ORG_A],
    );
    expect(row?.secret_cipher).toBeTruthy();
    expect(row?.secret_cipher).not.toContain(KEY_A);
    expect((await tenantCall("GET", ORG_A, "")).body).not.toContain(KEY_A);
  });

  // Migration 1434 (owner decision 2026-11-08): one vendor account belongs to ONE organization. Org Q (nothing chosen) saving org
  // A's Claim.MD key is refused by the cross-org unique index, under the real NOBYPASSRLS role that cannot even see A's row; the
  // refusal never names the holder, and nothing is written. A re-saving its own key succeeds.
  it("a second organization saving the same Claim.MD account key gets 409 CLEARINGHOUSE_ACCOUNT_IN_USE; the holder may re-save it", async () => {
    const dup = await tenantCall("PUT", ORG_Q, "", {
      vendor: "claimmd",
      mode: "test",
      secret: KEY_A,
    });
    expect(dup.statusCode, dup.body).toBe(409);
    expect(errorCode(dup)).toBe("CLEARINGHOUSE_ACCOUNT_IN_USE");
    expect(dup.body).not.toContain(ORG_A);
    expect(dup.body).not.toContain(KEY_A);
    expect(
      await q("SELECT 1 FROM tenant_clearinghouse_config WHERE organization_id=$1", [ORG_Q]),
    ).toEqual([]);
    // the refusal rolled its write back, so it is audited on its own transaction: denied, the code and vendor, never the key,
    // its fingerprint or the holder (security review LOW-1)
    const refused = await q<{ outcome: string; context: Record<string, unknown> }>(
      "SELECT outcome, context FROM audit_event WHERE organization_id=$1 AND event_type='m23.tenant_clearinghouse.credential_refused'",
      [ORG_Q],
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      outcome: "denied",
      context: { code: "CLEARINGHOUSE_ACCOUNT_IN_USE", vendor: "claimmd" },
    });
    expect(JSON.stringify(refused)).not.toContain(ORG_A);
    expect(JSON.stringify(refused)).not.toContain(KEY_A);

    const [current] = await q<{ version: number; credential_fingerprint: string }>(
      "SELECT version, credential_fingerprint FROM tenant_clearinghouse_config WHERE organization_id=$1",
      [ORG_A],
    );
    expect(current?.credential_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const resave = await tenantCall(
      "PUT",
      ORG_A,
      "",
      { vendor: "claimmd", mode: "test", secret: KEY_A },
      { "if-match": String(current?.version) },
    );
    expect(resave.statusCode, resave.body).toBe(200);
    const [after] = await q<{ credential_fingerprint: string }>(
      "SELECT credential_fingerprint FROM tenant_clearinghouse_config WHERE organization_id=$1",
      [ORG_A],
    );
    expect(after?.credential_fingerprint).toBe(current?.credential_fingerprint);
    // migration 1435: the credential is reserved to A (one held row), and the re-save did not add another
    expect(
      await q(
        "SELECT organization_id FROM tenant_clearinghouse_credential_reservation WHERE credential_fingerprint=$1 AND released_at IS NULL",
        [current?.credential_fingerprint],
      ),
    ).toEqual([{ organization_id: ORG_A }]);
    // no audit row of any organization, before or after, carries the fingerprint (both tables' write-audit scrub it)
    const audits = await q<{ before: unknown; after: unknown; context: unknown }>(
      "SELECT before, after, context FROM audit_event WHERE resource_kind IN ('tenant_clearinghouse_config', 'tenant_clearinghouse_credential_reservation')",
    );
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(String(current?.credential_fingerprint));
  });

  // Migration 1435 (owner decision 2026-11-08): a credential stays reserved to its tenant through a switch to `outside`; only the
  // platform-ops release frees it, a released reservation is final, and a sealed credential always carries its fingerprint.
  it("keeps a credential reserved after its tenant switches to outside until a platform operator releases it", async () => {
    const KEY_Q = "fake-claimmd-key-Q#live-1";
    const first = await tenantCall("PUT", ORG_Q, "", {
      vendor: "claimmd",
      mode: "test",
      secret: KEY_Q,
    });
    expect(first.statusCode, first.body).toBe(201);
    const out = await tenantCall("PUT", ORG_Q, "", { vendor: "outside" }, { "if-match": "1" });
    expect(out.statusCode, out.body).toBe(200);
    const [hRow] = await q<{ credential_fingerprint: string | null }>(
      "SELECT credential_fingerprint FROM tenant_clearinghouse_config WHERE organization_id=$1",
      [ORG_Q],
    );
    expect(hRow?.credential_fingerprint).toBeNull();
    const held = await q<{ id: string; credential_fingerprint: string }>(
      "SELECT id, credential_fingerprint FROM tenant_clearinghouse_credential_reservation WHERE organization_id=$1 AND released_at IS NULL",
      [ORG_Q],
    );
    expect(held).toHaveLength(1);
    // RLS: org A's tenant role cannot see H's reservation, yet the index refuses A sealing H's old key
    expect(
      await asTenant(
        ORG_A,
        "SELECT 1 FROM tenant_clearinghouse_credential_reservation WHERE organization_id <> current_setting('app.org_id')::uuid",
      ),
    ).toEqual([]);
    const [a] = await q<{ version: number }>(
      "SELECT version FROM tenant_clearinghouse_config WHERE organization_id=$1",
      [ORG_A],
    );
    const steal = await tenantCall(
      "PUT",
      ORG_A,
      "",
      { vendor: "claimmd", mode: "test", secret: KEY_Q },
      { "if-match": String(a?.version) },
    );
    expect(steal.statusCode, steal.body).toBe(409);
    expect(errorCode(steal)).toBe("CLEARINGHOUSE_ACCOUNT_IN_USE");

    // migration 1437: the app role's column grant alone cannot release it; only the platform release path's setting can
    await expect(
      asTenant(
        ORG_Q,
        `UPDATE tenant_clearinghouse_credential_reservation SET released_at=now() WHERE id='${held[0]?.id}'`,
      ),
    ).rejects.toThrow(/released only by the platform release/);
    await expect(
      q("UPDATE tenant_clearinghouse_credential_reservation SET released_at=now() WHERE id=$1", [
        held[0]?.id,
      ]),
    ).rejects.toThrow(/released only by the platform release/);

    // the tenant's own admin has no release route; the platform operator releases it, with a reason, audited
    const release = await platformCall("POST", "ch-q", "/credentials/release", {
      reason: "account moved to another organization, ticket OPS-77",
    });
    expect(release.statusCode, release.body).toBe(200);
    expect(release.json()).toMatchObject({ released: 1, config: { vendor: "outside" } });
    const [gone] = await q<{ released_at: Date | null; released_by_user_id: string }>(
      "SELECT released_at, released_by_user_id FROM tenant_clearinghouse_credential_reservation WHERE id=$1",
      [held[0]?.id],
    );
    expect(gone?.released_at).toBeTruthy();
    expect(gone?.released_by_user_id).toBe(OPERATOR);
    const audited = await q<{ context: Record<string, unknown> }>(
      "SELECT context FROM audit_event WHERE organization_id=$1 AND event_type='m34.tenant_onboarding.clearinghouse_credentials_released'",
      [ORG_Q],
    );
    // the reason is NOT hidden from the tenant: its own trail records it as given (so the console asks for a ticket reference only)
    expect(audited[0]?.context).toMatchObject({
      released: 1,
      reason: "account moved to another organization, ticket OPS-77",
    });
    expect(JSON.stringify(audited)).not.toContain(String(held[0]?.credential_fingerprint));
    // the reservation's own write-audit (tenant-visible) scrubs the release reason too (migration 1436)
    const trail = await q<{ before: unknown; after: unknown }>(
      "SELECT before, after FROM audit_event WHERE resource_kind='tenant_clearinghouse_credential_reservation' AND resource_id=$1",
      [held[0]?.id],
    );
    expect(trail.length).toBeGreaterThan(0);
    expect(JSON.stringify(trail)).not.toContain("ticket OPS-77");
    // a released reservation is final
    await expect(
      q(
        "UPDATE tenant_clearinghouse_credential_reservation SET released_at=NULL, released_by_user_id=NULL, release_reason=NULL WHERE id=$1",
        [held[0]?.id],
      ),
    ).rejects.toThrow(/final/);
    // a sealed credential without its fingerprint is refused by the CHECK (rows written from 1435 on)
    await expect(
      q(
        "UPDATE tenant_clearinghouse_config SET credential_fingerprint=NULL WHERE organization_id=$1",
        [ORG_A],
      ),
    ).rejects.toThrow(/tenant_clearinghouse_config_fingerprint_secret_ck/);
  });

  // Two organizations saving the same new key at the same moment serialise on 1435's index entry: exactly one holds it, the other
  // gets the refusal (audited), and nothing of the loser is written. Every reservation names its fingerprint key (migration 1436).
  it("two organizations racing to seal the same key: one wins, the other is refused, one reservation is held", async () => {
    const KEY_RACE = "fake-claimmd-key-race#live-1";
    const [i, j] = await Promise.all(
      [ORG_R, ORG_S].map((org) =>
        tenantCall("PUT", org, "", { vendor: "claimmd", mode: "test", secret: KEY_RACE }),
      ),
    );
    const codes = [i, j].map((r) => r?.statusCode).sort();
    expect(codes, `${i?.body} | ${j?.body}`).toEqual([201, 409]);
    const loser = i?.statusCode === 409 ? i : j;
    expect(errorCode(loser as NonNullable<typeof loser>)).toBe("CLEARINGHOUSE_ACCOUNT_IN_USE");
    const held = await q<{ organization_id: string; credential_fingerprint_key_id: string | null }>(
      "SELECT r.organization_id, r.credential_fingerprint_key_id FROM tenant_clearinghouse_credential_reservation r WHERE r.released_at IS NULL AND r.organization_id IN ($1,$2)",
      [ORG_R, ORG_S],
    );
    expect(held).toHaveLength(1);
    expect(held[0]?.credential_fingerprint_key_id).toMatch(/^[0-9a-f]{16}$/);
    const loserOrg = held[0]?.organization_id === ORG_R ? ORG_S : ORG_R;
    expect(
      await q("SELECT 1 FROM tenant_clearinghouse_config WHERE organization_id=$1", [loserOrg]),
    ).toEqual([]);
    expect(
      await q(
        "SELECT 1 FROM audit_event WHERE organization_id=$1 AND event_type='m23.tenant_clearinghouse.credential_refused' AND outcome='denied'",
        [loserOrg],
      ),
    ).toHaveLength(1);
  });

  // Security review MEDIUM-1/2: the boot check runs on the real platform carrier (migration 1436's column grant) through the audited
  // withPlatformContext: it counts a platform key a tenant holds, and names the key ids held reservations were computed under, so a
  // KEK change made without listing the old KEK as retired is caught.
  it("the boot check reads only what the carrier is granted, audited at severity critical, and flags an unconfigured key id", async () => {
    registerPlatformJob(M23_PLATFORM_CREDENTIAL_CHECK_JOB_ID);
    const { held, keyIds } = await checkHeldCredentials(
      { platformDb: platformPool.db, auditBypass: m34PlatformBypassAuditor },
      [cipher.fingerprint("claimmd", KEY_A)],
    );
    expect(held).toBe(1); // org A's current key
    expect(keyIds).toContain(cipher.fingerprintKeyId);
    expect(unknownFingerprintKeyIds(keyIds, cipher.fingerprintKeyIds)).toEqual([]);
    // after a KEK change that forgot the retired setting, the old key id is neither current nor retired
    const forgot = buildClearinghouseSecretCipher(Buffer.alloc(32, 12));
    expect(unknownFingerprintKeyIds(keyIds, forgot.fingerprintKeyIds)).toEqual([
      cipher.fingerprintKeyId,
    ]);
    const audited = await q<{ severity: string }>(
      "SELECT severity FROM audit_event WHERE event_type='platform.bypass_invoked' AND context->>'jobId'=$1",
      [M23_PLATFORM_CREDENTIAL_CHECK_JOB_ID],
    );
    expect(audited.map((r) => r.severity)).toContain("critical");

    // security review of cfd943e82, M1: a reservation with NULL key id (1435-backfilled) is counted as unverifiable, not dropped
    const before = await checkHeldCredentials(
      { platformDb: platformPool.db, auditBypass: m34PlatformBypassAuditor },
      [],
    );
    const [legacy] = await q<{ id: string }>(
      "INSERT INTO tenant_clearinghouse_credential_reservation (organization_id, vendor, credential_fingerprint) VALUES ($1, 'claimmd', $2) RETURNING id",
      [ORG_A, "e".repeat(64)],
    );
    try {
      const after = await checkHeldCredentials(
        { platformDb: platformPool.db, auditBypass: m34PlatformBypassAuditor },
        [],
      );
      expect(after.unverifiable).toBe(before.unverifiable + 1);
      expect(after.keyIds).toEqual(before.keyIds);
    } finally {
      await q("DELETE FROM tenant_clearinghouse_credential_reservation WHERE id=$1", [legacy?.id]);
    }
  });

  // Security review LOW-3: with a retired key configured, a save inserts one reservation per key; when a LATER key conflicts, the
  // refusal rolls the earlier key's row back with it, so no stray reservation blocks the true holder's re-entry.
  it("a two-key save refused on its retired key leaves no reservation behind", async () => {
    const twoKey = createTenantClearinghouseService({
      cipher: buildClearinghouseSecretCipher(Buffer.alloc(32, 12), [
        deriveFingerprintSubkey(Buffer.alloc(32, 11)),
      ]),
      probes: {},
    });
    const actor = {
      organizationId: ORG_D,
      userId: TENANT_ADMIN,
      membershipId: MEMBERSHIP,
      lane: "tenant" as const,
    };
    const err = await withOrgContext(
      tenantPool.db,
      { organizationId: ORG_D, userId: TENANT_ADMIN },
      (tx) =>
        twoKey.put(
          createDrizzleConfigStore(tx as never),
          actor,
          { vendor: "claimmd", mode: "test", secret: KEY_A }, // org A holds it under the (now retired) key
          undefined,
        ),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CLEARINGHOUSE_ACCOUNT_IN_USE", statusCode: 409 });
    expect(
      await q(
        "SELECT 1 FROM tenant_clearinghouse_credential_reservation WHERE organization_id=$1",
        [ORG_D],
      ),
    ).toEqual([]);
    expect(
      await q("SELECT 1 FROM tenant_clearinghouse_config WHERE organization_id=$1", [ORG_D]),
    ).toEqual([]);
  });

  it("verifies with the connection test on the unsealed key; activation needs the vendor BAA recorded by the tenant and verified by an operator; the gate follows", async () => {
    expect(await claimsBillingVerdict(ORG_A, {})).toEqual({
      allow: false,
      reason: "clearinghouse_not_active",
    });
    const verify = await tenantCall("POST", ORG_A, "/verify", {});
    expect(verify.statusCode, verify.body).toBe(200);
    expect(verify.json()).toMatchObject({
      config: { status: "verified", verification: { kind: "connection_test" } },
      test: { outcome: "ok" },
    });
    expect(probed.at(-1)).toEqual({ secret: KEY_A, mode: "test" });
    expect(await claimsBillingVerdict(ORG_A, {})).toEqual({
      allow: false,
      reason: "clearinghouse_not_active",
    });

    // D2: connection verified is not enough. No BAA recorded -> 409.
    const noBaa = await tenantCall("POST", ORG_A, "/activate", {});
    expect(noBaa.statusCode).toBe(409);
    expect(errorCode(noBaa)).toBe("CLEARINGHOUSE_BAA_NOT_VERIFIED");
    // The tenant records its own BAA; an operator has not verified it yet -> still 409.
    const record = await tenantCall("POST", ORG_A, "/baa", BAA);
    expect(record.statusCode, record.body).toBe(200);
    expect(record.json()).toMatchObject({
      status: "verified",
      baaRequired: true,
      baa: { heldBy: "tenant", effectiveDate: BAA.effectiveDate, verified: null },
    });
    const unverified = await tenantCall("POST", ORG_A, "/activate", {});
    expect(unverified.statusCode).toBe(409);
    expect(errorCode(unverified)).toBe("CLEARINGHOUSE_BAA_NOT_VERIFIED");
    // The tenant cannot verify its own BAA: the route does not exist on the tenant surface, and the body refuses the field.
    expect((await tenantCall("POST", ORG_A, "/baa", { ...BAA, verified: true })).statusCode).toBe(
      422,
    );
    // A platform operator verifies it: allowed for an ACTIVE tenant too (ORG_A is live), audited with operator, org and reason.
    // Round 2, M1: the verification is pinned (If-Match) to the record the operator read; it is required, and a record swapped by the
    // tenant after that read is a 409 that verifies nothing.
    const pin = (record.json() as { baa: { recordedAt: string } }).baa.recordedAt;
    const unpinned = await platformCall("POST", "ch-a", "/baa/verify", { reason: REASON });
    expect(unpinned.statusCode).toBe(428);
    expect(errorCode(unpinned)).toBe("IF_MATCH_REQUIRED");
    const swapped = await tenantCall("POST", ORG_A, "/baa", {
      ...BAA,
      documentRef: "Claim.MD BAA, a different agreement, contract folder 9",
    });
    expect(swapped.statusCode, swapped.body).toBe(200);
    const stale = await platformCall(
      "POST",
      "ch-a",
      "/baa/verify",
      { reason: REASON },
      { "if-match": `"${pin}"` },
    );
    expect(stale.statusCode, stale.body).toBe(409);
    expect(errorCode(stale)).toBe("CLEARINGHOUSE_BAA_CHANGED");
    expect(
      (await tenantCall("GET", ORG_A, "")).json() as { baa: { verified: unknown } },
    ).toMatchObject({ baa: { verified: null } });
    const livePin = (swapped.json() as { baa: { recordedAt: string } }).baa.recordedAt;
    const verified = await platformCall(
      "POST",
      "ch-a",
      "/baa/verify",
      { reason: REASON },
      { "if-match": `"${livePin}"` },
    );
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json()).toMatchObject({ baa: { verified: { at: expect.any(String) } } });
    const [baaAudit] = await q<{ actor_user_id: string; context: Record<string, unknown> }>(
      "SELECT actor_user_id, context FROM audit_event WHERE organization_id=$1 AND event_type='m34.tenant_onboarding.clearinghouse_baa_verified'",
      [ORG_A],
    );
    expect(baaAudit?.actor_user_id).toBe(OPERATOR);
    expect(baaAudit?.context).toMatchObject({
      reason: REASON,
      targetOrganizationId: ORG_A,
      // the audit row names the record that was verified (a screened reference and a date, never patient data)
      baaDocumentRef: "Claim.MD BAA, a different agreement, contract folder 9",
      baaEffectiveDate: BAA.effectiveDate,
      baaRecordedAt: livePin,
    });

    const activate = await tenantCall("POST", ORG_A, "/activate", {});
    expect(activate.statusCode, activate.body).toBe(200);
    expect(activate.json()).toMatchObject({ status: "active" });
    expect(await claimsBillingVerdict(ORG_A, {})).toEqual({ allow: true });
  });

  it("D3: a billing manager scoped to one provider entity (MAC credential keys only) is refused on every clearinghouse route", async () => {
    const headers = (stepUp: boolean) => ({
      "x-test-user": ENTITY_MANAGER,
      "x-test-org": ORG_A,
      "x-test-roles": "billing_manager",
      ...(stepUp ? { "x-step-up": "fresh", "idempotency-key": `live-${++seq}` } : {}),
    });
    const get = await server.inject({
      method: "GET",
      url: "/api/v1/tenant/clearinghouse",
      headers: headers(false),
    });
    expect(get.statusCode).toBe(403);
    for (const [method, path, payload] of [
      ["PUT", "", { vendor: "outside" }],
      ["POST", "/baa", BAA],
      ["POST", "/verify", {}],
      ["POST", "/activate", {}],
    ] as const) {
      const res = await server.inject({
        method,
        url: `/api/v1/tenant/clearinghouse${path}`,
        headers: headers(true),
        payload,
      });
      expect(res.statusCode, `${method} ${path}`).toBe(403);
    }
  });

  it("the gate refuses outside and nothing-chosen, and allows the org named in the env fallback list", async () => {
    await q(
      "INSERT INTO tenant_clearinghouse_config (organization_id, vendor, status, set_by_membership_id) VALUES ($1,'outside','active',$2)",
      [ORG_C, MEMBERSHIP],
    );
    expect(await claimsBillingVerdict(ORG_C, {})).toEqual({
      allow: false,
      reason: "clearinghouse_outside",
    });
    expect(await claimsBillingVerdict(ORG_D, {})).toEqual({
      allow: false,
      reason: "clearinghouse_not_chosen",
    });
    expect(await claimsBillingVerdict(ORG_E, {})).toEqual({ allow: true });
    expect(await getSeam("TenantClearinghouseReader").choiceForOrg(ORG_E)).toMatchObject({
      vendor: "in_memory",
      source: "platform_env",
    });
    expect(await getSeam("TenantClearinghouseReader").choiceForOrg(ORG_C)).toMatchObject({
      vendor: "outside",
      status: "active",
      source: "tenant",
    });
  });

  it("RLS: a tenant sees only its own row, cannot rewrite or delete another org's, and cannot insert for another org", async () => {
    const count = async (org: string) =>
      Number(
        (
          await asTenant<{ n: number }>(
            org,
            "SELECT count(*)::int AS n FROM tenant_clearinghouse_config",
          )
        )[0]?.n,
      );
    expect(await count(ORG_A)).toBe(1);
    expect(await count(ORG_D)).toBe(0);
    expect(
      await asTenant(ORG_D, "UPDATE tenant_clearinghouse_config SET vendor='outside' RETURNING id"),
    ).toHaveLength(0);
    const client = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await client.connect();
    const inTx = async (org: string, sql: string, params: unknown[] = []) => {
      await client.query("BEGIN");
      try {
        await client.query("SELECT set_config('app.org_id', $1, true)", [org]);
        await client.query(sql, params);
      } finally {
        await client.query("ROLLBACK");
      }
    };
    try {
      await expect(
        inTx(
          ORG_D,
          "INSERT INTO tenant_clearinghouse_config (organization_id, vendor, status, set_by_membership_id) VALUES ($1,'outside','active',$2)",
          [ORG_A, MEMBERSHIP],
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(inTx(ORG_A, "DELETE FROM tenant_clearinghouse_config")).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        inTx(ORG_A, "UPDATE tenant_clearinghouse_config SET organization_id=organization_id"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.end();
    }
  });

  it("the table's own CHECKs refuse an impossible row (an active transmitting config with no secret)", async () => {
    await expect(
      q(
        "INSERT INTO tenant_clearinghouse_config (organization_id, vendor, mode, status, set_by_membership_id) VALUES ($1,'stedi','test','active',$2)",
        [ORG_D, MEMBERSHIP],
      ),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("D2: the table refuses an ACTIVE transmitting config whose BAA is not verified, and a half-recorded BAA", async () => {
    const sealed = (await cipher.encrypt(ORG_D, KEY_G, { vendor: "stedi", mode: "test" })).cipher;
    // migration 1435: a sealed credential carries its fingerprint (a synthetic 64-hex value here)
    const columns = `(credential_fingerprint, organization_id, vendor, mode, status, secret_cipher, secret_dek_version, verification_kind, verified_at,
       verified_by_membership_id, activated_at, activated_by_membership_id, set_by_membership_id`;
    // active with a verified connection but NO verified BAA
    await expect(
      q(
        `INSERT INTO tenant_clearinghouse_config ${columns})
         VALUES (repeat('d', 64), $1,'stedi','test','active',$2,1,'attested',now(),$3,now(),$3,$3)`,
        [ORG_D, sealed, MEMBERSHIP],
      ),
    ).rejects.toThrow(/tenant_clearinghouse_config_active_baa_ck/);
    // active with a recorded but unverified BAA
    await expect(
      q(
        `INSERT INTO tenant_clearinghouse_config ${columns},
           baa_vendor, baa_effective_date, baa_document_ref, baa_recorded_at, baa_recorded_by_membership_id)
         VALUES (repeat('d', 64), $1,'stedi','test','active',$2,1,'attested',now(),$3,now(),$3,$3,'stedi','2026-01-01','BAA ref',now(),$3)`,
        [ORG_D, sealed, MEMBERSHIP],
      ),
    ).rejects.toThrow(/tenant_clearinghouse_config_active_baa_ck/);
    // round 2, L1: an active config resting on a VERIFIED BAA of ANOTHER vendor (a Claim.MD BAA under a Stedi config)
    await expect(
      q(
        `INSERT INTO tenant_clearinghouse_config ${columns},
           baa_vendor, baa_effective_date, baa_document_ref, baa_recorded_at, baa_recorded_by_membership_id,
           baa_verified_at, baa_verified_by_membership_id)
         VALUES (repeat('d', 64), $1,'stedi','test','active',$2,1,'attested',now(),$3,now(),$3,$3,'claimmd','2026-01-01','BAA ref',now(),$3,now(),$3)`,
        [ORG_D, sealed, MEMBERSHIP],
      ),
    ).rejects.toThrow(/tenant_clearinghouse_config_active_baa_ck/);
    // ... the same row on its OWN vendor's verified BAA is allowed (so the refusal above is the vendor, not the shape)
    await q(
      `INSERT INTO tenant_clearinghouse_config ${columns},
         baa_vendor, baa_effective_date, baa_document_ref, baa_recorded_at, baa_recorded_by_membership_id,
         baa_verified_at, baa_verified_by_membership_id)
       VALUES (repeat('d', 64), $1,'stedi','test','active',$2,1,'attested',now(),$3,now(),$3,$3,'stedi','2026-01-01','BAA ref',now(),$3,now(),$3)`,
      [ORG_D, sealed, MEMBERSHIP],
    );
    await q("DELETE FROM tenant_clearinghouse_config WHERE organization_id=$1", [ORG_D]);
    // a BAA vendor that is no vendor, and a vendor with no record behind it
    await expect(
      q(
        `INSERT INTO tenant_clearinghouse_config (organization_id, vendor, mode, status, baa_vendor, baa_effective_date, baa_document_ref,
           baa_recorded_at, baa_recorded_by_membership_id, set_by_membership_id)
         VALUES ($1,'stedi','test','draft','outside','2026-01-01','BAA ref',now(),$2,$2)`,
        [ORG_D, MEMBERSHIP],
      ),
    ).rejects.toThrow(/tenant_clearinghouse_config_baa_vendor_ck/);
    await expect(
      q(
        "INSERT INTO tenant_clearinghouse_config (organization_id, vendor, mode, status, baa_vendor, set_by_membership_id) VALUES ($1,'stedi','test','draft','stedi',$2)",
        [ORG_D, MEMBERSHIP],
      ),
    ).rejects.toThrow(/tenant_clearinghouse_config_baa_record_ck/);
    // a BAA record with a missing part
    await expect(
      q(
        "INSERT INTO tenant_clearinghouse_config (organization_id, vendor, mode, status, baa_document_ref, set_by_membership_id) VALUES ($1,'stedi','test','draft','BAA ref',$2)",
        [ORG_D, MEMBERSHIP],
      ),
    ).rejects.toThrow(/tenant_clearinghouse_config_baa_record_ck/);
    // a verification with no record behind it
    await expect(
      q(
        "INSERT INTO tenant_clearinghouse_config (organization_id, vendor, mode, status, baa_verified_at, baa_verified_by_membership_id, set_by_membership_id) VALUES ($1,'stedi','test','draft',now(),$2,$2)",
        [ORG_D, MEMBERSHIP],
      ),
    ).rejects.toThrow(/tenant_clearinghouse_config_baa_verified_ck/);
  });

  it("resolves each org's OWN transport from the real table: its vendor and mode, nothing for outside, draft or no row", async () => {
    await q(
      `INSERT INTO tenant_clearinghouse_config (organization_id, vendor, mode, status, secret_cipher, secret_dek_version,
         verification_kind, verified_at, verified_by_membership_id, activated_at, activated_by_membership_id, set_by_membership_id,
         baa_vendor, baa_effective_date, baa_document_ref, baa_recorded_at, baa_recorded_by_membership_id, baa_verified_at,
         baa_verified_by_membership_id, credential_fingerprint)
       VALUES ($1,'stedi','production','active',$2,1,'attested',now(),$3,now(),$3,$3,'stedi','2026-01-01','Stedi BAA ref',now(),$3,now(),$3,$4)`,
      [
        ORG_G,
        (await cipher.encrypt(ORG_G, KEY_G, { vendor: "stedi", mode: "production" })).cipher,
        MEMBERSHIP,
        cipher.fingerprint("stedi", KEY_G), // migration 1435: a sealed credential always carries its fingerprint
      ],
    );
    const platformBinding = {
      vendor: "in_memory" as const,
      transport: createInMemoryHarness().transport,
    };
    const runtime = createTenantClearinghouseRuntime({
      db: tenantPool.db,
      cipher,
      attempts: new InMemoryAttemptStore(),
      platformBinding,
      fallbackOrgIds: new Set([ORG_E]),
      isOrganizationLive: async () => true,
    });
    const forOrg = runtime.binding.forOrg;
    expect((await forOrg?.(ORG_A))?.transport.vendor).toBe("claimmd");
    expect((await forOrg?.(ORG_G))?.transport.vendor).toBe("stedi");
    expect((await forOrg?.(ORG_C))?.vendor).toBeNull();
    expect((await forOrg?.(ORG_D))?.vendor).toBeNull();
    expect(await forOrg?.(ORG_E)).toBe(platformBinding);
    expect(await runtime.usageFor(ORG_A)).toBe("test");
    expect(await runtime.usageFor(ORG_G)).toBe("production");
    expect(await runtime.usageFor(ORG_C)).toBeNull();
    expect((await forOrg?.(ORG_A))?.transport).not.toBe((await forOrg?.(ORG_G))?.transport);
  });

  it("locks vendor and mode once a production submission exists; a credential rotation drops the live config to draft, the gate refuses and a claim job is HELD (D6)", async () => {
    await q(
      `INSERT INTO clearinghouse_submission_attempt (organization_id, provider_entity_id, scope, usage, idempotency_key, control_number, kind, identity, status, reserved_at)
       VALUES ($1, gen_random_uuid(), 'scope-a', 'production', 'k-1', '000000001', 'claim', repeat('a',64), 'reserved', now())`,
      [ORG_A],
    );
    const [current] = await q<{ version: number }>(
      "SELECT version FROM tenant_clearinghouse_config WHERE organization_id=$1",
      [ORG_A],
    );
    const version = String(current?.version);
    const swap = await tenantCall(
      "PUT",
      ORG_A,
      "",
      { vendor: "stedi", mode: "production", secret: KEY_G },
      { "if-match": version },
    );
    expect(swap.statusCode).toBe(409);
    expect(errorCode(swap)).toBe("CLEARINGHOUSE_VENDOR_LOCKED");
    const rotate = await tenantCall(
      "PUT",
      ORG_A,
      "",
      { vendor: "claimmd", mode: "test", secret: KEY_A2 },
      { "if-match": version },
    );
    expect(rotate.statusCode, rotate.body).toBe(200);
    // the NEW key has not been tried: back to draft, the old key's verification and activation are gone, the BAA (same vendor) stays
    expect(rotate.json()).toMatchObject({
      status: "draft",
      lastTest: null,
      verification: null,
      activatedAt: null,
      baa: { verified: { at: expect.any(String) } },
    });
    expect(await claimsBillingVerdict(ORG_A, {})).toEqual({
      allow: false,
      reason: "clearinghouse_not_active",
    });
    // a claim job for the org is HELD (delayed, no attempt spent), not failed into the DLQ, even in a mode that lets the work through
    configureClaimsBillingGate({ mode: "shadow", log: () => {} });
    const runtime = createTenantClearinghouseRuntime({
      db: tenantPool.db,
      cipher,
      attempts: new InMemoryAttemptStore(),
      platformBinding: { vendor: "in_memory", transport: createInMemoryHarness().transport },
      fallbackOrgIds: new Set(),
      isOrganizationLive: async () => true,
    });
    const moved: number[] = [];
    await expect(
      holdBeforeRun(
        {
          db: tenantPool.db as never,
          transport: { binding: runtime.binding, contexts: {} as never },
          alerts: { dispatch: async () => undefined },
        },
        { moveToDelayed: async (at: number) => void moved.push(at) },
        "tok",
        "claim.submit",
        { organizationId: ORG_A },
      ),
    ).rejects.toThrow();
    expect(moved).toHaveLength(1);
    configureClaimsBillingGate({ mode: "enforce", log: () => {} });
    // re-verify and re-activate the new key: the BAA needs no second verification
    const reverify = await tenantCall("POST", ORG_A, "/verify", {});
    expect(reverify.json()).toMatchObject({
      config: { status: "verified" },
      test: { outcome: "ok" },
    });
    expect((await tenantCall("POST", ORG_A, "/activate", {})).json()).toMatchObject({
      status: "active",
    });
    expect(await claimsBillingVerdict(ORG_A, {})).toEqual({ allow: true });
  });

  // CH-1: the lock follows the real `hasRecentProductionAttempts` SQL, not the in-memory store's copy of the rule. A production attempt
  // that is `reserved` locks whatever its age; one that is `sent` locks for 90 days from its reservation; a sandbox (test) attempt, a
  // released one and a voided one never lock.
  it.each(LOCK_WINDOW_CASES.map((c, i) => ({ ...c, i })))(
    "the vendor lock against the real table: a $usage attempt, $status, $daysAgo days ago (locked: $locked)",
    async (c) => {
      const i = c.i;
      const created = await tenantCall("PUT", c.org, "", {
        vendor: "claimmd",
        mode: "production",
        secret: `fake-claimmd-key-lock-${i}#live-1`,
      });
      expect(created.statusCode, created.body).toBe(201);
      await q(
        `INSERT INTO clearinghouse_submission_attempt
           (organization_id, provider_entity_id, scope, usage, idempotency_key, control_number, kind, identity, status,
            clearinghouse_submission_id, received_at, reserved_at)
         VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, 'claim', repeat('b', 64), $6::text,
                 CASE WHEN $6::text = 'sent' THEN 'fake-vendor-submission' END,
                 CASE WHEN $6::text = 'sent' THEN now() END,
                 now() - make_interval(days => $7::int))`,
        [
          c.org,
          `scope-lock-${i}`,
          c.usage,
          `k-lock-${i}`,
          String(800000000 + i),
          c.status,
          c.daysAgo,
        ],
      );

      const switched = await tenantCall(
        "PUT",
        c.org,
        "",
        { vendor: "stedi", mode: "production", secret: `fake-stedi-key-lock-${i}-live` },
        { "if-match": "1" },
      );

      if (c.locked) {
        expect(switched.statusCode, switched.body).toBe(409);
        expect(errorCode(switched)).toBe("CLEARINGHOUSE_VENDOR_LOCKED");
        const [row] = await q<{ vendor: string }>(
          "SELECT vendor FROM tenant_clearinghouse_config WHERE organization_id=$1",
          [c.org],
        );
        expect(row?.vendor).toBe("claimmd"); // nothing was written
      } else {
        expect(switched.statusCode, switched.body).toBe(200);
        expect(switched.json()).toMatchObject({ vendor: "stedi", status: "draft" });
      }
    },
  );

  it("audit: the trigger says THAT the sealed credential changed (secret_changed), and the tenant route writes a field-level row (names only)", async () => {
    const rows = await q<{ event_type: string; context: Record<string, unknown> }>(
      `SELECT event_type, context FROM audit_event
        WHERE organization_id=$1 AND resource_kind='tenant_clearinghouse_config'
          AND event_type LIKE 'tenant_clearinghouse_config.%' ORDER BY created_at`,
      [ORG_A],
    );
    const flags = rows.map((r) => r.context.secret_changed);
    expect(flags[0]).toBe(true); // the first put sealed a credential
    expect(flags).toContain(false); // verify / BAA / activate rewrote other columns only
    // the rotation is the update that swapped the credential
    expect(flags.filter((f) => f === true).length).toBeGreaterThanOrEqual(2);

    const fieldRows = await q<{
      event_type: string;
      actor_user_id: string;
      context: Record<string, unknown>;
    }>(
      `SELECT event_type, actor_user_id, context FROM audit_event
        WHERE organization_id=$1 AND event_type LIKE 'm23.tenant_clearinghouse.%' ORDER BY created_at`,
      [ORG_A],
    );
    const changed = fieldRows.filter((r) => r.event_type === "m23.tenant_clearinghouse.changed");
    expect(changed[0]?.context).toMatchObject({ changedFields: ["vendor", "mode", "secret"] });
    expect(changed.at(-1)?.context).toMatchObject({ changedFields: ["secret"] }); // the rotation
    expect(changed[0]?.actor_user_id).toBe(TENANT_ADMIN);
    expect(fieldRows.map((r) => r.event_type)).toEqual(
      expect.arrayContaining([
        "m23.tenant_clearinghouse.baa_recorded",
        "m23.tenant_clearinghouse.verified",
        "m23.tenant_clearinghouse.activated",
      ]),
    );
    // names and codes only: never a credential, a document reference or an evidence note
    const blob = JSON.stringify(fieldRows);
    for (const secret of [KEY_A, KEY_A2, BAA.documentRef]) expect(blob).not.toContain(secret);
  });

  it("a switch is refused while the org has claims queued, with the counts; a same-vendor rotation is not a switch", async () => {
    // ORG_G (stedi, active) with one queued claim attempt (FK triggers are off for this seed: only the count is under test)
    await admin.query("SET session_replication_role = replica");
    try {
      await admin.query(
        `INSERT INTO claim_submission (organization_id, provider_entity_id, kind, claim_id, claim_control_number, attempt_index, outcome)
         VALUES ($1, gen_random_uuid(), 'claim_837i', gen_random_uuid(), 'CW-CTRL-QUEUED', 0, 'queued')`,
        [ORG_G],
      );
    } finally {
      await admin.query("SET session_replication_role = DEFAULT");
    }
    const [row] = await q<{ version: number }>(
      "SELECT version FROM tenant_clearinghouse_config WHERE organization_id=$1",
      [ORG_G],
    );
    const refused = await tenantCall(
      "PUT",
      ORG_G,
      "",
      { vendor: "outside" },
      { "if-match": String(row?.version) },
    );
    expect(refused.statusCode).toBe(409);
    expect(errorCode(refused)).toBe("CLEARINGHOUSE_WORK_WAITING");
    expect(JSON.stringify(refused.json())).toContain('"claims"');

    // Round 2, L5: the same refusal on a ONE-connection pool. The count must read on the service's own transaction (the config row is
    // locked there); a count on a second pooled connection would wait forever for the one this transaction holds.
    const soloPool = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
      max: 1,
    });
    try {
      const actor = {
        organizationId: ORG_G,
        userId: TENANT_ADMIN,
        membershipId: MEMBERSHIP,
        lane: "tenant" as const,
      };
      const solo = createTenantClearinghouseService({
        cipher,
        probes: {},
        waitingWork: async (organizationId, tx) => ({
          claims: tx
            ? await countQueuedClaimsOn(tx, organizationId)
            : await countQueuedClaims(soloPool.db, organizationId),
          commercialSubmissions: tx
            ? await countQueuedCommercialSubmissionsOn(tx, organizationId)
            : await countQueuedCommercialSubmissions(soloPool.db, organizationId),
        }),
      });
      const err = await withOrgContext(
        soloPool.db,
        { organizationId: ORG_G, userId: TENANT_ADMIN },
        (tx) =>
          solo.put(
            createDrizzleConfigStore(tx as never),
            actor,
            { vendor: "outside" },
            row?.version,
          ),
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "CLEARINGHOUSE_WORK_WAITING", statusCode: 409 });
    } finally {
      await soloPool.close();
    }
    await admin
      .query("DELETE FROM claim_submission WHERE organization_id=$1", [ORG_G])
      .catch(() => undefined);
  });

  it("a tenant admin without the key is refused (403)", async () => {
    expect((await tenantCall("GET", ORG_D, "")).statusCode).toBe(403);
    expect((await tenantCall("PUT", ORG_D, "", { vendor: "outside" })).statusCode).toBe(403);
  });

  it("a platform operator sets and verifies a tenant's clearinghouse while it is onboarding (audited, sealed) but cannot activate it: step 7 settles when the TENANT's admin activates", async () => {
    const put = await platformCall("PUT", "ch-b", "", {
      vendor: "claimmd",
      mode: "test",
      secret: KEY_B,
      reason: REASON,
    });
    expect(put.statusCode, put.body).toBe(201);
    expect(put.body).not.toContain(KEY_B);
    expect((await step7(ORG_B))[0]?.status).toBe("pending"); // chosen, but only a draft
    const verify = await platformCall("POST", "ch-b", "/verify", { reason: REASON });
    expect(verify.json()).toMatchObject({ test: { outcome: "ok" } });
    expect((await step7(ORG_B))[0]?.status).toBe("pending"); // verified is not active
    // CW-AC-17: activation is the tenant billing admin's. There is no platform route for it (an operator's attempt is a 404) ...
    expect((await platformCall("POST", "ch-b", "/activate", { reason: REASON })).statusCode).toBe(
      404,
    );
    // ... and D2: the tenant's BAA must be recorded (by the tenant) and verified (by an operator) before the tenant can activate
    const early = await tenantCall("POST", ORG_B, "/activate", {});
    expect(early.statusCode).toBe(409);
    expect(errorCode(early)).toBe("CLEARINGHOUSE_BAA_NOT_VERIFIED");
    expect((await tenantCall("POST", ORG_B, "/baa", BAA)).statusCode).toBe(200);
    const recordedB = (await tenantCall("GET", ORG_B, "")).json() as {
      baa: { recordedAt: string };
    };
    expect(
      (
        await platformCall(
          "POST",
          "ch-b",
          "/baa/verify",
          { reason: REASON },
          { "if-match": `"${recordedB.baa.recordedAt}"` },
        )
      ).statusCode,
    ).toBe(200);
    expect((await step7(ORG_B))[0]?.status).toBe("pending"); // BAA verified, still not active: the operator cannot take the last step
    expect((await platformCall("POST", "ch-b", "/activate", { reason: REASON })).statusCode).toBe(
      404,
    );
    const activate = await tenantCall("POST", ORG_B, "/activate", {});
    expect(activate.statusCode, activate.body).toBe(200);
    expect(activate.json()).toMatchObject({ status: "active" });
    expect((await step7(ORG_B))[0]?.status).toBe("done"); // the real advance pass settled it, off the tenant's own activation

    const [audit] = await q<{
      actor_user_id: string;
      actor_role: string;
      outcome: string;
      context: Record<string, unknown>;
    }>(
      "SELECT actor_user_id, actor_role, outcome, context FROM audit_event WHERE organization_id=$1 AND event_type='m34.tenant_onboarding.clearinghouse_set'",
      [ORG_B],
    );
    expect(audit).toMatchObject({
      actor_user_id: OPERATOR,
      actor_role: "platform_ops",
      outcome: "success",
    });
    expect(audit?.context).toMatchObject({
      reason: REASON,
      targetOrganizationId: ORG_B,
      changedFields: ["vendor", "mode", "secret"],
    });
    const verifyAudit = await q<{ context: Record<string, unknown> }>(
      "SELECT context FROM audit_event WHERE organization_id=$1 AND event_type='m34.tenant_onboarding.clearinghouse_verified'",
      [ORG_B],
    );
    expect(verifyAudit[0]?.context).toMatchObject({
      verificationKind: "connection_test",
      testOutcome: "ok",
    });
    expect(await claimsBillingVerdict(ORG_B, {})).toEqual({ allow: true });
  });

  it("choosing `outside` through the platform route settles step 7 at once", async () => {
    const res = await platformCall("PUT", "ch-f", "", { vendor: "outside", reason: REASON });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ vendor: "outside", status: "active", hasSecret: false });
    expect((await step7(ORG_F))[0]?.status).toBe("done");
    expect(await claimsBillingVerdict(ORG_F, {})).toEqual({
      allow: false,
      reason: "clearinghouse_outside",
    });
  });

  it("refuses the platform write once the tenant is active (409), with nothing written and the refusal audited", async () => {
    const before = await q(
      "SELECT version FROM tenant_clearinghouse_config WHERE organization_id=$1",
      [ORG_A],
    );
    const res = await platformCall(
      "PUT",
      "ch-a",
      "",
      { vendor: "outside", reason: REASON },
      { "if-match": '"1"' },
    );
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe("TENANT_NOT_ONBOARDING");
    expect(
      await q("SELECT version FROM tenant_clearinghouse_config WHERE organization_id=$1", [ORG_A]),
    ).toEqual(before);
    const refused = await q(
      "SELECT 1 FROM audit_event WHERE organization_id=$1 AND event_type='m34.tenant_onboarding.write_refused'",
      [ORG_A],
    );
    expect(refused.length).toBeGreaterThanOrEqual(1);
  });

  it("a failing connection test leaves the config at draft and records the outcome", async () => {
    const bad = await platformCall(
      "PUT",
      "ch-f",
      "",
      { vendor: "claimmd", mode: "test", secret: KEY_BAD, reason: REASON },
      { "if-match": '"1"' },
    );
    expect(bad.statusCode, bad.body).toBe(200);
    const verify = await platformCall("POST", "ch-f", "/verify", { reason: REASON });
    expect(verify.json()).toMatchObject({
      config: { status: "draft", lastTest: { outcome: "credential_rejected" } },
      test: { outcome: "credential_rejected" },
    });
  });

  it("no plaintext credential is in the table, any response or any audit row; the trigger scrubs the sealed value", async () => {
    const dump = JSON.stringify(await q("SELECT t::text AS t FROM tenant_clearinghouse_config t"));
    const audits = JSON.stringify(
      await q("SELECT before, after, context FROM audit_event WHERE organization_id = ANY($1)", [
        [ORG_A, ORG_B, ORG_F, ORG_G],
      ]),
    );
    for (const secret of [KEY_A, KEY_A2, KEY_B, KEY_G, KEY_BAD]) {
      expect(dump).not.toContain(secret);
      expect(audits).not.toContain(secret);
    }
    const triggerRows = await q<{ after: Record<string, unknown> }>(
      "SELECT after FROM audit_event WHERE organization_id=$1 AND resource_kind='tenant_clearinghouse_config' AND event_type LIKE 'tenant_clearinghouse_config.%'",
      [ORG_A],
    );
    expect(triggerRows.length).toBeGreaterThan(0);
    for (const row of triggerRows) expect(row.after.secret_cipher).toBe("<changed>");
  });

  // ── an operator withdraws a tenant's "filed outside ChartWarden" NOE / NOTR record ───────────────────────────────────────────
  // The tenant cannot undo the record and a cancel refuses, so a mistaken or false one would be permanent. The platform operator's
  // route runs on the tenant pool under the target org's RLS (the real NOBYPASSRLS role); the slug lookup is the real platform login.
  describe("an operator withdraws a tenant's external-filing record", () => {
    const WITHDRAW_REASON = "Tenant filed this in error; they confirmed by phone, ticket CHG-7001";
    const RECORDED_AT = new Date("2026-11-09T10:30:00.123Z");
    const FILED_ON = "2026-11-04";
    const STAMP = "2026-11-07";
    const withdrawUrl = (kind: "noe" | "notr", slug: string, id: string) =>
      `/api/v1/platform/tenants/${slug}/${kind}-records/${id}/withdraw-external-filing`;
    const withdraw = (
      kind: "noe" | "notr",
      id: string,
      over: {
        slug?: string;
        payload?: object;
        headers?: Record<string, string>;
        pin?: string | null;
      } = {},
    ) =>
      server.inject({
        method: "POST",
        url: withdrawUrl(kind, over.slug ?? "ch-a", id),
        headers: {
          ...opsWrite(),
          ...(over.pin === null
            ? {}
            : { "if-match": `"${over.pin ?? RECORDED_AT.toISOString()}"` }),
          ...(over.headers ?? {}),
        },
        payload: over.payload ?? { reason: WITHDRAW_REASON },
      });

    /** A notice the tenant recorded as filed outside ChartWarden (state READY, a breach stamp set, a pinned record time). */
    async function seedFiledNotice(
      kind: "noe" | "notr",
      org = ORG_A,
      over: {
        admissionId?: string;
        patientId?: string;
        marker?: "filed" | "pending" | null;
        /** The date the record says it filed (default: on time) and the breach stamp on the row (default: the watchdog's). */
        filedOn?: string;
        stamp?: string | null;
        /** The stamp was written by the record itself (a LATE record does; the watchdog's stamp never is): `external_filing_set_breach`. */
        setBreach?: boolean;
      } = {},
    ): Promise<string> {
      const marker = over.marker === undefined ? "filed" : over.marker;
      const filed = marker === "filed";
      const common = [
        org,
        randomUUID(), // provider entity: a logical FK (no row needed)
        over.patientId ?? randomUUID(),
        over.admissionId ?? randomUUID(),
      ];
      const tail = [
        marker,
        filed ? (over.filedOn ?? FILED_ON) : null,
        filed ? RECORDED_AT : null,
        filed ? MEMBERSHIP : null,
        over.stamp === undefined ? STAMP : over.stamp,
        `WD-${randomUUID().slice(0, 12)}`,
        filed && (over.setBreach ?? false),
      ];
      const [row] =
        kind === "noe"
          ? await q<{ id: string }>(
              `INSERT INTO noe_record (organization_id, provider_entity_id, patient_id, admission_id, election_period_id, state,
                      election_effective_date, window_target_at, external_filing_status, filed_externally_on,
                      filed_externally_recorded_at, filed_externally_by_membership_id, window_breached_at, noe_control_number,
                      external_filing_set_breach)
               VALUES ($1,$2,$3,$4,$5,'READY','2026-11-01','2026-11-06',$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
              [...common, randomUUID(), ...tail],
            )
          : await q<{ id: string }>(
              `INSERT INTO notr_record (organization_id, provider_entity_id, patient_id, admission_id, trigger_kind, discharge_event_id,
                      effective_end_date, window_target_at, state, external_filing_status, filed_externally_on,
                      filed_externally_recorded_at, filed_externally_by_membership_id, window_breached_at, notr_control_number,
                      external_filing_set_breach)
               VALUES ($1,$2,$3,$4,'discharge',$5,'2026-11-01','2026-11-06','READY',$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
              [...common, randomUUID(), ...tail],
            );
      return (row as { id: string }).id;
    }
    const table = (kind: "noe" | "notr") => (kind === "noe" ? "noe_record" : "notr_record");
    const rowOf = async (kind: "noe" | "notr", id: string) =>
      (
        await q<Record<string, unknown>>(
          `SELECT state, version, external_filing_status, filed_externally_on::text AS filed_on,
                  filed_externally_recorded_at AS recorded_at, filed_externally_by_membership_id AS by,
                  window_breached_at::text AS breached, external_filing_set_breach AS set_breach
             FROM ${table(kind)} WHERE id=$1`,
          [id],
        )
      )[0] as Record<string, unknown>;
    const withdrawAuditRows = (id: string) =>
      q<{ actor_user_id: string; outcome: string; context: Record<string, unknown> }>(
        `SELECT actor_user_id, outcome, context FROM audit_event
          WHERE event_type='m34.tenant_onboarding.notice_external_filing_withdrawn' AND resource_id=$1`,
        [id],
      );

    it.each(["noe", "notr"] as const)(
      "%s: the operator withdraws the record the tenant filed: the notice is back to its pre-record state, a breach stamp stays, and the audit names the operator, the reason and the date",
      async (kind) => {
        const id = await seedFiledNotice(kind);
        const before = await rowOf(kind, id);

        const res = await withdraw(kind, id);

        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toEqual({
          noticeKind: kind,
          noticeId: id,
          state: "ready",
          windowTargetAt: "2026-11-06",
          windowBreachedAt: STAMP,
          externalFiling: null,
        });
        expect(await rowOf(kind, id)).toMatchObject({
          state: "READY",
          external_filing_status: null,
          filed_on: null,
          recorded_at: null,
          by: null,
          breached: STAMP, // the watchdog's stamp is never cleared
          version: (before.version as number) + 1,
        });
        // the platform audit row: the operator, the tenant, the reason, the filed date withdrawn, the record's recordedAt
        const audit = await withdrawAuditRows(id);
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ actor_user_id: OPERATOR, outcome: "success" });
        expect(audit[0]?.context).toMatchObject({
          targetOrganizationId: ORG_A,
          targetOrgSlug: "ch-a",
          operatorUserId: OPERATOR,
          reason: WITHDRAW_REASON,
          noticeKind: kind,
          withdrawnFiledOn: FILED_ON,
          withdrawnRecordedAt: RECORDED_AT.toISOString(),
          breachStamp: "kept", // the watchdog's stamp (not the record's own) stays, and the audit row says so
        });
        expect(audit[0]?.context).not.toHaveProperty("clearedBreachStamp");
        // the notice table's own trigger records the change under the OPERATOR (before 'filed', after cleared)
        const trigger = await q<{
          actor_user_id: string;
          before: Record<string, unknown>;
          after: Record<string, unknown>;
        }>(
          `SELECT actor_user_id, before, after FROM audit_event
            WHERE resource_kind='${table(kind)}' AND resource_id=$1 AND event_type='${table(kind)}.update'`,
          [id],
        );
        expect(trigger).toHaveLength(1);
        expect(trigger[0]).toMatchObject({
          actor_user_id: OPERATOR,
          before: { external_filing_status: "filed" },
          after: { external_filing_status: null, filed_externally_on: null },
        });
        // a second withdrawal of the same record has nothing left to withdraw
        const again = await withdraw(kind, id);
        expect(again.statusCode).toBe(409);
        expect(errorCode(again)).toBe("NOTICE_NOT_FILED_EXTERNALLY");
      },
    );

    it.each(["noe", "notr"] as const)(
      "%s: withdrawing a LATE record clears the breach stamp that record wrote itself (and says so on the audit row); the stamp is gone from the row and the response",
      async (kind) => {
        const LATE_ON = "2026-11-08"; // the window closed on 2026-11-06
        const id = await seedFiledNotice(kind, ORG_A, {
          filedOn: LATE_ON,
          stamp: LATE_ON,
          setBreach: true,
        });

        const res = await withdraw(kind, id);

        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toMatchObject({ windowBreachedAt: null, externalFiling: null });
        expect(await rowOf(kind, id)).toMatchObject({
          external_filing_status: null,
          filed_on: null,
          breached: null,
          set_breach: false, // the flag goes with the record (the table's CHECK moves them together)
        });
        const audit = await withdrawAuditRows(id);
        expect(audit).toHaveLength(1);
        expect(audit[0]?.context).toMatchObject({
          withdrawnFiledOn: LATE_ON,
          breachStamp: "cleared",
          clearedBreachStamp: LATE_ON,
        });
        // the notice table's own trigger records the stamp going away, under the operator
        const trigger = await q<{
          before: Record<string, unknown>;
          after: Record<string, unknown>;
        }>(
          `SELECT before, after FROM audit_event
            WHERE resource_kind='${table(kind)}' AND resource_id=$1 AND event_type='${table(kind)}.update'`,
          [id],
        );
        expect(trigger).toHaveLength(1);
        expect(trigger[0]).toMatchObject({
          before: { window_breached_at: LATE_ON },
          after: { window_breached_at: null },
        });
      },
    );

    it.each(["noe", "notr"] as const)(
      "%s: a one-day-late record whose date equals the watchdog's stamp (the watchdog stamped first) keeps that stamp on withdrawal, and the audit row says kept",
      async (kind) => {
        const SAME_DAY = "2026-11-07"; // the window closed on 2026-11-06: the watchdog's first tick stamps the 7th, the tenant filed the 7th
        const id = await seedFiledNotice(kind, ORG_A, {
          filedOn: SAME_DAY,
          stamp: SAME_DAY,
          setBreach: false,
        });

        const res = await withdraw(kind, id);

        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toMatchObject({ windowBreachedAt: SAME_DAY, externalFiling: null });
        expect(await rowOf(kind, id)).toMatchObject({
          external_filing_status: null,
          filed_on: null,
          breached: SAME_DAY,
          set_breach: false,
        });
        const audit = await withdrawAuditRows(id);
        expect(audit).toHaveLength(1);
        expect(audit[0]?.context).toMatchObject({
          withdrawnFiledOn: SAME_DAY,
          breachStamp: "kept",
        });
        expect(audit[0]?.context).not.toHaveProperty("clearedBreachStamp");
      },
    );

    // ── G4: the operator's list of what a tenant recorded as filed outside ChartWarden (the withdraw drawer's rows) ──────────────
    const listUrl = (slug: string) => `/api/v1/platform/tenants/${slug}/notice-filings`;
    const setRecordedAt = (kind: "noe" | "notr", id: string, at: string) =>
      q(`UPDATE ${table(kind)} SET filed_externally_recorded_at=$2 WHERE id=$1`, [id, at]);

    it("lists the org's recorded filings, NOEs and NOTRs together, newest record first, with the pin, the filed date and the stamp owner; never a parked or unmarked notice, another tenant's, or a patient or admission id", async () => {
      const patient = randomUUID();
      // one live NOE per admission: each notice gets its own, and none may appear in the operator's list
      const admissions: string[] = [];
      const idsOf = () => {
        const admissionId = randomUUID();
        admissions.push(admissionId);
        return { patientId: patient, admissionId };
      };
      const oldest = await seedFiledNotice("noe", ORG_H, idsOf());
      await setRecordedAt("noe", oldest, "2026-11-02T09:00:00.000Z");
      const middle = await seedFiledNotice("noe", ORG_H, idsOf());
      await setRecordedAt("noe", middle, "2026-11-03T09:00:00.000Z");
      const newest = await seedFiledNotice("notr", ORG_H, {
        ...idsOf(),
        filedOn: "2026-11-08",
        stamp: "2026-11-08",
        setBreach: true,
      });
      await setRecordedAt("notr", newest, "2026-11-05T09:00:00.123Z");
      await seedFiledNotice("noe", ORG_H, { ...idsOf(), marker: "pending" });
      await seedFiledNotice("notr", ORG_H, { ...idsOf(), marker: null });
      const elsewhere = await seedFiledNotice("noe", ORG_A);

      const res = await server.inject({ method: "GET", url: listUrl("ch-h"), headers: OPS });

      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { items: Record<string, unknown>[]; truncated: boolean };
      expect(body.truncated).toBe(false);
      expect(body.items.map((i) => i.noticeId)).toEqual([newest, middle, oldest]);
      expect(body.items[0]).toEqual({
        noticeKind: "notr",
        noticeId: newest,
        state: "ready",
        windowTargetAt: "2026-11-06",
        windowBreachedAt: "2026-11-08",
        filedOn: "2026-11-08",
        recordedAt: "2026-11-05T09:00:00.123Z",
        breachStampFromRecord: true,
      });
      expect(body.items[1]).toMatchObject({ noticeKind: "noe", breachStampFromRecord: false });
      expect(res.body).not.toContain(patient);
      for (const admission of admissions) expect(res.body).not.toContain(admission);
      expect(res.body).not.toContain(elsewhere);

      // the read's audit row says which KINDS and how many were shown, never which records (a notice id with its dates is an identifier)
      const read = await q<{ context: Record<string, unknown> }>(
        `SELECT context FROM audit_event
          WHERE organization_id=$1 AND event_type='m34.tenant_onboarding.data_read' AND resource_kind='notice_filing'
          ORDER BY created_at DESC LIMIT 1`,
        [ORG_H],
      );
      expect(read[0]?.context).toMatchObject({ count: 3, noeCount: 2, notrCount: 1 });
      expect(JSON.stringify(read[0]?.context)).not.toContain(newest);

      // the list's `recordedAt` is exactly the pin the withdrawal accepts: the drawer needs nothing else
      const pin = body.items[0]?.recordedAt as string;
      const done = await withdraw("notr", newest, { slug: "ch-h", pin });
      expect(done.statusCode, done.body).toBe(200);
      const after = await server.inject({ method: "GET", url: listUrl("ch-h"), headers: OPS });
      expect(
        (after.json() as { items: { noticeId: string }[] }).items.map((i) => i.noticeId),
      ).toEqual([middle, oldest]);
    });

    it("answers an organization that recorded nothing with an empty list, audits the read (the operator, the tenant, a count; no notice id), and refuses a tenant credential; an unknown tenant is a 404", async () => {
      const empty = await server.inject({ method: "GET", url: listUrl("ch-f"), headers: OPS });
      expect(empty.statusCode, empty.body).toBe(200);
      expect(empty.json()).toEqual({ items: [], truncated: false });

      const reads = await q<{
        actor_user_id: string;
        outcome: string;
        context: Record<string, unknown>;
      }>(
        `SELECT actor_user_id, outcome, context FROM audit_event
          WHERE organization_id=$1 AND event_type='m34.tenant_onboarding.data_read' AND resource_kind='notice_filing'`,
        [ORG_F],
      );
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatchObject({ actor_user_id: OPERATOR, outcome: "success" });
      expect(reads[0]?.context).toMatchObject({
        count: 0,
        noeCount: 0,
        notrCount: 0,
        targetOrgSlug: "ch-f",
      });

      const asTenantAdmin = await server.inject({
        method: "GET",
        url: listUrl("ch-a"),
        headers: tenantRead(ORG_A),
      });
      expect(asTenantAdmin.statusCode).toBe(403);
      const unknown = await server.inject({
        method: "GET",
        url: listUrl("no-such-tenant"),
        headers: OPS,
      });
      expect(unknown.statusCode).toBe(404);
    });

    it("a tenant credential is refused (a tenant cannot withdraw its own record), and so is a request without the platform key; nothing changes", async () => {
      const id = await seedFiledNotice("noe");
      const asTenantAdmin = await server.inject({
        method: "POST",
        url: withdrawUrl("noe", "ch-a", id),
        headers: { ...tenantWrite(ORG_A), "if-match": `"${RECORDED_AT.toISOString()}"` },
        payload: { reason: WITHDRAW_REASON },
      });
      expect(asTenantAdmin.statusCode).toBe(403);
      // a platform operator WITHOUT a fresh step-up
      const noStepUp = await server.inject({
        method: "POST",
        url: withdrawUrl("noe", "ch-a", id),
        headers: {
          ...OPS,
          "idempotency-key": `live-${++seq}`,
          "if-match": `"${RECORDED_AT.toISOString()}"`,
        },
        payload: { reason: WITHDRAW_REASON },
      });
      expect(noStepUp.statusCode).toBe(403);
      expect(await rowOf("noe", id)).toMatchObject({ external_filing_status: "filed", version: 0 });
      expect(await withdrawAuditRows(id)).toEqual([]);
    });

    it("a missing or blank reason is a 422, a missing If-Match is a 428, a stale If-Match is a 409 (audited as a failed attempt), a notice not recorded as filed is a 409: nothing is written", async () => {
      const id = await seedFiledNotice("noe");
      expect((await withdraw("noe", id, { payload: {} })).statusCode).toBe(422);
      expect((await withdraw("noe", id, { payload: { reason: "          " } })).statusCode).toBe(
        422,
      );
      // The operator's retry needs the record's CURRENT recordedAt (the If-Match to send): both refusals carry it in the details.
      const currentPin = [
        {
          field: "currentRecordedAt",
          code: expect.any(String),
          message: RECORDED_AT.toISOString(),
        },
      ];
      const noPin = await withdraw("noe", id, { pin: null });
      expect(noPin.statusCode).toBe(428);
      expect(errorCode(noPin)).toBe("IF_MATCH_REQUIRED");
      expect(noPin.json().error.details).toEqual(currentPin);

      const stale = await withdraw("noe", id, { pin: "2026-11-08T08:00:00.000Z" });
      expect(stale.statusCode).toBe(409);
      expect(errorCode(stale)).toBe("NOTICE_FILING_RECORD_CHANGED");
      expect(stale.json().error.details).toEqual(currentPin);
      expect(await rowOf("noe", id)).toMatchObject({ external_filing_status: "filed", version: 0 });
      // the failed attempt leaves its own denied row (the operator, the reason, the error code; never a body value)
      const failed = await q<{ actor_user_id: string; context: Record<string, unknown> }>(
        `SELECT actor_user_id, context FROM audit_event
          WHERE event_type='m34.tenant_onboarding.write_failed' AND resource_kind='noe_record'
            AND context->>'errorCode'='NOTICE_FILING_RECORD_CHANGED' AND context->>'reason'=$1`,
        [WITHDRAW_REASON],
      );
      expect(failed.length).toBeGreaterThanOrEqual(1);
      expect(failed[0]?.actor_user_id).toBe(OPERATOR);

      // the operator retries with the value the refusal gave: that is the whole point of carrying it
      const retryId = await seedFiledNotice("noe");
      const refused = await withdraw("noe", retryId, { pin: "2026-11-08T08:00:00.000Z" });
      const [{ message: currentRecordedAt }] = refused.json().error.details as {
        message: string;
      }[];
      const retried = await withdraw("noe", retryId, { pin: currentRecordedAt });
      expect(retried.statusCode, retried.body).toBe(200);

      const pending = await seedFiledNotice("noe", ORG_A, { marker: "pending" });
      const notFiled = await withdraw("noe", pending);
      expect(notFiled.statusCode).toBe(409);
      expect(errorCode(notFiled)).toBe("NOTICE_NOT_FILED_EXTERNALLY");
      expect(await rowOf("noe", pending)).toMatchObject({ external_filing_status: "pending" });
    });

    it("cross-tenant: org B's notice cannot be withdrawn through org A's slug (a non-leaking 404), and an unknown slug is a 404", async () => {
      const bs = await seedFiledNotice("notr", ORG_B);
      const res = await withdraw("notr", bs, { slug: "ch-a" });
      expect(res.statusCode).toBe(404);
      expect((await withdraw("notr", bs, { slug: "no-such-tenant" })).statusCode).toBe(404);
      expect(await rowOf("notr", bs)).toMatchObject({
        external_filing_status: "filed",
        version: 0,
      });
    });

    it("a NOTR withdrawal reopens the prior election its record closed: the closure read and a readmission's NOE submit both follow the marker", async () => {
      const priorAdmission = randomUUID();
      const patientId = randomUUID();
      const notrId = await seedFiledNotice("notr", ORG_A, {
        admissionId: priorAdmission,
        patientId,
      });
      // the readmission's NOE (a DRAFT of the same patient), and an M23 write service that reports the prior stay as live-ended
      const [noe] = await q<{ id: string }>(
        `INSERT INTO noe_record (organization_id, provider_entity_id, patient_id, admission_id, election_period_id, state,
                election_effective_date, window_target_at, noe_control_number)
         VALUES ($1,$2,$3,$4,$5,'DRAFT','2026-11-01','2026-11-06',$6) RETURNING id`,
        [
          ORG_A,
          randomUUID(),
          patientId,
          randomUUID(),
          randomUUID(),
          `WD-${randomUUID().slice(0, 12)}`,
        ],
      );
      const writeService = buildDrizzleM23WriteService(tenantPool.db as never, {
        jobs: { enqueue: async () => ({ jobId: randomUUID() }) },
        billsOutside: async () => true,
        priorLiveEndedStay: {
          latestPriorLiveEndedAdmission: async () => ({ admissionId: priorAdmission }),
        },
      });
      const actor = {
        organizationId: ORG_A,
        userId: TENANT_ADMIN,
        membershipId: MEMBERSHIP,
        roles: ["billing_specialist"],
        actorKind: "user",
        stepUpRecent: true,
      } as never;
      const closure = () =>
        priorElectionClosureForOrg(tenantPool.db as never, ORG_A, {
          admissionId: priorAdmission,
          patientId,
        });

      expect((await closure()).notrFiled).toBe(true);
      // the election is closed: the readmission's NOE is accepted (parked: this org files outside ChartWarden)
      await expect(
        writeService.submitNoe(actor, (noe as { id: string }).id),
      ).resolves.toMatchObject({ externalFiling: "pending" });

      const res = await withdraw("notr", notrId);
      expect(res.statusCode, res.body).toBe(200);

      expect((await closure()).notrFiled).toBe(false);
      await expect(writeService.submitNoe(actor, (noe as { id: string }).id)).rejects.toMatchObject(
        {
          code: "PRIOR_ELECTION_NOT_CLOSED",
          statusCode: 409,
        },
      );
    });
  });

  // ── slice 5: a tenant that chooses `outside` pays no billing percentage, and the mode change is attributed ──────────────────────
  // The tenant's own PUT runs the post-commit settle, which reaches the pricing contract service. That write is the system's (no
  // operator), but a person set it off: its audit row names the tenant actor and the request's correlation id.
  describe("outside billing and the billing mode: the system sets none (attributed), and leaving outside is the operator's", () => {
    const bypassRows = async () =>
      Number(
        (
          await q<{ n: string }>(
            "SELECT count(*)::text AS n FROM audit_event WHERE event_type='platform.bypass_invoked'",
          )
        )[0]?.n,
      );

    const operator = {
      organizationId: PLATFORM_ORG,
      userId: OPERATOR,
      roles: ["platform_ops"],
      membershipId: MEMBERSHIP,
      stepUpRecent: true,
    };
    // One published plan shared by the stories below (a plan family can only be published once per version).
    let planSlugMemo: string | undefined;
    const publishedPlanSlug = async (): Promise<string> => {
      if (planSlugMemo) return planSlugMemo;
      const draft = await plans.create(
        operator,
        {
          familySlug: "hospice-attribution",
          name: "Hospice attribution",
          perUserPriceCents: 10_000,
          bands: [
            { minAdc: 0, monthlyFeeCents: 100_000 },
            { minAdc: 10, monthlyFeeCents: 200_000 },
          ],
          billingSoftwareBps: 100,
          managedBillingBps: 400,
          contractTermMonths: 12,
          implementationFeeCents: 250_000,
          minimumMonthlyCents: null,
        },
        "price list for the attribution story",
      );
      const published = await plans.publish(
        operator,
        draft.id,
        "approved by the owner",
        await pinOf(draft.id),
      );
      planSlugMemo = published.slug;
      return published.slug;
    };

    it("names the tenant administrator and the request's correlation id on the audit row, and a repeat leaves nothing behind", async () => {
      await contracts.createForTenant(operator, "ch-i", {
        planSlug: await publishedPlanSlug(),
        billingServiceMode: "billing_software",
        orderFormRef: "OF-ATTRIBUTION-1",
        reason: "order form signed by the customer's administrator",
      });
      // the tenant goes live after signing: a change to none then takes effect from the 1st of next month
      await q(
        "UPDATE tenant_account SET status='active', activated_at=now() - interval '40 days' WHERE organization_id=$1",
        [ORG_I],
      );

      const correlation = `corr-attribution-${randomUUID()}`;
      const res = await tenantCall(
        "PUT",
        ORG_I,
        "",
        { vendor: "outside" },
        {
          "x-correlation-id": correlation,
        },
      );

      expect(res.statusCode, res.body).toBe(201);
      const audits = await q<{ context: Record<string, string | null>; correlation_id: string }>(
        `SELECT context, correlation_id FROM audit_event
          WHERE event_type='m35.subscription.billing_service_mode_changed' AND context->>'organizationId'=$1`,
        [ORG_I],
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]?.context).toMatchObject({
        from: "billing_software",
        to: "none",
        trigger: "clearinghouse_outside",
        // a system action, set off by the tenant's own administrator: an id and a membership, never a name
        operatorUserId: "system",
        triggeredBy: "tenant",
        triggeredByUserId: TENANT_ADMIN,
        triggeredByMembershipId: MEMBERSHIP,
      });
      expect(audits[0]?.context.effectiveOn).toMatch(/^\d{4}-\d{2}-01$/);
      expect(audits[0]?.correlation_id).toBe(correlation);

      // Every later settle asks again; a no-op (the mode is already pending none) is decided on the tenant pool and never enters the
      // platform runner, so it leaves no critical platform bypass row and no second mode row.
      const before = await bypassRows();
      expect(await contracts.setModeNoneForOutsideBilling(ORG_I, SYSTEM_TRIGGER)).toEqual({
        changed: false,
      });
      expect(await bypassRows()).toBe(before);
      expect(
        await q(
          `SELECT 1 FROM audit_event WHERE event_type='m35.subscription.billing_service_mode_changed' AND context->>'organizationId'=$1`,
          [ORG_I],
        ),
      ).toHaveLength(1);
      // and a tenant with no contract is a no-op too, with no platform bypass
      expect(await contracts.setModeNoneForOutsideBilling(ORG_A, SYSTEM_TRIGGER)).toEqual({
        changed: false,
      });
      expect(await bypassRows()).toBe(before);
    });

    // ── leaving outside: the tenant's own switch is refused while a contract exists; an operator's switch sets the mode with it ──────
    const configOf = async (slug: string) =>
      (await platformCall("GET", slug, "")).json() as {
        vendor: string | null;
        version: number | null;
      };
    const modeAudits = (org: string) =>
      q<{ context: Record<string, string | null> }>(
        `SELECT context FROM audit_event
          WHERE event_type='m35.subscription.billing_service_mode_changed' AND context->>'organizationId'=$1 ORDER BY created_at`,
        [org],
      );
    // One vendor account per organization (migration 1434): each org gets its own synthetic key.
    const VENDOR_KEY = (slug: string) => `fake-claimmd-key-${slug}#live-1`;
    const inForce = (org: string) => modeInForce(tenantPool.db, org);

    it("refuses a LIVE tenant's own switch out of outside while it has a contract (409), and changes nothing", async () => {
      const before = await tenantCall("GET", ORG_I, "");
      const version = (before.json() as { version: number }).version;
      expect((before.json() as { vendor: string }).vendor).toBe("outside");

      const res = await tenantCall(
        "PUT",
        ORG_I,
        "",
        { vendor: "claimmd", mode: "production", secret: VENDOR_KEY("ch-i") },
        { "if-match": String(version) },
      );

      expect(res.statusCode, res.body).toBe(409);
      expect(errorCode(res)).toBe("CLEARINGHOUSE_OUTSIDE_SWITCH_REQUIRES_OPERATOR");
      const after = (await tenantCall("GET", ORG_I, "")).json() as { vendor: string };
      expect(after.vendor).toBe("outside");
    });

    it("lets a live tenant WITH NO CONTRACT switch out of outside on its own (there is no billing mode to set)", async () => {
      const first = await tenantCall("PUT", ORG_K, "", { vendor: "outside" });
      expect(first.statusCode, first.body).toBe(201);
      const version = (first.json() as { version: number }).version;
      const res = await tenantCall(
        "PUT",
        ORG_K,
        "",
        { vendor: "claimmd", mode: "production", secret: VENDOR_KEY("ch-k") },
        { "if-match": String(version) },
      );
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { vendor: string }).vendor).toBe("claimmd");
    });

    it("refuses an operator's plain mode write on an outside tenant (409), so the sweep can never silently undo it; none stays allowed", async () => {
      await contracts.createForTenant(operator, "ch-j", {
        planSlug: await publishedPlanSlug(),
        billingServiceMode: "billing_software",
        orderFormRef: "OF-LEAVING-1",
        reason: "order form signed by the customer's administrator",
      });
      const chose = await platformCall("PUT", "ch-j", "", { vendor: "outside", reason: REASON });
      expect(chose.statusCode, chose.body).toBe(201);
      // what the wizard's post-commit sync does for an outside tenant
      await contracts.setModeNoneForOutsideBilling(ORG_J, SYSTEM_TRIGGER);
      expect(await inForce(ORG_J)).toBe("none");

      const refused = await contracts
        .setBillingServiceMode(operator, "ch-j", "billing_software", "the customer wants billing")
        .catch((e: unknown) => e);
      expect(refused).toMatchObject({
        code: "BILLING_MODE_REQUIRES_NONE_WHILE_OUTSIDE",
        statusCode: 409,
      });
      expect(await inForce(ORG_J)).toBe("none");
      await expect(
        contracts.setBillingServiceMode(operator, "ch-j", "none", "keeping it unbilled"),
      ).resolves.toBeDefined();
    });

    it("an operator's switch out of outside needs the billing mode named (422) while the tenant has a contract: nothing changes", async () => {
      const { version } = await configOf("ch-j");
      const res = await platformCall(
        "PUT",
        "ch-j",
        "",
        { vendor: "claimmd", mode: "production", secret: VENDOR_KEY("ch-j"), reason: REASON },
        { "if-match": String(version) },
      );
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error.details).toEqual([
        expect.objectContaining({
          field: "billingServiceMode",
          code: "BILLING_SERVICE_MODE_REQUIRED",
        }),
      ]);
      expect((await configOf("ch-j")).vendor).toBe("outside");
      expect(await inForce(ORG_J)).toBe("none");
    });

    it("a plain input error writes NOTHING: a credential the put would refuse is caught before the mode is written, and the attempt is audited as write_failed", async () => {
      const { version } = await configOf("ch-j");
      const modeRowsBefore = (await modeAudits(ORG_J)).length;
      const res = await platformCall(
        "PUT",
        "ch-j",
        "",
        {
          vendor: "claimmd",
          mode: "production",
          // passes the route's shape but the service refuses it (whitespace): the refusal is foreseeable, so no mode is ever written
          secret: "a key with spaces in it",
          billingServiceMode: "managed_billing",
          reason: REASON,
        },
        { "if-match": String(version) },
      );
      expect(res.statusCode, res.body).toBe(422);
      expect((await configOf("ch-j")).vendor).toBe("outside");
      expect(await inForce(ORG_J)).toBe("none");
      expect(await modeAudits(ORG_J)).toHaveLength(modeRowsBefore); // not even a set-and-restore pair
      const failed = await q<{ context: Record<string, string> }>(
        `SELECT context FROM audit_event WHERE event_type='m34.tenant_onboarding.write_failed'
          AND organization_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [ORG_J],
      );
      expect(failed[0]?.context).toMatchObject({
        attemptedEvent: "m34.tenant_onboarding.clearinghouse_set",
        errorCode: "VALIDATION_FAILED", // the adapter's own schema refuses a credential with spaces
      });
    });

    it("a stale pin and a missing pin write nothing either (412 / 428 before the mode)", async () => {
      const { version } = await configOf("ch-j");
      const body = {
        vendor: "claimmd",
        mode: "production",
        secret: VENDOR_KEY("ch-j"),
        billingServiceMode: "managed_billing",
        reason: REASON,
      };
      const stale = await platformCall("PUT", "ch-j", "", body, {
        "if-match": String((version ?? 0) + 7),
      });
      expect(stale.statusCode, stale.body).toBe(412);
      const missing = await platformCall("PUT", "ch-j", "", body);
      expect(missing.statusCode, missing.body).toBe(428);
      expect((await configOf("ch-j")).vendor).toBe("outside");
      expect(await inForce(ORG_J)).toBe("none");
    });

    const dataOperator = { ...operator, request: { correlationId: "live-switch" } };
    const switchBody = (billingServiceMode: string, slug: string) => ({
      vendor: "claimmd",
      mode: "production",
      secret: VENDOR_KEY(slug),
      billingServiceMode,
    });
    const dataServiceOver = (port: OnboardingClearinghousePort) =>
      buildDrizzleOnboardingDataService({
        db: tenantPool.db,
        resolveTenant: buildPlatformTenantResolver({
          platformDb: platformPool.db,
          auditBypass: m34PlatformBypassAuditor,
          platformJobId: JOB_ID,
        }),
        clearinghouse: port,
        billingMode: buildOnboardingBillingModePort(() => contracts),
        settleOnboarding: realSettle,
      });

    it("a vendor change that FAILS after the mode was set (a failure no preflight could foresee) puts the mode back to none", async () => {
      const { version } = await configOf("ch-j");
      // the real adapter, except that the authoritative put fails AFTER the preflight passed and the mode was written
      const flaky = dataServiceOver({
        ...realPort,
        put: async () => {
          throw new ChartWardenError("CLEARINGHOUSE_VERSION_CONFLICT", "changed meanwhile", 412);
        },
      });
      await expect(
        flaky.putClearinghouse(
          dataOperator,
          "ch-j",
          switchBody("managed_billing", "ch-j"),
          REASON,
          version ?? undefined,
        ),
      ).rejects.toMatchObject({ statusCode: 412 });
      expect((await configOf("ch-j")).vendor).toBe("outside");
      expect(await inForce(ORG_J)).toBe("none");
      const audits = await modeAudits(ORG_J);
      // the mode was set to managed_billing by the operator, then put back by the system
      expect(audits.map((a) => a.context.to).slice(-2)).toEqual(["managed_billing", "none"]);
      expect(audits.at(-2)?.context).toMatchObject({ operatorUserId: OPERATOR });
      expect(audits.at(-1)?.context).toMatchObject({ operatorUserId: "system" });
    });

    it("an operator's switch out of outside with the billing mode lands BOTH: the vendor and the mode, the mode audited as the operator's", async () => {
      const { version } = await configOf("ch-j");
      const res = await platformCall(
        "PUT",
        "ch-j",
        "",
        {
          vendor: "claimmd",
          mode: "production",
          secret: VENDOR_KEY("ch-j"),
          billingServiceMode: "managed_billing",
          reason: REASON,
        },
        { "if-match": String(version) },
      );
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { vendor: string }).vendor).toBe("claimmd");
      expect(await inForce(ORG_J)).toBe("managed_billing");
      const last = (await modeAudits(ORG_J)).at(-1);
      expect(last?.context).toMatchObject({
        from: "none",
        to: "managed_billing",
        operatorUserId: OPERATOR,
      });
      expect(last?.context.reason).toBe(REASON);
      // the credential never reached the pricing side or any audit row
      expect(JSON.stringify(await modeAudits(ORG_J))).not.toContain(VENDOR_KEY("ch-j"));
    });

    const firstOfNextMonth = async () =>
      (
        await q<{ d: string }>(
          "SELECT to_char((date_trunc('month', now()) + interval '1 month')::date, 'YYYY-MM-DD') AS d",
        )
      )[0]?.d;
    const modeRows = (org: string) =>
      q<{ billing_service_mode: string; effective_from: Date }>(
        `SELECT scm.billing_service_mode, scm.effective_from::text AS effective_from
           FROM subscription_contract_mode scm JOIN subscription_contract sc ON sc.id = scm.contract_id
          WHERE sc.organization_id=$1 ORDER BY scm.created_at, scm.id`,
        [org],
      );

    it("HIGH: an ACTIVE tenant that bills outside and holds a contract is switched to a vendor by the operator: the vendor lands and the mode is dated the 1st of next month", async () => {
      // ORG_I is active, outside, on a contract whose mode is billing_software today and none from the 1st of next month
      const before = await configOf("ch-i");
      expect(before.vendor).toBe("outside");
      expect(
        await q("SELECT 1 FROM tenant_account WHERE organization_id=$1 AND status='active'", [
          ORG_I,
        ]),
      ).toHaveLength(1);

      const res = await platformCall(
        "PUT",
        "ch-i",
        "",
        { ...switchBody("managed_billing", "ch-i"), reason: REASON },
        { "if-match": String(before.version) },
      );

      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { vendor: string }).vendor).toBe("claimmd");
      expect((await configOf("ch-i")).vendor).toBe("claimmd");
      // the mode is the operator's choice, dated from the 1st of next month (the tenant is live); today's mode is untouched
      const rows = await modeRows(ORG_I);
      expect(rows.at(-1)).toMatchObject({
        billing_service_mode: "managed_billing",
        effective_from: await firstOfNextMonth(),
      });
      expect(await inForce(ORG_I)).toBe("billing_software");
      const last = (await modeAudits(ORG_I)).at(-1);
      expect(last?.context).toMatchObject({ to: "managed_billing", operatorUserId: OPERATOR });
      // a non-switch write on a live tenant stays onboarding-only
      const plain = await platformCall(
        "PUT",
        "ch-i",
        "",
        { vendor: "claimmd", mode: "test", secret: VENDOR_KEY("ch-i"), reason: REASON },
        { "if-match": String((await configOf("ch-i")).version) },
      );
      expect(plain.statusCode, plain.body).toBe(409);
      expect(errorCode(plain)).toBe("TENANT_NOT_ONBOARDING");
    });

    it("M3: a PAUSED contract still counts: the tenant's own switch is refused, the operator names the mode, and the system keeps an outside paused tenant on none", async () => {
      await contracts.createForTenant(operator, "ch-n", {
        planSlug: await publishedPlanSlug(),
        billingServiceMode: "billing_software",
        orderFormRef: "OF-PAUSED-1",
        reason: "order form signed by the customer's administrator",
      });
      const chose = await platformCall("PUT", "ch-n", "", { vendor: "outside", reason: REASON });
      expect(chose.statusCode, chose.body).toBe(201);
      // the subscription is paused (a paused contract is not "live", and was invisible to the switch block and the mode writers)
      await q("UPDATE subscription SET status='paused', paused_at=now() WHERE organization_id=$1", [
        ORG_N,
      ]);

      // the system's outside-means-none rule applies to a paused contract too: it bills again on resume
      expect((await contracts.setModeNoneForOutsideBilling(ORG_N, SYSTEM_TRIGGER)).changed).toBe(
        true,
      );
      expect(await inForce(ORG_N)).toBe("none");
      expect(await contracts.hasContract(ORG_N)).toBe(true);
      // the operator's read tells the panel a contract exists
      expect(
        ((await platformCall("GET", "ch-n", "")).json() as { hasContract: boolean }).hasContract,
      ).toBe(true);

      const { version } = await configOf("ch-n");
      const own = await tenantCall(
        "PUT",
        ORG_N,
        "",
        { vendor: "claimmd", mode: "production", secret: VENDOR_KEY("ch-n") },
        { "if-match": String(version) },
      );
      expect(own.statusCode, own.body).toBe(409);
      expect(errorCode(own)).toBe("CLEARINGHOUSE_OUTSIDE_SWITCH_REQUIRES_OPERATOR");

      const operatorsSwitch = await platformCall(
        "PUT",
        "ch-n",
        "",
        { ...switchBody("billing_software", "ch-n"), reason: REASON },
        { "if-match": String(version) },
      );
      expect(operatorsSwitch.statusCode, operatorsSwitch.body).toBe(200);
      expect(await inForce(ORG_N)).toBe("billing_software");
      // and a CANCELED contract is no contract: nothing to name
      await q(
        "UPDATE subscription SET status='canceled', canceled_at=now() WHERE organization_id=$1",
        [ORG_N],
      );
      expect(await contracts.hasContract(ORG_N)).toBe(false);
    });

    it("M2: the system sets none between the operator's mode write and the vendor commit, and the mode is confirmed AFTER the vendor committed", async () => {
      await contracts.createForTenant(operator, "ch-o", {
        planSlug: await publishedPlanSlug(),
        billingServiceMode: "billing_software",
        orderFormRef: "OF-RACE-1",
        reason: "order form signed by the customer's administrator",
      });
      expect(
        (await platformCall("PUT", "ch-o", "", { vendor: "outside", reason: REASON })).statusCode,
      ).toBe(201);
      const { version } = await configOf("ch-o");
      // the wizard's sync / the hourly sweep, running while the tenant is still outside: it lands between the two writes
      const racing = dataServiceOver({
        ...realPort,
        put: async (tx, scope, body, expectedVersion) => {
          await contracts.setModeNoneForOutsideBilling(ORG_O, SYSTEM_TRIGGER);
          return realPort.put(tx, scope, body, expectedVersion);
        },
      });

      await racing.putClearinghouse(
        dataOperator,
        "ch-o",
        switchBody("managed_billing", "ch-o"),
        REASON,
        version ?? undefined,
      );

      expect((await configOf("ch-o")).vendor).toBe("claimmd");
      expect(await inForce(ORG_O)).toBe("managed_billing"); // not the none the system wrote in the window
      const trail = (await modeAudits(ORG_O)).map((a) => [a.context.to, a.context.operatorUserId]);
      expect(trail.slice(-3)).toEqual([
        ["managed_billing", OPERATOR],
        ["none", "system"],
        ["managed_billing", OPERATOR],
      ]);
    });

    it("two mode writers at once serialise on the subscription row: the second judges the history AFTER the first, so one change is one row", async () => {
      await contracts.createForTenant(operator, "ch-p", {
        planSlug: await publishedPlanSlug(),
        billingServiceMode: "billing_software",
        orderFormRef: "OF-LOCK-1",
        reason: "order form signed by the customer's administrator",
      });
      const before = (await modeRows(ORG_P)).length;
      const write = () =>
        contracts.setBillingServiceMode(
          operator,
          "ch-p",
          "managed_billing",
          "the customer wants managed billing",
        );
      await Promise.all([write(), write(), write()]);
      // without the lock and the reload after it, each would read the same history and insert its own row
      const rows = await modeRows(ORG_P);
      expect(rows).toHaveLength(before + 1);
      expect(rows.at(-1)?.billing_service_mode).toBe("managed_billing");
      expect(await inForce(ORG_P)).toBe("managed_billing");
    });

    it("the hourly sweep's backstop: an outside tenant whose mode is not none is set to none, before its statement, attributed to the system", async () => {
      await contracts.createForTenant(operator, "ch-l", {
        planSlug: await publishedPlanSlug(),
        billingServiceMode: "billing_software",
        orderFormRef: "OF-SWEEP-1",
        reason: "order form signed by the customer's administrator",
      });
      // outside, but the wizard's best-effort sync never ran (or failed): the mode is still billing_software
      const chose = await platformCall("PUT", "ch-l", "", { vendor: "outside", reason: REASON });
      expect(chose.statusCode, chose.body).toBe(201);
      expect(await inForce(ORG_L)).toBe("billing_software");

      // the real reconciler over the real choice seam and the real contract service, driven by the sweep's own per-org step
      const reconcile = createOutsideModeReconciler({
        billsOutside: async (org) =>
          (await getSeam("TenantClearinghouseReader").choiceForOrg(org)).vendor === "outside",
        contracts: () => contracts,
      });
      const order: string[] = [];
      await reconcileThenStatement(
        async (org) => {
          await reconcile(org);
          order.push(`reconciled:${await inForce(ORG_L)}`);
        },
        undefined,
        async () => void order.push(`statement:${await inForce(ORG_L)}`),
        ORG_L,
      );

      // the statement is computed on the corrected mode, never before it
      expect(order).toEqual(["reconciled:none", "statement:none"]);
      const last = (await modeAudits(ORG_L)).at(-1);
      expect(last?.context).toMatchObject({
        from: "billing_software",
        to: "none",
        trigger: "clearinghouse_outside",
        operatorUserId: "system",
        triggeredBy: "system",
        triggeredByUserId: null,
      });
      // a second sweep finds nothing to do: no second row, no second audit
      await reconcile(ORG_L);
      expect(await modeAudits(ORG_L)).toHaveLength(1);
    });

    it("refuses a billing mode on a write that is not a contracted tenant's switch out of outside (422), never silently ignoring it", async () => {
      // ORG_J is a vendor tenant now
      const { version } = await configOf("ch-j");
      const res = await platformCall(
        "PUT",
        "ch-j",
        "",
        {
          vendor: "claimmd",
          mode: "production",
          secret: `${VENDOR_KEY("ch-j")}-rotated`,
          billingServiceMode: "none",
          reason: REASON,
        },
        { "if-match": String(version) },
      );
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error.details[0]).toMatchObject({
        code: "BILLING_SERVICE_MODE_NOT_APPLICABLE",
      });
      expect(await inForce(ORG_J)).toBe("managed_billing");
    });
  });

  // Migration 1468: a platform operator revokes the vendor BAA a tenant recorded (the vendor ended it). Proven on the real roles: the
  // app role writes the new columns under RLS, the CHECKs and the guard trigger hold, the revoke is atomic with its audit row and its
  // outbox announcement, the revoked config is unbound for every consumer of the resolver, and the exception to the vendor lock works
  // end to end against the real attempt table (and ends with the vendor the tenant left).
  describe("BAA revoke: a platform operator stops a tenant's vendor (migration 1468)", () => {
    const REVOKE = { reasonCode: "vendor_terminated", ticketRef: "SEC-42" };
    type View = {
      status: string;
      vendor: string;
      version: number;
      hasSecret: boolean;
      baa: {
        revoked: boolean;
        revokedAt: string | null;
        revokedReasonCode: string | null;
        revokedTicketRef?: string;
        previousRevocation?: { at: string; sameDocument: boolean };
        verified: unknown;
        recordedAt: string;
      } | null;
    };
    const keyOf = (slug: string) => `fake-claimmd-key-${slug}#revoke-1`;
    const tenantView = async (org: string): Promise<View> =>
      (await tenantCall("GET", org, "")).json() as View;
    const platformView = async (slug: string): Promise<View> =>
      (await platformCall("GET", slug, "")).json() as View;
    /** An org taken to `active` through the real routes: choice, connection test, BAA recorded by the tenant, verified by the operator. */
    async function goLive(org: string, slug: string): Promise<{ pin: string }> {
      const created = await tenantCall("PUT", org, "", {
        vendor: "claimmd",
        mode: "production",
        secret: keyOf(slug),
      });
      expect(created.statusCode, created.body).toBe(201);
      expect((await tenantCall("POST", org, "/verify", {})).statusCode).toBe(200);
      const recorded = await tenantCall("POST", org, "/baa", BAA);
      expect(recorded.statusCode, recorded.body).toBe(200);
      const pin = (recorded.json() as View).baa?.recordedAt as string;
      const verified = await platformCall(
        "POST",
        slug,
        "/baa/verify",
        { reason: REASON },
        { "if-match": `"${pin}"` },
      );
      expect(verified.statusCode, verified.body).toBe(200);
      const activated = await tenantCall("POST", org, "/activate", {});
      expect(activated.statusCode, activated.body).toBe(200);
      return { pin };
    }
    const revoke = (slug: string, pin: string, body: object = REVOKE) =>
      platformCall("POST", slug, "/baa/revoke", body, { "if-match": `"${pin}"` });
    /** One production attempt row, `reserved` (in flight) or `sent`, reserved `daysAgo` days ago (a fraction of a day is allowed). */
    const attempt = (org: string, tag: number, status: "reserved" | "sent", daysAgo: number) =>
      q(
        `INSERT INTO clearinghouse_submission_attempt
           (organization_id, provider_entity_id, scope, usage, idempotency_key, control_number, kind, identity, status,
            clearinghouse_submission_id, received_at, reserved_at)
         VALUES ($1, gen_random_uuid(), $2, 'production', $3, $4, 'claim', repeat('c', 64), $5::text,
                 CASE WHEN $5::text = 'sent' THEN 'fake-vendor-submission' END,
                 CASE WHEN $5::text = 'sent' THEN now() END,
                 now() - make_interval(secs => ($6::numeric * 86400)::float8))`,
        [org, `scope-revoke-${tag}`, `k-revoke-${tag}`, String(810000000 + tag), status, daysAgo],
      );
    /** One production attempt at an exact instant (the Docker clock may differ from this process's: tests that order attempts against a
     *  departure time use this, with a margin, instead of the database's now()). */
    const attemptAt = (org: string, tag: number, status: "reserved" | "sent", at: Date) =>
      q(
        `INSERT INTO clearinghouse_submission_attempt
           (organization_id, provider_entity_id, scope, usage, idempotency_key, control_number, kind, identity, status,
            clearinghouse_submission_id, received_at, reserved_at)
         VALUES ($1, gen_random_uuid(), $2, 'production', $3, $4, 'claim', repeat('c', 64), $5::text,
                 CASE WHEN $5::text = 'sent' THEN 'fake-vendor-submission' END,
                 CASE WHEN $5::text = 'sent' THEN now() END, $6::timestamptz)`,
        [org, `scope-revoke-${tag}`, `k-revoke-${tag}`, String(810000000 + tag), status, at],
      );
    type Row = {
      status: string;
      vendor: string;
      version: number;
      secret_cipher: string | null;
      activated_at: Date | null;
      baa_recorded_at: Date | null;
      baa_verified_at: Date | null;
      baa_revoked_at: Date | null;
      baa_revoked_by_membership_id: string | null;
      baa_revoked_reason_code: string | null;
      baa_revoked_ticket_ref: string | null;
      baa_last_revoked_at: Date | null;
      baa_last_revoked_document_ref: string | null;
      revoked_vendor_left_at: Date | null;
    };
    const rowOf = async (org: string): Promise<Row | undefined> =>
      (
        await q<Row>(
          `SELECT status, vendor, version, secret_cipher, activated_at, baa_recorded_at, baa_verified_at, baa_revoked_at,
                  baa_revoked_by_membership_id, baa_revoked_reason_code, baa_revoked_ticket_ref, baa_last_revoked_at,
                  baa_last_revoked_document_ref, revoked_vendor_left_at
             FROM tenant_clearinghouse_config WHERE organization_id=$1`,
          [org],
        )
      )[0];
    const revokeAudits = (org: string) =>
      q<{ actor_user_id: string; outcome: string; context: Record<string, unknown> }>(
        `SELECT actor_user_id, outcome, context FROM audit_event
          WHERE organization_id=$1 AND event_type='m34.tenant_onboarding.clearinghouse_baa_revoked' ORDER BY created_at`,
        [org],
      );
    const revokeEvents = (org: string) =>
      q<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM outbox_event WHERE organization_id=$1 AND event_type='m23.tenant_clearinghouse.baa_revoked'",
        [org],
      );
    const runtime = () =>
      createTenantClearinghouseRuntime({
        db: tenantPool.db,
        cipher,
        attempts: new InMemoryAttemptStore(),
        platformBinding: { vendor: "in_memory", transport: createInMemoryHarness().transport },
        fallbackOrgIds: new Set(),
        // This describe exercises BAA-revocation/config state; organization lifecycle is held live throughout.
        isOrganizationLive: async () => true,
      });
    const unbound = async (org: string) => runtime().binding.forOrg?.(org);
    /** The admin connection inside ONE transaction that carries the guard trigger's setting: what the config store sets for a service write. */
    const underGuard = async (sql: string, params: unknown[] = []) => {
      await admin.query("BEGIN");
      try {
        await admin.query("SELECT set_config('app.clearinghouse_baa_revocation', 'service', true)");
        await admin.query(sql, params);
      } finally {
        await admin.query("ROLLBACK");
      }
    };

    let pinK = "";
    let pinL = "";

    it("revokes under the real app role: the guards hold, no free text is taken, the verification is voided, a live config leaves active, and the audit row and the tenant's announcement commit with it", async () => {
      ({ pin: pinK } = await goLive(REV_ORG_K, "rev-k"));
      ({ pin: pinL } = await goLive(REV_ORG_L, "rev-l"));
      await attempt(REV_ORG_K, 1, "reserved", 0); // a production claim in flight
      expect(await claimsBillingVerdict(REV_ORG_K, {})).toEqual({ allow: true });

      // the guards: a fresh step-up, an Idempotency-Key and the If-Match pin are each required
      const bare = (headers: Record<string, string>) =>
        server.inject({
          method: "POST",
          url: "/api/v1/platform/tenants/rev-k/clearinghouse/baa/revoke",
          headers,
          payload: REVOKE,
        });
      const noStepUp = await bare({
        ...OPS,
        "idempotency-key": `live-${++seq}`,
        "if-match": `"${pinK}"`,
      });
      expect(noStepUp.statusCode).toBe(403);
      expect(errorCode(noStepUp)).toBe("STEP_UP_REQUIRED");
      const { "idempotency-key": _drop, ...noKey } = opsWrite();
      const noIdem = await bare({ ...noKey, "if-match": `"${pinK}"` });
      expect(noIdem.statusCode).toBe(400);
      expect(errorCode(noIdem)).toBe("IDEMPOTENCY_KEY_REQUIRED");
      const noPin = await platformCall("POST", "rev-k", "/baa/revoke", REVOKE);
      expect(noPin.statusCode).toBe(428);
      expect(errorCode(noPin)).toBe("IF_MATCH_REQUIRED");
      // NO FREE TEXT: the old free-text request, a sentence in place of the code, and a ticket that is a sentence are each a 422 that
      // writes nothing: no row change, no audit row (not even a write_failed one carrying the text), no announcement
      const SENTENCE = "Patient John Smith DOB 04/12/1941 phone 555-123-4567 BAA ended";
      for (const body of [
        { reason: SENTENCE },
        { ...REVOKE, reason: SENTENCE },
        { reasonCode: SENTENCE, ticketRef: "SEC-42" },
        { reasonCode: "other", ticketRef: `SEC-42 ${SENTENCE}` },
        { reasonCode: "other", ticketRef: "sec-42" },
      ]) {
        const refused = await revoke("rev-k", pinK, body);
        expect(refused.statusCode, JSON.stringify(body)).toBe(422);
      }
      expect(await rowOf(REV_ORG_K)).toMatchObject({ status: "active", baa_revoked_at: null });
      expect(await revokeAudits(REV_ORG_K)).toHaveLength(0);
      expect(
        await q(
          "SELECT 1 FROM audit_event WHERE organization_id=$1 AND context::text LIKE '%John Smith%'",
          [REV_ORG_K],
        ),
      ).toHaveLength(0);
      expect(await revokeEvents(REV_ORG_K)).toHaveLength(0);

      const res = await revoke("rev-k", pinK);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        status: "verified",
        baaRequired: true,
        baa: {
          revoked: true,
          verified: null,
          revokedReasonCode: "vendor_terminated",
          revokedTicketRef: "SEC-42",
        },
      });
      expect(await rowOf(REV_ORG_K)).toMatchObject({
        status: "verified",
        activated_at: null,
        baa_verified_at: null,
        baa_revoked_by_membership_id: MEMBERSHIP,
        baa_revoked_reason_code: "vendor_terminated",
        baa_revoked_ticket_ref: "SEC-42",
        baa_last_revoked_document_ref: BAA.documentRef,
      });
      const row = await rowOf(REV_ORG_K);
      expect(row?.baa_revoked_at).toBeInstanceOf(Date);
      expect(row?.baa_last_revoked_at).toEqual(row?.baa_revoked_at); // the history names this very revocation
      expect(row?.baa_recorded_at).toBeInstanceOf(Date); // the record stays: which agreement ended

      // the audit row is in the same transaction: operator, tenant, the built reason, vendor, the record and what it stopped / leaves owed
      const audits = await revokeAudits(REV_ORG_K);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actor_user_id: OPERATOR, outcome: "success" });
      expect(audits[0]?.context).toMatchObject({
        reason: "baa_revoked:vendor_terminated:SEC-42",
        targetOrganizationId: REV_ORG_K,
        operatorMembershipId: MEMBERSHIP,
        baaRevoked: true,
        wasActive: true,
        vendor: "claimmd",
        reasonCode: "vendor_terminated",
        ticketRef: "SEC-42",
        baaRecordedAt: pinK,
        attemptsInFlight: 1,
        attemptsSentInWindow: 0,
        queuedClaims: 0,
        queuedCommercialSubmissions: 0,
        credentialCleared: false,
      });
      // ... and so is the tenant's announcement, through the real catalog-validating publisher: ids, the closed code and counts only
      const events = await revokeEvents(REV_ORG_K);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({
        vendor: "claimmd",
        reasonCode: "vendor_terminated",
        wasActive: true,
        attemptsInFlight: 1,
        attemptsSentInWindow: 0,
        queuedClaims: 0,
        queuedCommercialSubmissions: 0,
      });
      expect(JSON.stringify(events[0]?.payload)).not.toContain("SEC-42"); // the ticket is platform-only
      // ... and the row trigger recorded the change itself, with no secret
      const [trigger] = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND event_type='tenant_clearinghouse_config.update'
            AND after->>'baa_revoked_at' IS NOT NULL AND after->>'secret_cipher' IS DISTINCT FROM $2`,
        [REV_ORG_K, "x"],
      );
      expect(trigger?.n).toBeGreaterThanOrEqual(1);
    });

    it("rolls the revoke back with a failing audit insert, and with a failing announcement: it is atomic with both", async () => {
      // failure injection on the real tables: a trigger that refuses the revoke's own audit row, then one that refuses its outbox event
      await admin.query(`
        CREATE OR REPLACE FUNCTION test_refuse_revoke_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.event_type = 'm34.tenant_onboarding.clearinghouse_baa_revoked' AND NEW.outcome = 'success' THEN
            RAISE EXCEPTION 'injected audit failure';
          END IF;
          RETURN NEW;
        END $$`);
      await admin.query(`
        CREATE OR REPLACE FUNCTION test_refuse_revoke_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.event_type = 'm23.tenant_clearinghouse.baa_revoked' THEN
            RAISE EXCEPTION 'injected outbox failure';
          END IF;
          RETURN NEW;
        END $$`);
      try {
        for (const [table, fn] of [
          ["audit_event", "test_refuse_revoke_audit"],
          ["outbox_event", "test_refuse_revoke_event"],
        ] as const) {
          await admin.query(
            `CREATE TRIGGER test_refuse_revoke BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
          );
          try {
            const failed = await revoke("rev-l", pinL);
            expect(failed.statusCode, `${table}: ${failed.body}`).toBeGreaterThanOrEqual(500);
            // nothing of the revoke survived: the row is as it was, no half-revoked state, no audit row, no announcement
            expect(await rowOf(REV_ORG_L), table).toMatchObject({
              status: "active",
              baa_revoked_at: null,
              baa_revoked_reason_code: null,
              baa_last_revoked_at: null,
            });
            expect((await rowOf(REV_ORG_L))?.baa_verified_at, table).toBeInstanceOf(Date);
            expect(await revokeAudits(REV_ORG_L), table).toHaveLength(0);
            expect(await revokeEvents(REV_ORG_L), table).toHaveLength(0);
          } finally {
            await admin.query(`DROP TRIGGER test_refuse_revoke ON ${table}`);
          }
        }
      } finally {
        await admin.query("DROP FUNCTION test_refuse_revoke_audit()");
        await admin.query("DROP FUNCTION test_refuse_revoke_event()");
      }
      // with the injection gone the same request is not refused for a leftover: org L is still revocable (and stays so: the next
      // case needs it live, so it is not revoked here)
      expect(await rowOf(REV_ORG_L)).toMatchObject({ status: "active", baa_revoked_at: null });
    });

    it("shows the tenant the time and the closed code but never the ticket; the platform view has it; the gate says why; the resolver and the worker pre-flight hold the work", async () => {
      const tenant = await tenantCall("GET", REV_ORG_K, "");
      expect(tenant.json()).toMatchObject({
        status: "verified",
        baaRequired: true,
        baa: {
          revoked: true,
          revokedAt: expect.any(String),
          revokedReasonCode: "vendor_terminated",
          verified: null,
        },
      });
      expect(tenant.body).not.toContain("SEC-42");
      expect(tenant.json().baa).not.toHaveProperty("revokedTicketRef");
      expect(tenant.json().baa).not.toHaveProperty("previousRevocation");
      expect((await platformView("rev-k")).baa?.revokedTicketRef).toBe("SEC-42");

      // claims are refused with the reason, not "not active yet"
      expect(await claimsBillingVerdict(REV_ORG_K, {})).toEqual({
        allow: false,
        reason: "clearinghouse_baa_revoked",
      });
      const binding = await unbound(REV_ORG_K);
      expect(binding?.vendor).toBeNull();
      expect(binding?.unboundReason).toBe("baa_revoked");
      // the control: a tenant whose BAA stands still resolves its own transport
      expect((await unbound(REV_ORG_L))?.transport.vendor).toBe("claimmd");

      // the REAL worker pre-flight (holdBeforeRun) over the REAL resolver: every sending queue is HELD (moved to delayed, nothing sent,
      // nothing failed), a NOE / NOTR / transfer notice with a critical alert that names the reason
      configureClaimsBillingGate({ mode: "shadow", log: () => {} });
      try {
        for (const [queue, severity] of [
          [M23_QUEUES.claimSubmit, "warn"],
          [M23_QUEUES.claimSubmitRetry, "warn"],
          [M23_QUEUES.noeSubmit, "critical"],
          [M23_QUEUES.notrSubmit, "critical"],
          [M23_QUEUES.transferNoticeSubmit, "critical"],
        ] as const) {
          __resetClearinghouseAlertMemoryForTest(); // one alert per org / reason / severity per window: each queue asks afresh
          const moved: number[] = [];
          const alerts: { severity: string; payload: Record<string, unknown> }[] = [];
          await expect(
            holdBeforeRun(
              {
                db: tenantPool.db as never,
                transport: { binding: runtime().binding, contexts: {} as never },
                alerts: { dispatch: async (a) => void alerts.push(a) },
              },
              { moveToDelayed: async (at: number) => void moved.push(at) },
              "tok",
              queue,
              { organizationId: REV_ORG_K },
            ),
            queue,
          ).rejects.toThrow();
          expect(moved, queue).toHaveLength(1);
          expect(alerts, queue).toEqual([
            expect.objectContaining({ severity, payload: { queue, reason: "baa_revoked" } }),
          ]);
        }
      } finally {
        configureClaimsBillingGate({ mode: "enforce", log: () => {} });
      }
    });

    it("tells the response pulls that responses may still be owed: one alert, with counts, while production attempts are in flight or in the window; none when nothing is owed", async () => {
      const alerts: {
        alertCode: string;
        organizationId: string;
        payload: Record<string, unknown>;
      }[] = [];
      const deps = {
        db: tenantPool.db,
        alerts: { dispatch: async (a: (typeof alerts)[number]) => void alerts.push(a) },
        // a fixed day: the once-a-day memory keys on it
        now: () => new Date("2026-11-09T12:00:00Z"),
      };
      await reportRevokedResponsesPending(deps as never, { organizationId: REV_ORG_K });
      await reportRevokedResponsesPending(deps as never, { organizationId: REV_ORG_K }); // the same day: not again
      expect(alerts).toEqual([
        {
          alertCode: "m23.clearinghouse.revoked_responses_pending",
          severity: "warn",
          organizationId: REV_ORG_K,
          payload: { attemptsInFlight: 1, attemptsSentInWindow: 0 },
        },
      ]);
      // an org with nothing in flight or sent in the window says nothing
      alerts.length = 0;
      await reportRevokedResponsesPending(deps as never, { organizationId: REV_ORG_Q });
      expect(alerts).toEqual([]);
    });

    it("refuses a second revoke, a re-verification and an activation while the revocation stands (409 CLEARINGHOUSE_BAA_REVOKED)", async () => {
      const again = await revoke("rev-k", pinK, { reasonCode: "other", ticketRef: "SEC-43" });
      expect(again.statusCode).toBe(409);
      expect(errorCode(again)).toBe("CLEARINGHOUSE_BAA_REVOKED");
      const verify = await platformCall(
        "POST",
        "rev-k",
        "/baa/verify",
        { reason: REASON },
        { "if-match": `"${pinK}"` },
      );
      expect(verify.statusCode).toBe(409);
      expect(errorCode(verify)).toBe("CLEARINGHOUSE_BAA_REVOKED");
      const activate = await tenantCall("POST", REV_ORG_K, "/activate", {});
      expect(activate.statusCode).toBe(409);
      expect(errorCode(activate)).toBe("CLEARINGHOUSE_BAA_REVOKED");
      expect(await rowOf(REV_ORG_K)).toMatchObject({
        status: "verified",
        baa_verified_at: null,
        baa_revoked_ticket_ref: "SEC-42",
      });
      expect((await revokeAudits(REV_ORG_K)).filter((a) => a.outcome === "success")).toHaveLength(
        1,
      );
    });

    it("is refused to a tenant on every surface, and cannot be reached or read across tenants", async () => {
      // the tenant's own admin holds neither the platform key nor the platform_ops role; there is no tenant-lane route at all
      const asTenantAdmin = await server.inject({
        method: "POST",
        url: "/api/v1/platform/tenants/rev-l/clearinghouse/baa/revoke",
        headers: { ...tenantWrite(REV_ORG_L), "if-match": `"${pinL}"` },
        payload: REVOKE,
      });
      expect(asTenantAdmin.statusCode).toBe(403);
      const noRoute = await tenantCall("POST", REV_ORG_L, "/baa/revoke", REVOKE);
      expect(noRoute.statusCode).toBe(404);
      expect(await rowOf(REV_ORG_L)).toMatchObject({ status: "active", baa_revoked_at: null });

      // an operator revoke addressed at org L with org K's pin revokes nothing (the pin names K's record)
      const crossPin = await revoke("rev-l", pinK);
      expect(crossPin.statusCode).toBe(409);
      expect(errorCode(crossPin)).toBe("CLEARINGHOUSE_BAA_CHANGED");
      expect(await rowOf(REV_ORG_L)).toMatchObject({ status: "active", baa_revoked_at: null });

      // RLS on the real app role: org L's scope neither reads K's revoked columns nor writes them
      const seen = await asTenant<{ organization_id: string; baa_revoked_at: Date | null }>(
        REV_ORG_L,
        "SELECT organization_id, baa_revoked_at FROM tenant_clearinghouse_config",
      );
      expect(seen).toEqual([{ organization_id: REV_ORG_L, baa_revoked_at: null }]);
      expect(
        await asTenant(
          REV_ORG_L,
          `UPDATE tenant_clearinghouse_config SET baa_revoked_reason_code='other' WHERE organization_id='${REV_ORG_K}' RETURNING id`,
        ),
      ).toHaveLength(0);
      expect((await rowOf(REV_ORG_K))?.baa_revoked_reason_code).toBe("vendor_terminated");
      // the tenant's own view of its row never carries the ticket
      expect(JSON.stringify(await tenantView(REV_ORG_L))).not.toContain("SEC-42");
    });

    it("the guard trigger refuses any other write of the revocation columns, as the app role and as a superuser alike; the service paths still work", async () => {
      // a plain UPDATE (no service setting) of any guarded column on the tenant's OWN row, as the real app role
      for (const set of [
        "baa_revoked_at = NULL, baa_revoked_by_membership_id = NULL, baa_revoked_reason_code = NULL, baa_revoked_ticket_ref = NULL",
        "baa_revoked_ticket_ref = 'ZZZ-1'",
        "baa_last_revoked_at = NULL, baa_last_revoked_document_ref = NULL, baa_revoked_at = NULL, baa_revoked_by_membership_id = NULL, baa_revoked_reason_code = NULL, baa_revoked_ticket_ref = NULL",
        "revoked_vendor_left_at = now()",
      ]) {
        await expect(
          asTenant(REV_ORG_K, `UPDATE tenant_clearinghouse_config SET ${set}`),
          set,
        ).rejects.toThrow(/written only by the config service/);
      }
      // ... and a tenant cannot revoke ITSELF with a plain UPDATE either (org L is live): the same refusal
      await expect(
        asTenant(
          REV_ORG_L,
          "UPDATE tenant_clearinghouse_config SET baa_verified_at = NULL, baa_verified_by_membership_id = NULL, status = 'verified', activated_at = NULL, activated_by_membership_id = NULL, baa_revoked_at = now(), baa_revoked_by_membership_id = baa_recorded_by_membership_id, baa_revoked_reason_code = 'other', baa_revoked_ticket_ref = 'SEC-1', baa_last_revoked_at = now(), baa_last_revoked_document_ref = baa_document_ref",
        ),
      ).rejects.toThrow(/written only by the config service/);
      // an INSERT may not carry them at all
      await expect(
        q(
          `INSERT INTO tenant_clearinghouse_config (organization_id, vendor, mode, status, baa_vendor, baa_effective_date, baa_document_ref,
             baa_recorded_at, baa_recorded_by_membership_id, baa_revoked_at, baa_revoked_by_membership_id, baa_revoked_reason_code,
             baa_revoked_ticket_ref, baa_last_revoked_at, baa_last_revoked_document_ref, set_by_membership_id)
           VALUES ($1,'stedi','test','draft','stedi','2026-01-01','BAA ref',now(),$2,now(),$2,'other','SEC-1',now(),'BAA ref',$2)`,
          [ORG_D, MEMBERSHIP],
        ),
      ).rejects.toThrow(/written only by the config service/);
      // a write that touches none of the guarded columns is not affected (a rotation / activation / BAA record all do this daily)
      expect(
        await asTenant(
          REV_ORG_K,
          "UPDATE tenant_clearinghouse_config SET updated_at = now() RETURNING id",
        ),
      ).toHaveLength(1);
      expect(await rowOf(REV_ORG_K)).toMatchObject({
        baa_revoked_reason_code: "vendor_terminated",
        baa_revoked_ticket_ref: "SEC-42",
      });
    });

    it("the table's CHECKs hold: a revoked row holds no verification, cannot be active, and is all-or-nothing with a closed code, a ticket and a record", async () => {
      const set = (sql: string) =>
        underGuard(`UPDATE tenant_clearinghouse_config SET ${sql} WHERE organization_id=$1`, [
          REV_ORG_L,
        ]);
      const voided =
        "baa_verified_at=NULL, baa_verified_by_membership_id=NULL, status='verified', activated_at=NULL, activated_by_membership_id=NULL";
      const revoked = (code: string, ticket: string, docRef = "'BAA ref'") =>
        `baa_revoked_at=now(), baa_revoked_by_membership_id='${MEMBERSHIP}', baa_revoked_reason_code='${code}', baa_revoked_ticket_ref='${ticket}', baa_last_revoked_at=now(), baa_last_revoked_document_ref=${docRef}`;
      // org L is active on a VERIFIED BAA: revoking it without voiding the verification is refused
      await expect(set(revoked("other", "SEC-1"))).rejects.toThrow(
        /tenant_clearinghouse_config_baa_revoked_unverified_ck/,
      );
      // all four or none
      await expect(set(`${voided}, baa_revoked_at=now()`)).rejects.toThrow(
        /tenant_clearinghouse_config_baa_revoked_ck/,
      );
      // a reason outside the closed set, and a ticket that is not a ticket (free text, lowercase, a sentence, too long)
      for (const [code, ticket] of [
        ["Vendor ended the BAA", "SEC-42"],
        ["terminated", "SEC-42"],
        ["other", "sec-42"],
        ["other", "SEC-42 John Smith DOB 04/12/1941"],
        ["other", "SEC42"],
        ["other", "ABCDEFGHIJK-1"],
        ["other", "SEC-123456789"],
      ] as const) {
        await expect(
          set(`${voided}, ${revoked(code, ticket)}`),
          `${code} / ${ticket}`,
        ).rejects.toThrow(/tenant_clearinghouse_config_baa_revoked_ck/);
      }
      // no record behind the revocation
      await expect(
        underGuard(
          `INSERT INTO tenant_clearinghouse_config (organization_id, vendor, mode, status, baa_revoked_at,
             baa_revoked_by_membership_id, baa_revoked_reason_code, baa_revoked_ticket_ref, baa_last_revoked_at,
             baa_last_revoked_document_ref, set_by_membership_id)
           VALUES ($1,'stedi','test','draft',now(),$2,'other','SEC-1',now(),'BAA ref',$2)`,
          [ORG_D, MEMBERSHIP],
        ),
      ).rejects.toThrow(/tenant_clearinghouse_config_baa_revoked_ck/);
      // the history: both or neither, and while revoked it names that revocation
      await expect(set(`${voided}, ${revoked("other", "SEC-1", "NULL")}`)).rejects.toThrow(
        /tenant_clearinghouse_config_baa_last_revoked_ck/,
      );
      await expect(set("baa_last_revoked_at=now()")).rejects.toThrow(
        /tenant_clearinghouse_config_baa_last_revoked_ck/,
      );
      // the revoked org K cannot be made active again behind the service's back: its BAA is not verified
      await expect(
        q(
          `UPDATE tenant_clearinghouse_config SET status='active', activated_at=now(), activated_by_membership_id=$2 WHERE organization_id=$1`,
          [REV_ORG_K, MEMBERSHIP],
        ),
      ).rejects.toThrow(/tenant_clearinghouse_config_active_baa_ck/);
      // nothing above changed a row
      expect(await rowOf(REV_ORG_L)).toMatchObject({ status: "active", baa_revoked_at: null });
      expect(await rowOf(REV_ORG_K)).toMatchObject({ status: "verified" });
    });

    it("the operator's own choice write stays onboarding-only: it cannot move a revoked live tenant off its vendor", async () => {
      const before = await rowOf(REV_ORG_K);
      const res = await platformCall(
        "PUT",
        "rev-k",
        "",
        { vendor: "outside", reason: REASON },
        { "if-match": `"${before?.version}"` },
      );
      expect(res.statusCode, res.body).toBe(409);
      expect(errorCode(res)).toBe("TENANT_NOT_ONBOARDING");
      expect(await rowOf(REV_ORG_K)).toEqual(before);
    });

    it("lock exception, end to end: a revoked BAA lets the TENANT leave for outside while a production claim is in flight; the same attempt locks a tenant whose BAA stands", async () => {
      // the control first: org L (BAA not revoked) with a production claim in flight is locked
      await attempt(REV_ORG_L, 2, "reserved", 0);
      const locked = await tenantCall(
        "PUT",
        REV_ORG_L,
        "",
        { vendor: "outside" },
        { "if-match": `"${(await rowOf(REV_ORG_L))?.version}"` },
      );
      expect(locked.statusCode, locked.body).toBe(409);
      expect(errorCode(locked)).toBe("CLEARINGHOUSE_VENDOR_LOCKED");
      expect((await rowOf(REV_ORG_L))?.vendor).toBe("claimmd");

      // org K (revoked, the same kind of attempt in flight) is not
      const left = await tenantCall(
        "PUT",
        REV_ORG_K,
        "",
        { vendor: "outside" },
        { "if-match": `"${(await rowOf(REV_ORG_K))?.version}"` },
      );
      expect(left.statusCode, left.body).toBe(200);
      expect(left.json()).toMatchObject({ vendor: "outside", status: "active", baa: null });
      expect(await rowOf(REV_ORG_K)).toMatchObject({
        vendor: "outside",
        status: "active",
        baa_recorded_at: null,
        baa_revoked_at: null,
        baa_revoked_reason_code: null,
        baa_revoked_ticket_ref: null,
        // the history and the departure survive the voiding of the record and the revocation
        baa_last_revoked_document_ref: BAA.documentRef,
      });
      expect((await rowOf(REV_ORG_K))?.revoked_vendor_left_at).toBeInstanceOf(Date);
      // the tenant's own field-level audit row says the lock was set aside because the BAA is revoked, and names no ticket
      const [exceptionAudit] = await q<{ context: Record<string, unknown> }>(
        `SELECT context FROM audit_event WHERE organization_id=$1 AND event_type='m23.tenant_clearinghouse.changed'
          ORDER BY created_at DESC LIMIT 1`,
        [REV_ORG_K],
      );
      expect(exceptionAudit?.context).toMatchObject({ revokedBaaLockException: true });
      expect(JSON.stringify(exceptionAudit)).not.toContain("SEC-42");
      // an outside tenant sends nothing through a vendor: the gate says so
      expect(await claimsBillingVerdict(REV_ORG_K, {})).toEqual({
        allow: false,
        reason: "clearinghouse_outside",
      });
    });

    it("lock exception: an attempt sent yesterday does not hold a revoked tenant on its vendor either; it leaves for Stedi, and the vendor it left no longer locks its next move (A -> B -> C)", async () => {
      const { pin } = await goLive(REV_ORG_M, "rev-m");
      await attempt(REV_ORG_M, 3, "sent", 1);
      expect((await revoke("rev-m", pin)).statusCode).toBe(200);

      const left = await tenantCall(
        "PUT",
        REV_ORG_M,
        "",
        { vendor: "stedi", mode: "production", secret: "fake-stedi-key-M-revoke-live" },
        { "if-match": `"${(await rowOf(REV_ORG_M))?.version}"` },
      );
      expect(left.statusCode, left.body).toBe(200);
      expect(left.json()).toMatchObject({ vendor: "stedi", status: "draft", baa: null });
      expect(await rowOf(REV_ORG_M)).toMatchObject({
        vendor: "stedi",
        baa_recorded_at: null,
        baa_revoked_at: null,
        baa_revoked_ticket_ref: null,
      });

      // the tenant picked the wrong B: A's attempt (sent yesterday, inside the 90-day window) must not lock it for 90 days
      const moved = await tenantCall(
        "PUT",
        REV_ORG_M,
        "",
        { vendor: "claimmd", mode: "production", secret: "fake-claimmd-key-M-C#revoke-live" },
        { "if-match": `"${(await rowOf(REV_ORG_M))?.version}"` },
      );
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json()).toMatchObject({ vendor: "claimmd", status: "draft" });
    });

    it("A -> B -> outside: the tenant that left a revoked vendor can bill outside ChartWarden; but B's OWN production traffic locks B as ever", async () => {
      const { pin } = await goLive(REV_ORG_O, "rev-o");
      await attemptAt(REV_ORG_O, 5, "reserved", new Date(Date.now() - 3_600_000)); // A's claim, in flight when the BAA is revoked
      expect((await revoke("rev-o", pin)).statusCode).toBe(200);
      const toB = await tenantCall(
        "PUT",
        REV_ORG_O,
        "",
        { vendor: "stedi", mode: "production", secret: "fake-stedi-key-O-revoke-live" },
        { "if-match": `"${(await rowOf(REV_ORG_O))?.version}"` },
      );
      expect(toB.statusCode, toB.body).toBe(200);

      // B sends a production claim of its own AFTER the departure: it locks B (the exception ended with A)
      await attemptAt(REV_ORG_O, 6, "reserved", new Date(Date.now() + 60_000));
      const locked = await tenantCall(
        "PUT",
        REV_ORG_O,
        "",
        { vendor: "outside" },
        { "if-match": `"${(await rowOf(REV_ORG_O))?.version}"` },
      );
      expect(locked.statusCode, locked.body).toBe(409);
      expect(errorCode(locked)).toBe("CLEARINGHOUSE_VENDOR_LOCKED");

      // B's claim finishes (released): only A's old attempt remains in the window, and that one is set aside
      await q(
        "UPDATE clearinghouse_submission_attempt SET status='released' WHERE organization_id=$1 AND idempotency_key='k-revoke-6'",
        [REV_ORG_O],
      );
      const out = await tenantCall(
        "PUT",
        REV_ORG_O,
        "",
        { vendor: "outside" },
        { "if-match": `"${(await rowOf(REV_ORG_O))?.version}"` },
      );
      expect(out.statusCode, out.body).toBe(200);
      expect(out.json()).toMatchObject({ vendor: "outside", status: "active" });
    });

    it("recording a new BAA clears the revocation but keeps the history: the operator must acknowledge verifying the same ended document, and the audit row records it", async () => {
      const { pin } = await goLive(REV_ORG_N, "rev-n");
      await attempt(REV_ORG_N, 4, "reserved", 0);
      expect((await revoke("rev-n", pin)).statusCode).toBe(200);

      const recorded = await tenantCall("POST", REV_ORG_N, "/baa", BAA); // the identical document: still a new statement
      expect(recorded.statusCode, recorded.body).toBe(200);
      expect(recorded.json()).toMatchObject({
        status: "verified",
        baa: { revoked: false, revokedAt: null, revokedReasonCode: null, verified: null },
      });
      expect(await rowOf(REV_ORG_N)).toMatchObject({
        baa_revoked_at: null,
        baa_revoked_reason_code: null,
        baa_revoked_ticket_ref: null,
        baa_revoked_by_membership_id: null,
        baa_verified_at: null,
        // the history survives the re-record
        baa_last_revoked_document_ref: BAA.documentRef,
      });
      expect((await rowOf(REV_ORG_N))?.baa_last_revoked_at).toBeInstanceOf(Date);
      // the tenant's view shows none of it; the platform view says the document was revoked before
      expect(JSON.stringify(recorded.json())).not.toContain("previousRevocation");
      const platform = await platformView("rev-n");
      expect(platform.baa?.previousRevocation).toMatchObject({ sameDocument: true });
      const [baaAudit] = await q<{ context: Record<string, unknown> }>(
        `SELECT context FROM audit_event WHERE organization_id=$1 AND event_type='m23.tenant_clearinghouse.baa_recorded'
          ORDER BY created_at DESC LIMIT 1`,
        [REV_ORG_N],
      );
      expect(baaAudit?.context).toMatchObject({ changedFields: ["baa", "baaRevocation"] });

      // not revoked any more, the traffic locks the vendor again
      const locked = await tenantCall(
        "PUT",
        REV_ORG_N,
        "",
        { vendor: "outside" },
        { "if-match": `"${(await rowOf(REV_ORG_N))?.version}"` },
      );
      expect(locked.statusCode, locked.body).toBe(409);
      expect(errorCode(locked)).toBe("CLEARINGHOUSE_VENDOR_LOCKED");

      // the operator may verify the new record only knowingly: 409 without the acknowledgement, and the record stays unverified
      const newPin = (recorded.json() as View).baa?.recordedAt as string;
      const unacknowledged = await platformCall(
        "POST",
        "rev-n",
        "/baa/verify",
        { reason: REASON },
        { "if-match": `"${newPin}"` },
      );
      expect(unacknowledged.statusCode, unacknowledged.body).toBe(409);
      expect(errorCode(unacknowledged)).toBe("CLEARINGHOUSE_BAA_PREVIOUSLY_REVOKED");
      expect((await rowOf(REV_ORG_N))?.baa_verified_at).toBeNull();
      const verified = await platformCall(
        "POST",
        "rev-n",
        "/baa/verify",
        { reason: REASON, acknowledgePreviousRevocation: true },
        { "if-match": `"${newPin}"` },
      );
      expect(verified.statusCode, verified.body).toBe(200);
      const [verifyAudit] = await q<{ context: Record<string, unknown> }>(
        `SELECT context FROM audit_event WHERE organization_id=$1 AND event_type='m34.tenant_onboarding.clearinghouse_baa_verified'
          ORDER BY created_at DESC LIMIT 1`,
        [REV_ORG_N],
      );
      expect(verifyAudit?.context).toMatchObject({
        supersededRevocation: true,
        previousRevocationAt: expect.any(String),
      });
      // the new agreement goes live only after the tenant activates it
      expect((await tenantCall("POST", REV_ORG_N, "/activate", {})).statusCode).toBe(200);
      expect(await rowOf(REV_ORG_N)).toMatchObject({ status: "active", baa_revoked_at: null });
    });

    it("the kill switch does not depend on the credential: a row sealed before migration 1434 (no fingerprint) is revoked without the KEK, dropping the credential with the BAA", async () => {
      // the pre-1434 shape: sealed, never fingerprinted. 1435's CHECK is NOT VALID for old rows; a new row cannot be written that way, so
      // the constraint is dropped for the seed and put back exactly as 1435 made it.
      await admin.query(
        "ALTER TABLE tenant_clearinghouse_config DROP CONSTRAINT tenant_clearinghouse_config_fingerprint_secret_ck",
      );
      try {
        await q(
          `INSERT INTO tenant_clearinghouse_config (organization_id, vendor, mode, status, secret_cipher, secret_dek_version,
             verification_kind, verified_at, verified_by_membership_id, activated_at, activated_by_membership_id, set_by_membership_id,
             baa_vendor, baa_effective_date, baa_document_ref, baa_recorded_at, baa_recorded_by_membership_id, baa_verified_at,
             baa_verified_by_membership_id)
           VALUES ($1,'claimmd','production','active',$2,1,'attested',now(),$3,now(),$3,$3,'claimmd','2026-01-01','Legacy BAA ref',now(),$3,now(),$3)`,
          [
            REV_ORG_P,
            (
              await cipher.encrypt(REV_ORG_P, keyOf("rev-p"), {
                vendor: "claimmd",
                mode: "production",
              })
            ).cipher,
            MEMBERSHIP,
          ],
        );
      } finally {
        await admin.query(
          `ALTER TABLE tenant_clearinghouse_config ADD CONSTRAINT tenant_clearinghouse_config_fingerprint_secret_ck
             CHECK (("secret_cipher" IS NULL) = ("credential_fingerprint" IS NULL)) NOT VALID`,
        );
      }
      const before = await platformView("rev-p");
      expect(before).toMatchObject({ status: "active", hasSecret: true });
      // any ordinary write of that row would need the KEK to backfill the fingerprint: this very request is the proof that it does
      // not (the revoke below is the only write, and the app's cipher key is irrelevant to it)
      const res = await revoke("rev-p", before.baa?.recordedAt as string);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        status: "draft",
        hasSecret: false,
        baa: { revoked: true },
      });
      expect(await rowOf(REV_ORG_P)).toMatchObject({
        status: "draft",
        secret_cipher: null,
        activated_at: null,
        baa_revoked_reason_code: "vendor_terminated",
      });
      const [audit] = await revokeAudits(REV_ORG_P);
      expect(audit?.context).toMatchObject({ wasActive: true, credentialCleared: true });
    });

    it("the kill switch does not depend on the credential reservation: a row whose credential another organization now holds is revoked all the same", async () => {
      const { pin } = await goLive(REV_ORG_Q, "rev-q");
      const [held] = await q<{ credential_fingerprint: string }>(
        "SELECT credential_fingerprint FROM tenant_clearinghouse_config WHERE organization_id=$1",
        [REV_ORG_Q],
      );
      const fingerprint = held?.credential_fingerprint as string;
      // this org's reservation is gone and another organization took the credential: now any ordinary write of the row is refused ...
      await q("DELETE FROM tenant_clearinghouse_credential_reservation WHERE organization_id=$1", [
        REV_ORG_Q,
      ]);
      await q(
        `INSERT INTO tenant_clearinghouse_credential_reservation (organization_id, vendor, credential_fingerprint)
         VALUES ($1,'claimmd',$2)`,
        [ORG_A, fingerprint],
      );
      const ordinary = await tenantCall("POST", REV_ORG_Q, "/baa", {
        ...BAA,
        documentRef: "another agreement, contract folder 31",
      });
      expect(ordinary.statusCode, ordinary.body).toBe(409);
      expect(errorCode(ordinary)).toBe("CLEARINGHOUSE_ACCOUNT_IN_USE");

      // ... and the revoke is not
      const res = await revoke("rev-q", pin);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ status: "verified", baa: { revoked: true } });
      expect(await rowOf(REV_ORG_Q)).toMatchObject({
        baa_revoked_reason_code: "vendor_terminated",
      });
    });
  });
});
