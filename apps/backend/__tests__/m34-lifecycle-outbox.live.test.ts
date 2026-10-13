/**
 * #103/#205 — M34's suspend/reactivate/at_risk/offboard tenant-lifecycle transitions, LIVE Postgres.
 *
 * Found while investigating the M2 hard half (#205): `runSideEffects` (service-drizzle.ts) gated every
 * `outbox` side effect through a one-item `CATALOG_LIFECYCLE_EVENTS` Set containing only
 * `"m34.tenant.provisioned"` — every OTHER lifecycle transition's outbox effect (suspend/reactivate/
 * at_risk/offboard) was silently DROPPED, no error, no log. Underneath that: the pure kernel
 * (lifecycle-transition.ts) emitted `m34.tenant.suspended`, a name `events-by-m34.ts` has never
 * catalogued (the real wire name is `suspension_initiated`) — so even a correct payload would have been
 * refused outright by the real dispatcher. `session_cascade` (revoke every session bound to the tenant's
 * org) and `alert` (M36 notification) were declared `LifecycleSideEffect` kinds with NO executor
 * anywhere in the codebase, despite the transition's own code comment claiming "sessions terminated
 * immediately at transition".
 *
 * This suite drives `TenantPlatformRouteService.transitionStatus`/`.offboardTenant` — the real production
 * methods — over a real Postgres connection, with the real catalog-validating outbox publisher and a spy
 * `AlertEmitter`, and proves all four transitions now actually publish, revoke sessions, and alert.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m34:lifecycle-outbox:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import type { AlertEmitter } from "@wardenx/messaging";
import { registerPlatformJob } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildDrizzleTenantPlatformAbacResolver } from "../src/modules/34-saas-tenant-platform/abac-resolver-drizzle";
import { M34_OUTBOX_EVENTS } from "../src/modules/34-saas-tenant-platform/events-by-m34";
import {
  type DrizzleTenantPlatformDeps,
  createDrizzleTenantPlatformBackend,
} from "../src/modules/34-saas-tenant-platform/routes/platform/service-drizzle";
import { wireM34Tenancy } from "../src/modules/34-saas-tenant-platform/wiring";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111f2050201";
const TENANT_ACCOUNT_A = "55555555-5555-4555-8555-5555f2050205";
const ACTOR_MEMBERSHIP = "44444444-4444-4444-8444-4444f2050204";
const SESSION_USER = "66666666-6666-4666-8666-6666f2050206";
const PLATFORM_JOB_ID = "test-m34-lifecycle-outbox";

describe.skipIf(!DB_URL)("M34 lifecycle outbox — LIVE Postgres", () => {
  let admin: Client;
  let platformDb: ReturnType<typeof createDbClient>;
  const alertCalls: Array<{ orgId: string; eventType: string; severity: string }> = [];

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

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
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'f103-a','Alpha Hospice LLC','Alpha Hospice','active')`,
      [ORG_A],
    );
    await admin.query(
      `INSERT INTO tenant_account (id,organization_id,status,legal_business_name,billing_contact_email,breach_notification_email)
       VALUES ($1,$2,'active','Alpha Hospice LLC','billing@alpha.test','breach@alpha.test')`,
      [TENANT_ACCOUNT_A, ORG_A],
    );
    await admin.query(
      `INSERT INTO "user" (id,email,name) VALUES ($1,'f103@example.test','F103 User')`,
      [SESSION_USER],
    );
    registerPlatformJob(PLATFORM_JOB_ID);
    // Superuser (RLS-bypass) connection stands in for the separately-pooled platform credential
    // `withPlatformContext` expects — this suite exercises the lifecycle logic, not the grant profile.
    platformDb = createDbClient({ connectionString: DB_URL as string });
  }, 240_000);

  afterAll(async () => {
    await platformDb?.close();
    await admin?.end();
  });

  function boundSession(id: string) {
    return admin.query(
      `INSERT INTO "session" (id,user_id,active_organization_id,token,expires_at)
       VALUES ($1,$2,$3,$4, now() + interval '1 day')`,
      [id, SESSION_USER, ORG_A, `tok-${id}`],
    );
  }

  function service() {
    alertCalls.length = 0;
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M34_OUTBOX_EVENTS]));
    const outbox: DrizzleTenantPlatformDeps["outbox"] = {
      publish: (tx, input) => publisher.publish(tx, { ...input, callerModule: "m34" } as never),
    };
    const lifecycleAlerts: AlertEmitter = {
      async emit(orgId, input) {
        alertCalls.push({ orgId, eventType: input.eventType, severity: input.severity });
        return { alertId: `test-${alertCalls.length}`, resolvedRecipientCount: 0 };
      },
    };
    const deps: DrizzleTenantPlatformDeps = {
      platformDb: platformDb.db,
      enqueue: {
        async enqueue(queue, jobKey) {
          return { jobId: `${queue}-${jobKey}` };
        },
      },
      legalHoldClear: async () => true,
      invitationDelivery: {
        acceptBaseUrl: "http://localhost/tenant-invite",
        async send() {
          throw new Error("not used by this suite");
        },
      },
      provisionJobs: {
        async status() {
          throw new Error("not used by this suite");
        },
        async retry() {
          throw new Error("not used by this suite");
        },
      },
      auditBypass: async () => {},
      outbox,
      organizations: {
        async ensure() {
          throw new Error("not used by this suite");
        },
      },
      featureFlags: {
        async list() {
          throw new Error("not used by this suite");
        },
        async upsert() {
          throw new Error("not used by this suite");
        },
        async setKillSwitch() {
          throw new Error("not used by this suite");
        },
      },
      lifecycleAlerts,
      supportSessionPorts: {
        audit: { async emitCriticalAudit() {} },
        outbox: { async publish() {} },
        alerts: { async emitAlert() {} },
        now: () => new Date(),
      },
      platformJobId: PLATFORM_JOB_ID,
    };
    return createDrizzleTenantPlatformBackend(deps).service;
  }

  it("suspend: writes actorMembershipId on the ledger, revokes bound sessions, publishes suspension_initiated, alerts", async () => {
    await boundSession("m34-sess-1");

    const res = await service().transitionStatus("f103-a", ACTOR_MEMBERSHIP, {
      toStatus: "suspended",
      transitionReason: "non-payment 180d",
    });
    expect(res.status).toBe("suspended");

    const account = await admin.query("SELECT status FROM tenant_account WHERE id = $1", [
      TENANT_ACCOUNT_A,
    ]);
    expect(account.rows[0].status).toBe("suspended");

    const ledger = await admin.query(
      "SELECT actor_membership_id, from_status, to_status FROM tenant_account_status_event WHERE tenant_account_id = $1 ORDER BY occurred_at DESC LIMIT 1",
      [TENANT_ACCOUNT_A],
    );
    expect(ledger.rows[0]).toMatchObject({
      actor_membership_id: ACTOR_MEMBERSHIP,
      from_status: "active",
      to_status: "suspended",
    });

    const sessions = await admin.query('SELECT id FROM "session" WHERE id = $1', ["m34-sess-1"]);
    expect(sessions.rows).toHaveLength(0);

    const outbox = await admin.query(
      "SELECT event_type, payload FROM outbox_event WHERE aggregate_id = $1 AND event_type = 'm34.tenant.suspension_initiated'",
      [TENANT_ACCOUNT_A],
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].payload).toMatchObject({
      reason: "non-payment 180d",
      initiatedByMembershipId: ACTOR_MEMBERSHIP,
    });

    expect(alertCalls).toContainEqual(
      expect.objectContaining({
        orgId: ORG_A,
        eventType: "tenant.suspension_initiated",
        severity: "critical",
      }),
    );
  });

  it("reactivate: publishes m34.tenant.reactivated", async () => {
    const res = await service().transitionStatus("f103-a", ACTOR_MEMBERSHIP, {
      toStatus: "active",
      transitionReason: "cause resolved",
    });
    expect(res.status).toBe("active");

    const outbox = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id = $1 AND event_type = 'm34.tenant.reactivated'",
      [TENANT_ACCOUNT_A],
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].payload).toMatchObject({
      reason: "cause resolved",
      actorMembershipId: ACTOR_MEMBERSHIP,
    });
  });

  it("flagAtRisk: publishes m34.tenant.at_risk (warn, not critical)", async () => {
    await service().transitionStatus("f103-a", ACTOR_MEMBERSHIP, {
      toStatus: "at_risk",
      transitionReason: "no claim 60d",
    });

    const outbox = await admin.query(
      "SELECT id FROM outbox_event WHERE aggregate_id = $1 AND event_type = 'm34.tenant.at_risk'",
      [TENANT_ACCOUNT_A],
    );
    expect(outbox.rows).toHaveLength(1);
    expect(alertCalls).toContainEqual(
      expect.objectContaining({ eventType: "tenant.at_risk_flagged", severity: "warn" }),
    );
  });

  it("offboard: from at_risk, revokes sessions, publishes offboarding_initiated with purpose", async () => {
    await boundSession("m34-sess-2");

    const res = await service().offboardTenant("f103-a", ACTOR_MEMBERSHIP, {
      transitionReason: "customer migrating away",
      exportPurpose: "migration",
    });
    expect(res.status).toBe("offboarding_initiated");

    const sessions = await admin.query('SELECT id FROM "session" WHERE id = $1', ["m34-sess-2"]);
    expect(sessions.rows).toHaveLength(0);

    const outbox = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id = $1 AND event_type = 'm34.tenant.offboarding_initiated'",
      [TENANT_ACCOUNT_A],
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].payload).toMatchObject({
      purpose: "migration",
      initiatedByMembershipId: ACTOR_MEMBERSHIP,
    });
  });

  // GAP-098 — the Drizzle TenantPlatformAbacResolver over real rows. The superuser handle stands in for both
  // pools (this suite proves the fact queries and the active/expired/revoked logic, not the role grants).
  it("abac resolver: reads a live consent grant and an open support session; revoked/expired deny", async () => {
    wireM34Tenancy();
    const grantor = "77777777-7777-4777-8777-7777f2098001";
    const operator = "77777777-7777-4777-8777-7777f2098002";
    const grantId = "88888888-8888-4888-8888-8888f2098001";
    await admin.query(
      `INSERT INTO support_consent_grant (id,organization_id,tenant_account_id,scope,grant_reason,grantor_membership_id,expires_at)
       VALUES ($1,$2,$3,'organization_scoped','abac live',$4, now() + interval '1 hour')`,
      [grantId, ORG_A, TENANT_ACCOUNT_A, grantor],
    );
    await admin.query(
      `INSERT INTO support_session (organization_id,support_consent_grant_id,actor_membership_id,expires_at)
       VALUES ($1,$2,$3, now() + interval '1 hour')`,
      [ORG_A, grantId, operator],
    );
    const resolver = buildDrizzleTenantPlatformAbacResolver({
      db: platformDb.db,
      platformDb: platformDb.db,
      auditBypass: async () => {},
      loadFlagRows: async () => [],
    });
    const platformOrg = "99999999-9999-4999-8999-9999f2098000";

    const grant = await resolver.loadConsentGrant(platformOrg, grantId);
    expect(grant).toMatchObject({ active: true, grantorMembershipId: grantor });
    expect(
      await resolver.hasActiveConsentedSupportSession({
        organizationId: platformOrg,
        tenantAccountId: TENANT_ACCOUNT_A,
        actorMembershipId: operator,
      }),
    ).toBe(true);
    expect(
      await resolver.hasActiveConsentedSupportSession({
        organizationId: platformOrg,
        tenantAccountId: TENANT_ACCOUNT_A,
        actorMembershipId: grantor,
      }),
    ).toBe(false);

    await admin.query("UPDATE support_consent_grant SET revoked_at = now() WHERE id = $1", [
      grantId,
    ]);
    expect((await resolver.loadConsentGrant(platformOrg, grantId))?.active).toBe(false);
    expect(
      await resolver.hasActiveConsentedSupportSession({
        organizationId: platformOrg,
        tenantAccountId: TENANT_ACCOUNT_A,
        actorMembershipId: operator,
      }),
    ).toBe(false);
    expect(
      await resolver.loadConsentGrant(platformOrg, "88888888-8888-4888-8888-8888f2098999"),
    ).toBeNull();
  });
});
