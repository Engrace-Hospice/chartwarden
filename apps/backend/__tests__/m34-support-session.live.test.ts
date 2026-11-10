/**
 * Slice 7 (7S) - the support session, end to end, LIVE Postgres, on the REAL roles.
 *
 * Why this suite exists. Reading the code said a support session could not work in production; reading the database said why
 * (the platform carrier could not INSERT a session, the ledger table had no partition to write into, the tenant role could rewrite
 * any session or forge any ledger row, the operator and the compliance officer held none of the permission keys the routes need).
 * Nothing here is a mock of those: the services run on the actual NOBYPASSRLS `chartwarden_app` role (the tenant lane) and on the
 * BYPASSRLS `chartwarden_platform_login` built by `scripts/db/provision-runtime-roles.ts` itself (the operator lane), through
 * real Fastify routes with the real guard chains, the real catalog-validating outbox publisher and the real audit writer. Only
 * the M36 emitter (a recording spy) and the help-request port (7B's, not in this tree: a fake) are stand-ins.
 *
 * Proves:
 *   - an HTTP start inserts the session, its `session.start` ledger row, a critical audit row and the outbox event in the TENANT's
 *     organization, and the tenant reads the session and its ledger under RLS (another tenant sees nothing);
 *   - the carrier can INSERT a session; the tenant role cannot, and its UPDATE and ledger INSERT are boxed to the revoke cascade;
 *   - the issue matrix (org_admin / compliance_officer may issue `assist`, nobody else; the existing scopes keep their rule; a
 *     confined organization may issue only `assist`);
 *   - the revoke cascade (sessions closed, ledger, outbox through the real publisher, grantor alert, the linked help request
 *     resolved, a later start refused 409, a repeated revoke idempotent) and the operator-side revoke on the carrier;
 *   - elevate refused on `assist`; the manual close; the expiry sweep on the grant's organization;
 *   - the ledger hook (one `ops.write` per successful non-GET while a session is open, none without one);
 *   - the operator is never named in anything the tenant reads; the person-level D16 refusal;
 *   - a start that races a revoke is closed by the revoke (the SHARE lock).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m34:support-session:live   (SUPERUSER url, THROWAWAY database)
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
  type LinkedHelpRequestPort,
  SupportRepository,
  startSupportSession,
} from "@chartwarden/saas-tenant-platform";
import {
  type PlatformBypassAuditor,
  registerPlatformJob,
  withOrgContext,
  withPlatformContext,
} from "@chartwarden/tenancy";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildDrizzleTenantPlatformAbacResolver } from "../src/modules/34-saas-tenant-platform/abac-resolver-drizzle";
import { M34_OUTBOX_EVENTS } from "../src/modules/34-saas-tenant-platform/events-by-m34";
import {
  buildTenantPlatformAbacPredicates,
  createDrizzleSupportLedgerRecorder,
  createSupportGrantOperationsOver,
  createSupportSessionPorts,
  mountTenantPlatformRoutes,
} from "../src/modules/34-saas-tenant-platform/index";
import {
  loadExpiredSessionCandidates,
  runSupportSessionCloseCron,
} from "../src/modules/34-saas-tenant-platform/jobs/platform-sweeps-worker";
import { createDrizzleTenantPlatformBackend } from "../src/modules/34-saas-tenant-platform/routes/platform/service-drizzle";
import { createDrizzleTenantBackend } from "../src/modules/34-saas-tenant-platform/routes/tenant/service-drizzle";
import { wireM34Tenancy } from "../src/modules/34-saas-tenant-platform/wiring";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const JOB_ID = "m34-support-session-live-test";
const PLATFORM_PASSWORD = "platform-live-password-1234";
const HOUR = 3_600_000;

// Organizations: the tenant under test, a second tenant (isolation), a confined (created) tenant, the operators' own.
const TENANT_ORG = "11111111-1111-4111-8111-1111f7500001";
const OTHER_ORG = "11111111-1111-4111-8111-1111f7500002";
const CONFINED_ORG = "11111111-1111-4111-8111-1111f7500003";
const OPERATOR_ORG = "11111111-1111-4111-8111-1111f7500009";
const TENANT_ACCOUNT = "55555555-5555-4555-8555-5555f7500001";
const OTHER_ACCOUNT = "55555555-5555-4555-8555-5555f7500002";
const CONFINED_ACCOUNT = "55555555-5555-4555-8555-5555f7500003";

interface Person {
  readonly user: string;
  readonly membership: string;
  readonly org: string;
  readonly roles: string;
}
const person = (n: number, org: string, roles: string): Person => ({
  user: `a0000000-0000-4000-8000-0000f75000${String(n).padStart(2, "0")}`,
  membership: `b0000000-0000-4000-8000-0000f75000${String(n).padStart(2, "0")}`,
  org,
  roles,
});
const ADMIN = person(1, TENANT_ORG, "org_admin");
const OFFICER = person(2, TENANT_ORG, "compliance_officer");
const ADMINISTRATOR = person(3, TENANT_ORG, "administrator");
const OTHER_ADMIN = person(4, OTHER_ORG, "org_admin");
const CONFINED_ADMIN = person(5, CONFINED_ORG, "org_admin");
const OPERATOR = person(6, OPERATOR_ORG, "platform_ops");
const OPERATOR_TWO = person(7, OPERATOR_ORG, "platform_ops");
// The same human holding a tenant seat: a different membership, the same user as OPERATOR.
const SAME_PERSON_SEAT = { ...person(8, TENANT_ORG, "org_admin"), user: OPERATOR.user };

const TENANT_KEYS = [
  "support_consent_grant.list_own",
  "support_consent_grant.issue",
  "support_consent_grant.revoke",
];
const OPS_KEYS = [
  "support_session.list_platform",
  "support_session.start",
  "support_session.close",
  "support_session.elevate_phi_read",
];

const headersOf = (p: Person, extra: Record<string, string> = {}): Record<string, string> => ({
  "x-test-user": p.user,
  "x-test-org": p.org,
  "x-test-membership": p.membership,
  "x-test-roles": p.roles,
  ...extra,
});
const FRESH = { "x-step-up": "fresh" };

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId = request.headers["x-test-membership"];
  if (request.headers["x-step-up"] === "fresh") request.context.attributes.stepUpRecent = true;
}

describe.skipIf(!DB_URL)("M34 support session, LIVE Postgres on the real roles", () => {
  let admin: Client;
  let platform: ReturnType<typeof createDbClient>;
  let app: ReturnType<typeof createDbClient>;
  let appUrl: string;
  let server: FastifyInstance;
  let clock = new Date();
  const alerts: { orgId: string; eventType: string; payload: Record<string, unknown> }[] = [];
  const warnings: { message: string; context: Record<string, unknown> }[] = [];
  const linked: Parameters<LinkedHelpRequestPort["resolveForRevokedGrant"]>[0][] = [];
  let ops: ReturnType<typeof createSupportGrantOperationsOver>;
  let ports: ReturnType<typeof createSupportSessionPorts>;

  const urlAs = (role: string, password: string): string => {
    const u = new URL(DB_URL as string);
    u.username = role;
    u.password = password;
    return u.toString();
  };
  const auditBypass: PlatformBypassAuditor<DbClient> = async (tx, event) => {
    await auditPlatformEvent(tx, {
      eventType: "platform.bypass_invoked",
      resourceKind: "tenant",
      outcome: "success",
      severity: event.severity,
      correlationId: `platform-bypass:${event.jobId}:${randomUUID()}`,
      context: { jobId: event.jobId, reason: event.reason },
    });
  };

  async function send(
    method: "GET" | "POST",
    url: string,
    headers: Record<string, string>,
    payload?: Record<string, unknown>,
  ) {
    const res = await server.inject({ method, url, headers, payload });
    return { statusCode: res.statusCode, body: res.json() as any, text: res.body };
  }

  const issue = (who: Person, scope: string, extra: Record<string, unknown> = {}) =>
    send("POST", "/api/v1/tenant/support-consent-grants", headersOf(who, FRESH), {
      scope,
      grantReason: "support for the billing set up of the agency",
      expiresAtIsoOffsetHours: 24,
      ...extra,
    });
  const start = (grantId: string, who: Person = OPERATOR) =>
    send("POST", "/api/v1/platform/support-sessions", headersOf(who, FRESH), {
      supportConsentGrantId: grantId,
    });
  const revoke = (who: Person, grantId: string) =>
    send("POST", `/api/v1/tenant/support-consent-grants/${grantId}/revoke`, headersOf(who), {
      revocationReason: "support is finished",
    });
  const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await admin.query(sql, params)).rows as T[];

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
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    // The REAL provisioning script, AFTER the migrations (so migration 1480's conditional carrier block ran with no carrier):
    // the script alone must give the carrier what a session needs, which is what a fresh production database relies on.
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

    for (const [org, slug, status] of [
      [TENANT_ORG, "s7s-tenant", "active"],
      [OTHER_ORG, "s7s-other", "active"],
      [CONFINED_ORG, "s7s-confined", "created"],
      [OPERATOR_ORG, "s7s-operators", "active"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$2,$2,$3)",
        [org, slug, status],
      );
    }
    for (const [id, org] of [
      [TENANT_ACCOUNT, TENANT_ORG],
      [OTHER_ACCOUNT, OTHER_ORG],
      [CONFINED_ACCOUNT, CONFINED_ORG],
    ] as const) {
      await admin.query(
        "INSERT INTO tenant_account (id, organization_id, status, legal_business_name, billing_contact_email, breach_notification_email) VALUES ($1,$2,'onboarding',$3,'b@x.test','p@x.test')",
        [id, org, `Tenant ${id}`],
      );
    }
    const people = [
      ADMIN,
      OFFICER,
      ADMINISTRATOR,
      OTHER_ADMIN,
      CONFINED_ADMIN,
      OPERATOR,
      OPERATOR_TWO,
    ];
    for (const p of people) {
      await admin.query(`INSERT INTO "user" (id,email,name) VALUES ($1,$2,$2)`, [
        p.user,
        `${p.user}@example.test`,
      ]);
      await admin.query(
        "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active')",
        [p.membership, p.user, p.org],
      );
    }
    // The same human as OPERATOR, holding a seat in the tenant (membership only: the user row exists).
    await admin.query(
      "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active')",
      [SAME_PERSON_SEAT.membership, SAME_PERSON_SEAT.user, SAME_PERSON_SEAT.org],
    );

    platform = createDbClient({
      connectionString: urlAs("chartwarden_platform_login", PLATFORM_PASSWORD),
    });
    appUrl = await appRoleConnectionString(admin, DB_URL as string);
    app = createDbClient({ connectionString: appUrl });
    registerPlatformJob(JOB_ID);
    // The ABAC resolver enters the platform context under M34's own job id, as the composition root registers it.
    wireM34Tenancy();

    // The ports and operations, bound exactly as the composition root binds them (real publisher, spy emitter).
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M34_OUTBOX_EVENTS]));
    const emitter: AlertEmitter = {
      async emit(orgId, input) {
        alerts.push({ orgId, eventType: input.eventType, payload: input.payload });
        return { alertId: `spy-${alerts.length}`, resolvedRecipientCount: 0 };
      },
    };
    ports = createSupportSessionPorts({
      outbox: {
        publish: (tx, input) => publisher.publish(tx, { ...input, callerModule: "m34" } as never),
      },
      alerts: emitter,
      now: () => clock,
      warn: (message, context) => warnings.push({ message, context }),
    });
    ops = createSupportGrantOperationsOver(ports);

    const platformBackend = createDrizzleTenantPlatformBackend({
      baaDocuments: { isFiled: async () => true },
      platformDb: platform.db,
      enqueue: { enqueue: async (queue, key) => ({ jobId: `${queue}-${key}` }) },
      provisionJobs: {
        status: async () => {
          throw new Error("not used by this suite");
        },
        retry: async () => {
          throw new Error("not used by this suite");
        },
      },
      invitationDelivery: {
        acceptBaseUrl: "http://localhost/tenant-invite",
        send: async () => {
          throw new Error("not used by this suite");
        },
      },
      legalHoldClear: async () => true,
      auditBypass,
      outbox: {
        publish: (tx, input) => publisher.publish(tx, { ...input, callerModule: "m34" } as never),
      },
      organizations: {
        ensure: async () => {
          throw new Error("not used by this suite");
        },
      },
      featureFlags: {
        list: async () => {
          throw new Error("not used by this suite");
        },
        upsert: async () => {
          throw new Error("not used by this suite");
        },
        setKillSwitch: async () => {
          throw new Error("not used by this suite");
        },
      },
      lifecycleAlerts: emitter,
      supportSessionPorts: ports,
      platformJobId: JOB_ID,
    });
    const tenantBackend = createDrizzleTenantBackend({
      db: app.db,
      enqueue: {
        enqueue: async () => {
          throw new Error("not used by this suite");
        },
      },
      presign: {
        presign: async () => {
          throw new Error("not used by this suite");
        },
      },
      now: () => clock,
      supportOps: ops,
      // 7B's table is not in this tree: the port a grant revoke hands the linked request to is a recording fake.
      linkedHelpRequestsFor: () => ({
        resolveForRevokedGrant: async (input) => {
          linked.push(input);
          return { helpRequestId: "70000000-0000-4000-8000-000000000001" };
        },
      }),
    });

    const grantFor = (org: string, user: string, keys: string[]) => ({
      orgId: org,
      userId: user,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: keys }],
    });
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        ...[ADMIN, OFFICER, ADMINISTRATOR, OTHER_ADMIN, CONFINED_ADMIN, SAME_PERSON_SEAT].map((p) =>
          grantFor(p.org, p.user, TENANT_KEYS),
        ),
        grantFor(OPERATOR.org, OPERATOR.user, OPS_KEYS),
        grantFor(OPERATOR_TWO.org, OPERATOR_TWO.user, OPS_KEYS),
      ]).store,
    );
    // The REAL ABAC resolver over the real platform and tenant pools: the distinct-actor and active-session predicates read the grant
    // and the sessions of a tenant the operator does not belong to, which only the platform pool can see.
    const resolver = buildDrizzleTenantPlatformAbacResolver({
      db: app.db,
      platformDb: platform.db,
      auditBypass,
      loadFlagRows: async () => [],
    });
    const reg = createPredicateRegistry();
    for (const [name, predicate] of Object.entries(
      buildTenantPlatformAbacPredicates({ resolver, isInCaseload: async () => false }),
    )) {
      reg.register(name, predicate);
    }
    reg.register("step_up_recent", async (c) => c.attributes.stepUpRecent === true);
    registerAbacRegistry(reg);

    server = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    mountTenantPlatformRoutes(server, {} as DbClient, {
      platform: platformBackend,
      tenant: tenantBackend,
      supportLedger: {
        recorder: createDrizzleSupportLedgerRecorder({
          platformDb: platform.db,
          auditBypass,
          platformJobId: JOB_ID,
          now: () => clock,
        }),
        warn: (message, context) => warnings.push({ message, context }),
      },
    });
    // A write under the covered prefix with no dependency of its own: the hook is what is under test.
    server.post("/api/v1/platform/tenants/:orgSlug/ledger-probe", async () => ({ ok: true }));
    server.get("/api/v1/platform/tenants/:orgSlug/ledger-probe", async () => ({ ok: true }));
  }, 600_000);

  afterAll(async () => {
    await server?.close();
    await platform?.close();
    await app?.close();
    await admin?.end();
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
  });

  // ── the database itself, as the real roles ───────────────────────────────────────────────────────────────

  describe("the roles", () => {
    async function asApp<T>(org: string, fn: (c: Client) => Promise<T>): Promise<T> {
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query("SELECT set_config('app.org_id', $1, false)", [org]);
        return await fn(c);
      } finally {
        await c.end();
      }
    }
    async function asCarrier<T>(fn: (c: Client) => Promise<T>): Promise<T> {
      const c = new Client({
        connectionString: urlAs("chartwarden_platform_login", PLATFORM_PASSWORD),
      });
      await c.connect();
      try {
        return await fn(c);
      } finally {
        await c.end();
      }
    }
    const grantRow = async (org: string, account: string, scope = "organization_scoped") =>
      (
        await q<{ id: string }>(
          `INSERT INTO support_consent_grant (organization_id,tenant_account_id,scope,grant_reason,grantor_membership_id,expires_at)
           VALUES ($1,$2,$3,'role probe grant for the live suite',$4, now() + interval '24 hours') RETURNING id`,
          [org, account, scope, ADMIN.membership],
        )
      )[0]?.id as string;
    const sessionRow = async (org: string, grantId: string) =>
      (
        await q<{ id: string }>(
          `INSERT INTO support_session (organization_id,support_consent_grant_id,actor_membership_id,expires_at)
           VALUES ($1,$2,$3, now() + interval '4 hours') RETURNING id`,
          [org, grantId, OPERATOR.membership],
        )
      )[0]?.id as string;

    afterAll(async () => {
      // The probes above leave sessions open; later tests count on the sessions THEY start being the only open ones.
      await q(
        "UPDATE support_session SET closed_at = now(), close_reason = 'manual' WHERE closed_at IS NULL",
      );
    });

    it("the ledger needs no per-organization partition: the migration's default partition takes every organization", async () => {
      const [{ n }] = await q<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'support_session_event'::regclass",
      );
      expect(n).toBe(1);
      const [row] = await q<{ relname: string }>(
        "SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'support_session_event'::regclass",
      );
      expect(row?.relname).toBe("support_session_event_default");
    });

    it("the carrier can INSERT a session in the tenant's organization and a ledger row of any kind", async () => {
      const grantId = await grantRow(TENANT_ORG, TENANT_ACCOUNT);
      await asCarrier(async (c) => {
        const s = await c.query(
          `INSERT INTO support_session (organization_id,support_consent_grant_id,actor_membership_id,expires_at)
           VALUES ($1,$2,$3, now() + interval '4 hours') RETURNING id`,
          [TENANT_ORG, grantId, OPERATOR.membership],
        );
        await c.query(
          "INSERT INTO support_session_event (organization_id,support_session_id,event_kind) VALUES ($1,$2,'ops.write')",
          [TENANT_ORG, s.rows[0].id],
        );
      });
    });

    it("the carrier's UPDATE is by column: it can close a session and revoke a grant, and nothing else", async () => {
      const grantId = await grantRow(TENANT_ORG, TENANT_ACCOUNT);
      const sessionId = await sessionRow(TENANT_ORG, grantId);
      await asCarrier(async (c) => {
        await expect(
          c.query(
            "UPDATE support_session SET expires_at = now() + interval '9 hours' WHERE id = $1",
            [sessionId],
          ),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          c.query(
            "UPDATE support_consent_grant SET expires_at = now() + interval '70 hours' WHERE id = $1",
            [grantId],
          ),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          c.query("UPDATE support_consent_grant SET scope = 'assist' WHERE id = $1", [grantId]),
        ).rejects.toMatchObject({ code: "42501" });
        expect(
          (
            await c.query(
              "UPDATE support_session SET closed_at = now(), close_reason = 'manual' WHERE id = $1",
              [sessionId],
            )
          ).rowCount,
        ).toBe(1);
        expect(
          (
            await c.query(
              "UPDATE support_consent_grant SET revoked_at = now(), revocation_reason = 'resolved' WHERE id = $1",
              [grantId],
            )
          ).rowCount,
        ).toBe(1);
      });
    });

    it("the tenant role cannot INSERT a session, rewrite a session or a grant, or forge an ops.write ledger row", async () => {
      const grantId = await grantRow(TENANT_ORG, TENANT_ACCOUNT);
      const sessionId = await sessionRow(TENANT_ORG, grantId);
      await asApp(TENANT_ORG, async (c) => {
        // no INSERT on the session table at all
        await expect(
          c.query(
            `INSERT INTO support_session (organization_id,support_consent_grant_id,actor_membership_id,expires_at)
             VALUES ($1,$2,$3, now() + interval '1 hour')`,
            [TENANT_ORG, grantId, OPERATOR.membership],
          ),
        ).rejects.toMatchObject({ code: "42501" });
        // column-level UPDATE: no expiry, no actor, no scope
        for (const sql of [
          "UPDATE support_session SET expires_at = now() + interval '9 hours' WHERE id = $1",
          "UPDATE support_session SET actor_membership_id = gen_random_uuid() WHERE id = $1",
        ]) {
          await expect(c.query(sql, [sessionId])).rejects.toMatchObject({ code: "42501" });
        }
        for (const sql of [
          "UPDATE support_consent_grant SET expires_at = now() + interval '70 hours' WHERE id = $1",
          "UPDATE support_consent_grant SET scope = 'assist' WHERE id = $1",
          "UPDATE support_consent_grant SET grantor_membership_id = gen_random_uuid() WHERE id = $1",
        ]) {
          await expect(c.query(sql, [grantId])).rejects.toMatchObject({ code: "42501" });
        }
        // the ledger: only the cascade's row, and never with a patient
        await expect(
          c.query(
            "INSERT INTO support_session_event (organization_id,support_session_id,event_kind) VALUES ($1,$2,'ops.write')",
            [TENANT_ORG, sessionId],
          ),
        ).rejects.toThrow(/row-level security/);
        await expect(
          c.query(
            "INSERT INTO support_session_event (organization_id,support_session_id,event_kind,patient_id) VALUES ($1,$2,'session.close',gen_random_uuid())",
            [TENANT_ORG, sessionId],
          ),
        ).rejects.toThrow(/row-level security/);
        await expect(
          c.query(
            "INSERT INTO support_session_event (organization_id,support_session_id,event_kind) VALUES ($1,$2,'session.close')",
            [OTHER_ORG, sessionId],
          ),
        ).rejects.toThrow(/row-level security/);
        expect(
          (
            await c.query(
              "INSERT INTO support_session_event (organization_id,support_session_id,event_kind) VALUES ($1,$2,'session.close')",
              [TENANT_ORG, sessionId],
            )
          ).rowCount,
        ).toBe(1);
      });
    });

    it("the tenant role may close an OPEN session of its own organization only as grant_revoked, and revoke an unrevoked grant once", async () => {
      const grantId = await grantRow(TENANT_ORG, TENANT_ACCOUNT);
      const sessionId = await sessionRow(TENANT_ORG, grantId);
      await asApp(TENANT_ORG, async (c) => {
        await expect(
          c.query(
            "UPDATE support_session SET closed_at = now(), close_reason = 'manual' WHERE id = $1",
            [sessionId],
          ),
        ).rejects.toThrow(/row-level security/);
        await expect(
          c.query(
            "UPDATE support_session SET closed_at = NULL, close_reason = 'grant_revoked' WHERE id = $1",
            [sessionId],
          ),
        ).rejects.toThrow(/row-level security/);
        expect(
          (
            await c.query(
              "UPDATE support_session SET closed_at = now(), close_reason = 'grant_revoked' WHERE id = $1",
              [sessionId],
            )
          ).rowCount,
        ).toBe(1);
        // closed: it can no longer be touched, in either direction
        expect(
          (await c.query("UPDATE support_session SET closed_at = NULL WHERE id = $1", [sessionId]))
            .rowCount,
        ).toBe(0);
        // a revoke must carry a reason; then it is final
        await expect(
          c.query("UPDATE support_consent_grant SET revoked_at = now() WHERE id = $1", [grantId]),
        ).rejects.toThrow(/row-level security/);
        expect(
          (
            await c.query(
              "UPDATE support_consent_grant SET revoked_at = now(), revocation_reason = 'done' WHERE id = $1",
              [grantId],
            )
          ).rowCount,
        ).toBe(1);
        expect(
          (
            await c.query(
              "UPDATE support_consent_grant SET revoked_at = now(), revocation_reason = 'again' WHERE id = $1",
              [grantId],
            )
          ).rowCount,
        ).toBe(0);
      });
    });

    it("the tenant role cannot read, close or revoke another organization's rows, and cannot insert a grant that is already revoked", async () => {
      const otherGrant = await grantRow(OTHER_ORG, OTHER_ACCOUNT);
      const otherSession = await sessionRow(OTHER_ORG, otherGrant);
      await asApp(TENANT_ORG, async (c) => {
        expect(
          (await c.query("SELECT 1 FROM support_session WHERE id = $1", [otherSession])).rowCount,
        ).toBe(0);
        expect(
          (await c.query("SELECT 1 FROM support_consent_grant WHERE id = $1", [otherGrant]))
            .rowCount,
        ).toBe(0);
        expect(
          (
            await c.query(
              "UPDATE support_session SET closed_at = now(), close_reason = 'grant_revoked' WHERE id = $1",
              [otherSession],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await c.query(
              "UPDATE support_consent_grant SET revoked_at = now(), revocation_reason = 'x' WHERE id = $1",
              [otherGrant],
            )
          ).rowCount,
        ).toBe(0);
        await expect(
          c.query(
            `INSERT INTO support_consent_grant (organization_id,tenant_account_id,scope,grant_reason,grantor_membership_id,expires_at,revoked_at,revocation_reason)
             VALUES ($1,$2,'organization_scoped','born revoked',$3, now() + interval '1 hour', now(), 'x')`,
            [TENANT_ORG, TENANT_ACCOUNT, ADMIN.membership],
          ),
        ).rejects.toThrow(/row-level security/);
        await expect(
          c.query(
            `INSERT INTO support_consent_grant (organization_id,tenant_account_id,scope,grant_reason,grantor_membership_id,expires_at)
             VALUES ($1,$2,'organization_scoped','another tenant',$3, now() + interval '1 hour')`,
            [OTHER_ORG, OTHER_ACCOUNT, ADMIN.membership],
          ),
        ).rejects.toThrow(/row-level security/);
      });
    });
  });

  // ── who may issue what ───────────────────────────────────────────────────────────────────────────────────

  describe("consent grant issue", () => {
    it("org_admin and compliance_officer may issue assist; no other role may (403 SUPPORT_GRANT_SCOPE_NOT_ALLOWED)", async () => {
      const byAdmin = await issue(ADMIN, "assist");
      expect(byAdmin.statusCode).toBe(201);
      expect(byAdmin.body).toMatchObject({ scope: "assist", active: true });
      const byOfficer = await issue(OFFICER, "assist");
      expect(byOfficer.statusCode).toBe(201);
      const refused = await issue(ADMINISTRATOR, "assist");
      expect(refused.statusCode).toBe(403);
      expect(refused.body.error.code).toBe("SUPPORT_GRANT_SCOPE_NOT_ALLOWED");
      const rows = await q(
        "SELECT scope, grantor_membership_id FROM support_consent_grant WHERE id = ANY($1::uuid[])",
        [[byAdmin.body.id, byOfficer.body.id]],
      );
      expect(rows.map((r) => r.scope)).toEqual(["assist", "assist"]);
      // assist expires inside 24 hours however long was asked (24 was asked here; 72 would also be clamped by the service)
      const long = await issue(ADMIN, "assist", { expiresAtIsoOffsetHours: 72 });
      expect(Date.parse(long.body.expiresAt) - Date.parse(long.body.issuedAt)).toBeLessThanOrEqual(
        24 * HOUR,
      );
    });

    it("the existing scopes keep their rule in an active organization: the key and the step-up, no role", async () => {
      for (const who of [ADMIN, OFFICER, ADMINISTRATOR]) {
        const res = await issue(who, "organization_scoped");
        expect(res.statusCode, who.roles).toBe(201);
      }
      const patientScoped = await issue(ADMIN, "patient_scoped", {
        patientIdsInScope: [randomUUID()],
      });
      expect(patientScoped.statusCode).toBe(201);
      // the table CHECK, answered 422 rather than a 500
      expect((await issue(ADMIN, "patient_scoped")).statusCode).toBe(422);
      expect((await issue(ADMIN, "assist", { patientIdsInScope: [randomUUID()] })).statusCode).toBe(
        422,
      );
    });

    it("a confined (not active) organization may issue ONLY assist", async () => {
      for (const scope of ["organization_scoped", "patient_scoped"]) {
        const res = await issue(
          CONFINED_ADMIN,
          scope,
          scope === "patient_scoped" ? { patientIdsInScope: [randomUUID()] } : {},
        );
        expect(res.statusCode, scope).toBe(403);
        expect(res.body.error.code).toBe("SUPPORT_GRANT_SCOPE_NOT_ALLOWED");
      }
      const assist = await issue(CONFINED_ADMIN, "assist");
      expect(assist.statusCode).toBe(201);
      const [row] = await q(
        "SELECT organization_id, scope FROM support_consent_grant WHERE id = $1",
        [assist.body.id],
      );
      expect(row).toMatchObject({ organization_id: CONFINED_ORG, scope: "assist" });
    });

    it("emits m34.support_consent_grant.issued through the real publisher and tells the operators", async () => {
      alerts.length = 0;
      const res = await issue(ADMIN, "assist");
      const [event] = await q(
        "SELECT organization_id, aggregate_kind, aggregate_id, payload FROM outbox_event WHERE event_type = 'm34.support_consent_grant.issued' AND aggregate_id = $1",
        [res.body.id],
      );
      expect(event).toMatchObject({
        organization_id: TENANT_ORG,
        aggregate_kind: "support_consent_grant",
      });
      expect(event?.payload).toMatchObject({
        grantId: res.body.id,
        tenantAccountId: TENANT_ACCOUNT,
        scope: "assist",
        helpRequestId: null,
      });
      expect(alerts.map((a) => [a.orgId, a.eventType])).toEqual([
        [TENANT_ORG, "m34.support_consent_grant.issued"],
      ]);
    });
  });

  // ── the session ──────────────────────────────────────────────────────────────────────────────────────────

  describe("start, read, elevate, ledger and close", () => {
    let grantId: string;
    let sessionId: string;
    let tenantReads = "";

    it("an HTTP start inserts the session, ledger row, critical audit and outbox event in the TENANT's organization", async () => {
      grantId = (await issue(ADMIN, "organization_scoped")).body.id;
      alerts.length = 0;
      const res = await start(grantId);
      expect(res.statusCode).toBe(201);
      sessionId = res.body.sessionId;
      const [session] = await q(
        "SELECT organization_id, actor_membership_id, closed_at, expires_at, started_at FROM support_session WHERE id = $1",
        [sessionId],
      );
      expect(session).toMatchObject({
        organization_id: TENANT_ORG,
        actor_membership_id: OPERATOR.membership,
        closed_at: null,
      });
      // the window is the earlier of 8 hours and the grant's expiry
      expect(
        new Date(session?.expires_at).getTime() - new Date(session?.started_at).getTime(),
      ).toBe(8 * HOUR);
      const [ledger] = await q(
        "SELECT organization_id, event_kind FROM support_session_event WHERE support_session_id = $1",
        [sessionId],
      );
      expect(ledger).toMatchObject({ organization_id: TENANT_ORG, event_kind: "session.start" });
      const [audit] = await q(
        "SELECT severity, context FROM audit_event WHERE event_type = 'support_session.started' AND resource_id = $1",
        [sessionId],
      );
      expect(audit?.severity).toBe("critical");
      expect(audit?.context).toMatchObject({
        organizationId: TENANT_ORG,
        actorKind: "platform_ops_via_support_session",
        supportSessionId: sessionId,
        supportConsentGrantId: grantId,
      });
      const [event] = await q(
        "SELECT organization_id, aggregate_kind, payload FROM outbox_event WHERE event_type = 'm34.support_session.started' AND aggregate_id = $1",
        [sessionId],
      );
      expect(event).toMatchObject({
        organization_id: TENANT_ORG,
        aggregate_kind: "support_session",
      });
      // the grantor alert, matched on the event type the seeded rules carry
      expect(alerts.map((a) => [a.orgId, a.eventType])).toEqual([
        [TENANT_ORG, "m34.support_session.started"],
      ]);
    });

    it("the tenant reads the session and its ledger under RLS; another tenant sees nothing of it", async () => {
      const list = await send("GET", "/api/v1/tenant/support-sessions", headersOf(ADMIN));
      expect(list.statusCode).toBe(200);
      const mine = list.body.items.find((s: { id: string }) => s.id === sessionId);
      expect(mine).toMatchObject({
        state: "open",
        closeReason: null,
        actionCount: 0,
        supportConsentGrantId: grantId,
      });
      const events = await send(
        "GET",
        `/api/v1/tenant/support-sessions/${sessionId}/events`,
        headersOf(ADMIN),
      );
      expect(events.statusCode).toBe(200);
      expect(events.body.items.map((e: { eventKind: string }) => e.eventKind)).toEqual([
        "session.start",
      ]);
      tenantReads += list.text + events.text;

      const theirs = await send("GET", "/api/v1/tenant/support-sessions", headersOf(OTHER_ADMIN));
      expect(theirs.body.items.some((s: { id: string }) => s.id === sessionId)).toBe(false);
      const theirEvents = await send(
        "GET",
        `/api/v1/tenant/support-sessions/${sessionId}/events`,
        headersOf(OTHER_ADMIN),
      );
      expect(theirEvents.statusCode).toBe(404);
      // and they cannot revoke the grant either
      expect((await revoke(OTHER_ADMIN, grantId)).statusCode).toBe(404);
      const [still] = await q("SELECT revoked_at FROM support_consent_grant WHERE id = $1", [
        grantId,
      ]);
      expect(still?.revoked_at).toBeNull();
    });

    it("refuses the same person under another seat (D16 at the person level), and records nothing", async () => {
      const seatGrant = await send(
        "POST",
        "/api/v1/tenant/support-consent-grants",
        headersOf(SAME_PERSON_SEAT, FRESH),
        {
          scope: "organization_scoped",
          grantReason: "support for the billing set up of the agency",
          expiresAtIsoOffsetHours: 4,
        },
      );
      expect(seatGrant.statusCode).toBe(201);
      const before = (await q<{ n: number }>("SELECT count(*)::int AS n FROM support_session"))[0]
        ?.n;
      const refused = await start(seatGrant.body.id);
      expect(refused.statusCode).toBe(403);
      expect(refused.body.error.code).toBe("SUPPORT_SESSION_ACTOR_NOT_DISTINCT");
      expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM support_session"))[0]?.n).toBe(
        before,
      );
    });

    it("refuses a start on an unknown grant and without a step-up", async () => {
      expect((await start(randomUUID())).statusCode).toBe(403); // the ABAC predicate cannot load the grant: deny
      const noStepUp = await send(
        "POST",
        "/api/v1/platform/support-sessions",
        headersOf(OPERATOR),
        {
          supportConsentGrantId: grantId,
        },
      );
      expect(noStepUp.statusCode).toBe(403);
      expect(noStepUp.body.error.code).toBe("STEP_UP_REQUIRED");
    });

    it("elevates a PHI-scoped session (ledger row) but refuses a session on an assist grant, 403 SUPPORT_SESSION_NON_PHI", async () => {
      const elevate = (id: string) =>
        send(
          "POST",
          `/api/v1/platform/support-sessions/${id}/elevate?tenantAccountId=${TENANT_ACCOUNT}`,
          headersOf(OPERATOR, FRESH),
          {},
        );
      const ok = await elevate(sessionId);
      expect(ok.statusCode).toBe(201);
      expect(
        (
          await q(
            "SELECT 1 FROM support_session_event WHERE support_session_id = $1 AND event_kind = 'session.elevate'",
            [sessionId],
          )
        ).length,
      ).toBe(1);

      const assistGrant = (await issue(ADMIN, "assist")).body.id;
      const assistSession = (await start(assistGrant)).body.sessionId;
      const refused = await elevate(assistSession);
      expect(refused.statusCode).toBe(403);
      expect(refused.body.error.code).toBe("SUPPORT_SESSION_NON_PHI");
      expect(
        (
          await q(
            "SELECT 1 FROM support_session_event WHERE support_session_id = $1 AND event_kind = 'session.elevate'",
            [assistSession],
          )
        ).length,
      ).toBe(0);
      await send(
        "POST",
        `/api/v1/platform/support-sessions/${assistSession}/close`,
        headersOf(OPERATOR),
        {},
      );
    });

    it("the ledger hook appends one ops.write per successful non-GET while the operator has an open session, and none otherwise", async () => {
      const probe = "/api/v1/platform/tenants/s7s-tenant/ledger-probe";
      const rows = () =>
        q(
          "SELECT context FROM support_session_event WHERE support_session_id = $1 AND event_kind = 'ops.write' ORDER BY occurred_at",
          [sessionId],
        );
      expect((await send("POST", probe, headersOf(OPERATOR), {})).statusCode).toBe(200);
      expect((await send("POST", probe, headersOf(OPERATOR), {})).statusCode).toBe(200);
      await send("GET", probe, headersOf(OPERATOR));
      // a different operator without a session on this tenant, and an unknown slug: nothing
      await send("POST", probe, headersOf(OPERATOR_TWO), {});
      await send(
        "POST",
        "/api/v1/platform/tenants/no-such-tenant/ledger-probe",
        headersOf(OPERATOR),
        {},
      );
      await new Promise((resolve) => setTimeout(resolve, 300)); // onResponse runs after the reply
      const written = await rows();
      expect(written, JSON.stringify(warnings)).toHaveLength(2);
      expect(written[0]?.context).toEqual({
        route: "/api/v1/platform/tenants/:orgSlug/ledger-probe",
        method: "POST",
        status: 200,
      });
      expect(JSON.stringify(written)).not.toContain("s7s-tenant");
      expect(warnings.filter((w) => w.message.startsWith("m34.support_ledger"))).toEqual([]);
    });

    it("the tenant sees the actions as route, method and status only, with the count the help screens summarise", async () => {
      const events = await send(
        "GET",
        `/api/v1/tenant/support-sessions/${sessionId}/events`,
        headersOf(ADMIN),
      );
      const writes = events.body.items.filter(
        (e: { eventKind: string }) => e.eventKind === "ops.write",
      );
      expect(writes).toHaveLength(2);
      expect(writes[0].detail).toEqual({
        route: "/api/v1/platform/tenants/:orgSlug/ledger-probe",
        method: "POST",
        status: 200,
      });
      expect(
        events.body.items.find((e: { eventKind: string }) => e.eventKind === "session.start")
          .detail,
      ).toBeNull();
      tenantReads += events.text;
      const list = await send("GET", "/api/v1/tenant/support-sessions", headersOf(ADMIN));
      expect(list.body.items.find((s: { id: string }) => s.id === sessionId)).toMatchObject({
        actionCount: 2,
      });
      tenantReads += list.text;
      // the summary 7B's help screens read, over the same rows under the tenant's own RLS
      const summary = await withOrgContext(
        app.db,
        { organizationId: TENANT_ORG, userId: ADMIN.user },
        (tx) => ops.sessionSummaryForGrant(tx as unknown as DbClient, grantId),
      );
      expect(summary).toMatchObject({
        sessionId,
        state: "open",
        actionCount: 2,
        closeReason: null,
      });
      expect(summary?.lastActionAt).toBeInstanceOf(Date);
    });

    it("the manual close stamps the session, writes the ledger, audit and outbox (manual_close), and the hook stops recording", async () => {
      alerts.length = 0;
      const res = await send(
        "POST",
        `/api/v1/platform/support-sessions/${sessionId}/close`,
        headersOf(OPERATOR),
        {},
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ sessionId, closeReason: "manual" });
      const [session] = await q(
        "SELECT closed_at, close_reason FROM support_session WHERE id = $1",
        [sessionId],
      );
      expect(session?.close_reason).toBe("manual");
      expect(session?.closed_at).not.toBeNull();
      const [closeRow] = await q(
        "SELECT organization_id, context FROM support_session_event WHERE support_session_id = $1 AND event_kind = 'session.close'",
        [sessionId],
      );
      expect(closeRow).toMatchObject({
        organization_id: TENANT_ORG,
        context: { closeReason: "manual" },
      });
      const [audit] = await q(
        "SELECT severity FROM audit_event WHERE event_type = 'support_session.closed' AND resource_id = $1",
        [sessionId],
      );
      expect(audit?.severity).toBe("critical");
      const [event] = await q(
        "SELECT organization_id, payload FROM outbox_event WHERE event_type = 'm34.support_session.expired' AND aggregate_id = $1",
        [sessionId],
      );
      expect(event).toMatchObject({ organization_id: TENANT_ORG });
      expect(event?.payload.closeReason).toBe("manual_close");
      expect(alerts.map((a) => a.eventType)).toEqual(["m34.support_session.expired"]);
      // the help screens' summary of the grant now reads closed, by hand, with the two actions it saw
      const summary = await withOrgContext(
        app.db,
        { organizationId: TENANT_ORG, userId: ADMIN.user },
        (tx) => ops.sessionSummaryForGrant(tx as unknown as DbClient, grantId),
      );
      expect(summary).toMatchObject({
        sessionId,
        state: "closed",
        closeReason: "manual",
        actionCount: 2,
      });
      // repeating it writes nothing more
      const again = await send(
        "POST",
        `/api/v1/platform/support-sessions/${sessionId}/close`,
        headersOf(OPERATOR),
        {},
      );
      expect(again.body).toEqual({ sessionId, closeReason: "manual" });
      expect(
        (
          await q(
            "SELECT 1 FROM support_session_event WHERE support_session_id = $1 AND event_kind = 'session.close'",
            [sessionId],
          )
        ).length,
      ).toBe(1);
      // no open session any more: a write on the tenant is not recorded
      await send(
        "POST",
        "/api/v1/platform/tenants/s7s-tenant/ledger-probe",
        headersOf(OPERATOR),
        {},
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(
        (
          await q(
            "SELECT 1 FROM support_session_event WHERE support_session_id = $1 AND event_kind = 'ops.write'",
            [sessionId],
          )
        ).length,
      ).toBe(2);
    });

    it("lists a tenant's grants for the operators' Start picker: the window, scope and state, never the grantor or the patients", async () => {
      const list = await send(
        "GET",
        `/api/v1/platform/support-consent-grants?tenantAccountId=${TENANT_ACCOUNT}&active=true`,
        headersOf(OPERATOR),
      );
      expect(list.statusCode).toBe(200);
      expect(list.body.items.length).toBeGreaterThan(0);
      expect(list.body.items.every((g: { active: boolean }) => g.active)).toBe(true);
      expect(
        list.body.items.some(
          (g: { id: string; scope: string }) =>
            g.id === grantId && g.scope === "organization_scoped",
        ),
      ).toBe(true);
      expect(list.text).not.toContain(ADMIN.membership);
      expect(list.text).not.toMatch(/grantor|patientIds/i);
      const revokedOnly = await send(
        "GET",
        `/api/v1/platform/support-consent-grants?tenantAccountId=${TENANT_ACCOUNT}&active=false`,
        headersOf(OPERATOR),
      );
      expect(revokedOnly.statusCode).toBe(200);
    });

    it("never names the operator, their user or their address anywhere the tenant reads", async () => {
      const grants = await send("GET", "/api/v1/tenant/support-consent-grants", headersOf(ADMIN));
      tenantReads += grants.text;
      for (const secret of [
        OPERATOR.membership,
        OPERATOR.user,
        OPERATOR_TWO.membership,
        "127.0.0.1",
      ]) {
        expect(tenantReads, secret).not.toContain(secret);
      }
      // nor in the alerts the tenant's members are shown
      expect(JSON.stringify(alerts)).not.toContain(OPERATOR.membership);
    });
  });

  // ── the revoke cascade ───────────────────────────────────────────────────────────────────────────────────

  describe("the revoke cascade", () => {
    it("closes every open session, writes ledger / audit / outbox through the real publisher, alerts, resolves the linked request, refuses a later start", async () => {
      const grantId = (await issue(ADMIN, "organization_scoped")).body.id;
      const a = (await start(grantId)).body.sessionId;
      const b = (await start(grantId)).body.sessionId;
      const closedAlready = (await start(grantId)).body.sessionId;
      await send(
        "POST",
        `/api/v1/platform/support-sessions/${closedAlready}/close`,
        headersOf(OPERATOR),
        {},
      );
      alerts.length = 0;
      linked.length = 0;

      const res = await revoke(OFFICER, grantId);
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ id: grantId, active: false });
      expect(res.body.revokedAt).not.toBeNull();

      const sessions = await q(
        "SELECT id, close_reason, closed_at FROM support_session WHERE id = ANY($1::uuid[]) ORDER BY id",
        [[a, b, closedAlready]],
      );
      const reasons = Object.fromEntries(sessions.map((s) => [s.id, s.close_reason]));
      expect(reasons[a]).toBe("grant_revoked");
      expect(reasons[b]).toBe("grant_revoked");
      expect(reasons[closedAlready]).toBe("manual"); // an ended session is never overwritten
      expect(sessions.every((s) => s.closed_at !== null)).toBe(true);

      const closes = await q(
        "SELECT organization_id, support_session_id, context FROM support_session_event WHERE event_kind = 'session.close' AND support_session_id = ANY($1::uuid[])",
        [[a, b]],
      );
      expect(closes).toHaveLength(2);
      expect(
        closes.every(
          (c) => c.organization_id === TENANT_ORG && c.context.closeReason === "grant_revoked",
        ),
      ).toBe(true);

      const expired = await q(
        "SELECT organization_id, payload FROM outbox_event WHERE event_type = 'm34.support_session.expired' AND aggregate_id = ANY($1::uuid[])",
        [[a, b]],
      );
      expect(expired).toHaveLength(2);
      expect(
        expired.every(
          (e) => e.organization_id === TENANT_ORG && e.payload.closeReason === "grant_revoked",
        ),
      ).toBe(true);
      const [revoked] = await q(
        "SELECT organization_id, aggregate_kind, payload FROM outbox_event WHERE event_type = 'm34.support_consent_grant.revoked' AND aggregate_id = $1",
        [grantId],
      );
      expect(revoked).toMatchObject({
        organization_id: TENANT_ORG,
        aggregate_kind: "support_consent_grant",
      });
      expect(revoked?.payload).toMatchObject({
        grantId,
        tenantAccountId: TENANT_ACCOUNT,
        closedSessionCount: 2,
      });
      const audits = await q(
        "SELECT context FROM audit_event WHERE event_type = 'support_session.grant_revoked' AND resource_id = ANY($1::uuid[])",
        [[a, b]],
      );
      expect(audits).toHaveLength(2);
      expect(audits[0]?.context).toMatchObject({
        closeReason: "grant_revoked",
        revokedBy: "tenant",
        organizationId: TENANT_ORG,
      });

      expect(alerts.filter((x) => x.eventType === "m34.support_session.expired")).toHaveLength(2);
      expect(linked).toEqual([
        {
          grantId,
          organizationId: TENANT_ORG,
          source: "tenant",
          closedByUserId: OFFICER.user,
          note: null,
        },
      ]);

      // a later start: refused 409. The ABAC predicate also sees the grant as inactive, so the platform answer is the guard's 403 or the
      // service's 409 depending on which sees it first; the service is the one this asserts, directly.
      const direct = await withPlatformContext(
        platform.db,
        { jobId: JOB_ID, reason: "test start on revoked grant", crossTenant: true },
        auditBypass,
        (tx) =>
          startSupportSession(ports.bind(tx), {
            supportConsentGrantId: grantId,
            actorMembershipId: OPERATOR.membership,
            actorUserId: OPERATOR.user,
          }).then(
            () => "started",
            (error: { code?: string; statusCode?: number }) => `${error.statusCode} ${error.code}`,
          ),
      );
      expect(direct).toBe("409 SUPPORT_GRANT_INACTIVE");
      expect((await start(grantId)).statusCode).toBeGreaterThanOrEqual(403);
      expect(
        (await q("SELECT 1 FROM support_session WHERE support_consent_grant_id = $1", [grantId]))
          .length,
      ).toBe(3);

      // a repeated revoke is idempotent: same grant, no second event, no second resolve of anything already closed
      const again = await revoke(OFFICER, grantId);
      expect(again.statusCode).toBe(200);
      expect(
        (
          await q(
            "SELECT 1 FROM outbox_event WHERE event_type = 'm34.support_consent_grant.revoked' AND aggregate_id = $1",
            [grantId],
          )
        ).length,
      ).toBe(1);
      const [grant] = await q(
        "SELECT revoked_by_membership_id, revocation_reason FROM support_consent_grant WHERE id = $1",
        [grantId],
      );
      expect(grant).toMatchObject({
        revoked_by_membership_id: OFFICER.membership,
        revocation_reason: "support is finished",
      });
    });

    it("an operator's Resolve revokes on the carrier: the grant's three columns and the sessions' two are all it needs", async () => {
      const grantId = (await issue(ADMIN, "assist")).body.id;
      const sessionId = (await start(grantId)).body.sessionId;
      const result = await withPlatformContext(
        platform.db,
        { jobId: JOB_ID, reason: "operator resolve", crossTenant: true },
        auditBypass,
        (tx) =>
          ops.revokeGrantAndCloseSessions(ops.depsFor(tx), {
            grantId,
            organizationId: TENANT_ORG,
            revokedByMembershipId: OPERATOR.membership,
            reason: "resolved by ChartWarden support",
            source: "platform_ops",
            closedByUserId: OPERATOR.user,
          }),
      );
      expect(result.closedSessionIds).toEqual([sessionId]);
      const [g] = await q(
        "SELECT revoked_by_membership_id FROM support_consent_grant WHERE id = $1",
        [grantId],
      );
      expect(g?.revoked_by_membership_id).toBe(OPERATOR.membership);
    });

    it("another organization cannot revoke this one's grant (404), and the grant is untouched", async () => {
      const grantId = (await issue(ADMIN, "organization_scoped")).body.id;
      const res = await revoke(OTHER_ADMIN, grantId);
      expect(res.statusCode).toBe(404);
      expect(
        (await q("SELECT revoked_at FROM support_consent_grant WHERE id = $1", [grantId]))[0]
          ?.revoked_at,
      ).toBeNull();
    });
  });

  // ── the sweep ────────────────────────────────────────────────────────────────────────────────────────────

  describe("the expiry sweep", () => {
    it("closes what is due, on the GRANT's organization (even for a row recorded under another one), through the shared ports", async () => {
      const grantId = (await issue(ADMIN, "organization_scoped")).body.id;
      const due = (await start(grantId)).body.sessionId;
      const later = (await start(grantId)).body.sessionId;
      // a legacy row recorded under the OPERATOR's organization (what the old route wrote): the sweep still answers in the tenant's
      const legacy = (
        await q<{ id: string }>(
          `INSERT INTO support_session (organization_id,support_consent_grant_id,actor_membership_id,started_at,expires_at)
           VALUES ($1,$2,$3, $4, $5) RETURNING id`,
          [
            OPERATOR_ORG,
            grantId,
            OPERATOR.membership,
            new Date(clock.getTime() - 3 * HOUR),
            new Date(clock.getTime() + HOUR),
          ],
        )
      )[0]?.id as string;
      // time passes: everything started above is past its 8 hours except what the next line keeps open
      await q("UPDATE support_session SET expires_at = $2 WHERE id = $1", [
        later,
        new Date(clock.getTime() + 20 * HOUR),
      ]);
      const before = clock;
      clock = new Date(before.getTime() + 9 * HOUR);
      try {
        alerts.length = 0;
        const result = await withPlatformContext(
          platform.db,
          { jobId: JOB_ID, reason: "test sweep", crossTenant: true },
          auditBypass,
          async (tx) =>
            runSupportSessionCloseCron({
              candidates: await loadExpiredSessionCandidates(tx, clock),
              serviceDeps: () => ports.bind(tx),
            }),
        );
        expect(result.closedSessionIds).toEqual(expect.arrayContaining([due, legacy]));
        expect(result.closedSessionIds).not.toContain(later);
        const rows = await q(
          "SELECT id, close_reason FROM support_session WHERE id = ANY($1::uuid[])",
          [[due, later, legacy]],
        );
        const byId = Object.fromEntries(rows.map((r) => [r.id, r.close_reason]));
        expect(byId[due]).toBe("expired");
        expect(byId[legacy]).toBe("expired");
        expect(byId[later]).toBeNull();
        const ledger = await q(
          "SELECT organization_id FROM support_session_event WHERE event_kind = 'session.close' AND support_session_id = ANY($1::uuid[])",
          [[due, legacy]],
        );
        expect(ledger.map((l) => l.organization_id)).toEqual([TENANT_ORG, TENANT_ORG]);
        const events = await q(
          "SELECT organization_id, payload FROM outbox_event WHERE event_type = 'm34.support_session.expired' AND aggregate_id = ANY($1::uuid[])",
          [[due, legacy]],
        );
        expect(
          events.every(
            (e) => e.organization_id === TENANT_ORG && e.payload.closeReason === "expired",
          ),
        ).toBe(true);
        // a second pass has nothing left to close
        const second = await withPlatformContext(
          platform.db,
          { jobId: JOB_ID, reason: "test sweep again", crossTenant: true },
          auditBypass,
          async (tx) =>
            runSupportSessionCloseCron({
              candidates: await loadExpiredSessionCandidates(tx, clock),
              serviceDeps: () => ports.bind(tx),
            }),
        );
        expect(second.closed).toBe(0);
      } finally {
        clock = before;
      }
    });
  });

  // ── a start that races a revoke ──────────────────────────────────────────────────────────────────────────

  describe("a start racing a revoke", () => {
    it("is closed by the revoke: the start's SHARE lock makes the revoke wait, and the revoke then sees the new session", async () => {
      const grantId = (await issue(ADMIN, "organization_scoped")).body.id;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let startedSession = "";
      let locked: () => void = () => undefined;
      const hasLock = new Promise<void>((resolve) => {
        locked = resolve;
      });
      // the operator's transaction: read the grant under the lock the service takes, hold it, insert the session, then commit
      const starting = withPlatformContext(
        platform.db,
        { jobId: JOB_ID, reason: "race start", crossTenant: true },
        auditBypass,
        async (tx) => {
          const repo = new SupportRepository(tx);
          const grant = await repo.findConsentGrantByIdForShare(grantId);
          expect(grant?.revokedAt).toBeNull();
          locked();
          await gate;
          const session = await repo.createSession({
            organizationId: TENANT_ORG,
            supportConsentGrantId: grantId,
            actorMembershipId: OPERATOR.membership,
            startedAt: clock,
            expiresAt: new Date(clock.getTime() + HOUR),
          });
          startedSession = session.id;
        },
      );
      await hasLock;
      let revokeSettled = false;
      const revoking = revoke(ADMIN, grantId).then((r) => {
        revokeSettled = true;
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(revokeSettled, "the revoke must wait for the start's lock").toBe(false);
      release();
      await starting;
      const res = await revoking;
      expect(res.statusCode).toBe(200);
      const [session] = await q("SELECT close_reason FROM support_session WHERE id = $1", [
        startedSession,
      ]);
      expect(session?.close_reason).toBe("grant_revoked");
    });
  });
});
