/**
 * CW-AC-46 follow-up — the professional-licence roster's write routes, LIVE Postgres as the real NOBYPASSRLS `chartwarden_app` role.
 *
 * `membership_credential` is the fact the visit-create credential gate trusts and the HOPE signer-licence check (CW-AC-46, #1206) reads, so
 * its grant and revoke routes need a fresh step-up and the grant refuses a licence recorded on the caller's own membership (the
 * route refuses and audits it, the credential store refuses it again as the backstop). Proves, against the real
 * route table, the real Authorization Contract, the real Drizzle credential store and real RLS:
 *
 *   · a self-grant is refused 403 CREDENTIAL_SELF_GRANT_REFUSED even with a fresh step-up: no row, and one
 *     `m17.credential.self_grant_refused` audit row with a closed context (ids and the discipline enum, nothing else);
 *   · a stale step-up is refused STEP_UP_REQUIRED on the grant and the revoke, and nothing is written or revoked;
 *   · another member's grant works: the row names the grantor and the M4 row trigger audits the insert;
 *   · a member can revoke their own licence;
 *   · cross-tenant isolation: another organization's administrator cannot record a licence on this organization's member (404,
 *     no row), cannot read this organization's roster, and this organization's refusal audit row is not visible to theirs;
 *   · the CW-MON-01 rule `privileged.credential_self_grant_attempt` fires on the refusal, read through the real review reader.
 *
 * The cases run in file order and share the rows earlier cases leave (the nurse's licence, the second administrator's grant, the
 * refusal audit rows); run the whole file, not one case with `-t`.
 *
 * Run on a PRIVATE container of production's Postgres image (never the shared cluster: the suite drops the app role):
 *   docker build -t chartwarden-postgres:dev deploy/production/postgres
 *   docker run -d --name cw-m17-cred -p 127.0.0.1:55917:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=chartwarden_test \
 *     chartwarden-postgres:dev -c max_locks_per_transaction=1024
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55917/chartwarden_test \
 *     bunx vitest run apps/backend/__tests__/m17-credential-grant.live.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  SECURITY_RULES,
  type SignalRule,
  evaluateSignalRules,
  readSignalEvents,
  signalEventTypes,
} from "@chartwarden/audit";
import {
  M3_INTRINSIC_PREDICATES,
  createInMemoryEffectivePermissionStore,
  createInMemorySessionContextStore,
  createPredicateRegistry,
  createSessionContextResolver,
  isStepUpRecent,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { STEP_UP_POLICY } from "@chartwarden/types";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest, getSeam, registerSeam } from "../src/bootstrap/seams/registry";
import {
  buildSchedulingAbacPredicates,
  createDbSchedulingBackend,
  registerSchedulingRoutes,
} from "../src/modules/17-scheduling/index";
import { createDrizzleCredentialStore } from "../src/modules/17-scheduling/seams/credentials-drizzle-store";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const SELF_GRANT_EVENT = "m17.credential.self_grant_refused";
const RULE_ID = "privileged.credential_self_grant_attempt";
const STALE_AT = new Date(Date.now() - 10 * 60 * 1000);
const CREDENTIAL_PERMS = [
  "membership_credential.read",
  "membership_credential.grant",
  "membership_credential.revoke",
];

interface Actor {
  readonly userId: string;
  readonly membershipId: string;
  readonly organizationId: string;
}

function stepUpRecentPredicate(context: {
  organizationId: string;
  attributes: Record<string, unknown>;
}) {
  const sessionId =
    typeof context.attributes.sessionId === "string" ? context.attributes.sessionId : null;
  if (!sessionId || !context.organizationId) return Promise.resolve(false);
  return getSeam("SessionContextResolver")
    .resolveStepUpState({ orgId: context.organizationId }, sessionId)
    .then((state) => isStepUpRecent(state, STEP_UP_POLICY, Date.now()));
}

const sessionOf = (actor: Actor, lastStepUpAt: Date | null) => ({
  sessionId: actor.userId,
  userId: actor.userId,
  membershipId: actor.membershipId,
  organizationId: actor.organizationId,
  roles: [],
  providerEntityIds: [],
  locationIds: [],
  lastStepUpAt,
  lastStepUpFactor: lastStepUpAt === null ? null : ("webauthn" as const),
  sessionClass: "staff",
  portalAccountId: null,
  sessionPatientId: null,
});

/** The request's session: user, membership and organization come from headers the test sets, as the real authenticate hook does from the session. */
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.sessionId = user;
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes.membershipId = membership;
  }
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = [];
}

const headersOf = (actor: Actor) => ({
  "x-test-user": actor.userId,
  "x-test-membership": actor.membershipId,
  "x-test-org": actor.organizationId,
  "idempotency-key": randomUUID(),
});

describe.skipIf(!DB_URL)(
  "CW-AC-46 follow-up — M17 credential grant guards — LIVE Postgres (chartwarden_app, NOBYPASSRLS)",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let orgA: string;
    let orgB: string;
    let admin1: Actor;
    let admin2: Actor;
    let nurse: Actor;
    let adminB: Actor;

    async function seedActor(organizationId: string, email: string): Promise<Actor> {
      const userId = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [email])
      ).rows[0].id as string;
      const membershipId = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [userId, organizationId],
        )
      ).rows[0].id as string;
      return { userId, membershipId, organizationId };
    }

    const rowsOf = async (text: string, params: unknown[]) =>
      (await admin.query(text, params)).rows as Record<string, unknown>[];
    const credentialRows = (membershipId: string) =>
      rowsOf(
        `SELECT id, organization_id, membership_id, credential_type, status, granted_by_membership_id, revoked_at
           FROM membership_credential WHERE membership_id = $1 ORDER BY created_at`,
        [membershipId],
      );
    const auditRows = (organizationId: string, eventType: string) =>
      rowsOf(
        `SELECT event_type, outcome, severity, retention_class, actor_user_id, resource_kind, resource_id, context
           FROM audit_event WHERE organization_id = $1 AND event_type = $2 ORDER BY created_at`,
        [organizationId, eventType],
      );

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetPublicSchema(admin);
      await dropLiveRoles(admin);
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      }
      orgA = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ('m17cred-a','M17 Cred A','M17 Cred A') RETURNING id",
        )
      ).rows[0].id as string;
      orgB = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ('m17cred-b','M17 Cred B','M17 Cred B') RETURNING id",
        )
      ).rows[0].id as string;
      admin1 = await seedActor(orgA, "m17cred-admin1@example.test");
      admin2 = await seedActor(orgA, "m17cred-admin2@example.test");
      nurse = await seedActor(orgA, "m17cred-nurse@example.test");
      adminB = await seedActor(orgB, "m17cred-adminb@example.test");
      handle = createDbClient({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
    }, 240_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    afterEach(() => {
      resetAuthorizationContract();
      resetRbacEngine();
      resetAbacRegistry();
    });

    /** The real route table over the real Drizzle backend; `fresh` lists who holds a fresh step-up (everyone else a stale one). */
    function bootApp(fresh: readonly Actor[]) {
      resetAuthorizationContract();
      resetRbacEngine();
      resetAbacRegistry();
      const holders = [admin1, admin2, adminB];
      registerEffectivePermissionResolver(
        createInMemoryEffectivePermissionStore(
          holders.map((a) => ({
            orgId: a.organizationId,
            userId: a.userId,
            grants: [
              {
                roleKey: "seed",
                enabled: true,
                expiresAt: null,
                permissionKeys: CREDENTIAL_PERMS,
              },
            ],
          })),
        ).store,
      );
      const backend = createDbSchedulingBackend(handle.db);
      const registry = createPredicateRegistry({
        ...M3_INTRINSIC_PREDICATES,
        step_up_recent: stepUpRecentPredicate,
      });
      for (const [name, fn] of Object.entries(
        buildSchedulingAbacPredicates({ resolver: backend }),
      )) {
        registry.register(name, fn);
      }
      registerAbacRegistry(registry);
      __resetSeamsForTest();
      const freshIds = new Set(fresh.map((a) => a.userId));
      registerSeam(
        "SessionContextResolver",
        createSessionContextResolver(
          createInMemorySessionContextStore(
            holders.map((a) => sessionOf(a, freshIds.has(a.userId) ? new Date() : STALE_AT)),
          ).store,
        ),
      );
      const app = buildServer({
        db: handle.db as never,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      registerSchedulingRoutes(app, { service: backend, caseloadPatientIds: async () => [] });
      return app;
    }

    const grantBody = { credentialType: "rn", effectiveAt: "2020-01-01", issuingBody: "Test Board" };
    const grantUrl = (membershipId: string) => `/api/v1/memberships/${membershipId}/credentials`;

    it("connects as the real NOBYPASSRLS application role", async () => {
      const [row] = (
        await handle.db.execute<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
          sql`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
        )
      ).rows;
      expect(row).toEqual({ rolname: "chartwarden_app", rolsuper: false, rolbypassrls: false });
    });

    it("another member's grant works: the row names the grantor and the row trigger audits the insert", async () => {
      const app = bootApp([admin1]);

      const res = await app.inject({
        method: "POST",
        url: grantUrl(nurse.membershipId),
        headers: headersOf(admin1),
        payload: grantBody,
      });

      expect(res.statusCode).toBe(201);
      const rows = await credentialRows(nurse.membershipId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organization_id: orgA,
        credential_type: "rn",
        status: "active",
        granted_by_membership_id: admin1.membershipId,
      });
      const trail = await auditRows(orgA, "membership_credential.insert");
      expect(trail.length).toBeGreaterThanOrEqual(1);
      await app.close();
    });

    it("refuses a self-grant 403 CREDENTIAL_SELF_GRANT_REFUSED with a fresh step-up: no row, one audit row with a closed context", async () => {
      const app = bootApp([admin1]);
      const before = (await auditRows(orgA, SELF_GRANT_EVENT)).length;

      const res = await app.inject({
        method: "POST",
        url: grantUrl(admin1.membershipId),
        headers: headersOf(admin1),
        payload: grantBody,
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error.code).toBe("CREDENTIAL_SELF_GRANT_REFUSED");
      expect(JSON.stringify(body)).not.toContain(admin1.membershipId);
      expect(await credentialRows(admin1.membershipId)).toEqual([]);
      const trail = await auditRows(orgA, SELF_GRANT_EVENT);
      expect(trail).toHaveLength(before + 1);
      const last = trail[trail.length - 1] as Record<string, unknown>;
      expect(last).toMatchObject({
        outcome: "denied",
        severity: "warn",
        retention_class: "compliance",
        actor_user_id: admin1.userId,
        resource_kind: "membership",
        resource_id: admin1.membershipId,
      });
      expect(Object.keys(last.context as object).sort()).toEqual([
        "credentialType",
        "denial",
        "membershipId",
      ]);
      expect(last.context).toMatchObject({
        denial: "CREDENTIAL_SELF_GRANT_REFUSED",
        membershipId: admin1.membershipId,
        credentialType: "rn",
      });
      await app.close();
    });

    it("replays the refusal under the same Idempotency-Key (it committed an audit row) and writes one audit row per key", async () => {
      const app = bootApp([admin1]);
      const headers = headersOf(admin1);
      const before = (await auditRows(orgA, SELF_GRANT_EVENT)).length;

      const first = await app.inject({
        method: "POST",
        url: grantUrl(admin1.membershipId),
        headers,
        payload: grantBody,
      });
      const retry = await app.inject({
        method: "POST",
        url: grantUrl(admin1.membershipId),
        headers,
        payload: grantBody,
      });

      expect(first.statusCode).toBe(403);
      expect(retry.statusCode).toBe(403);
      expect(retry.json().error.code).toBe("CREDENTIAL_SELF_GRANT_REFUSED");
      expect(await auditRows(orgA, SELF_GRANT_EVENT)).toHaveLength(before + 1);
      await app.close();
    });

    it("lets a second administrator record the first one's licence (a different member, no second approver)", async () => {
      const app = bootApp([admin2]);

      const res = await app.inject({
        method: "POST",
        url: grantUrl(admin1.membershipId),
        headers: headersOf(admin2),
        payload: grantBody,
      });

      expect(res.statusCode).toBe(201);
      const rows = await credentialRows(admin1.membershipId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ granted_by_membership_id: admin2.membershipId });
      await app.close();
    });

    it("refuses a stale step-up on the grant and on the revoke: nothing is written, nothing revoked", async () => {
      const app = bootApp([]);
      const [existing] = await credentialRows(nurse.membershipId);

      const grant = await app.inject({
        method: "POST",
        url: grantUrl(admin2.membershipId),
        headers: headersOf(admin1),
        payload: { ...grantBody, credentialType: "md" },
      });
      const revoke = await app.inject({
        method: "DELETE",
        url: `${grantUrl(nurse.membershipId)}/${existing?.id}`,
        headers: headersOf(admin1),
        payload: { reason: "licence lapsed" },
      });

      expect(grant.statusCode).toBe(403);
      expect(grant.json().error.code).toBe("STEP_UP_REQUIRED");
      expect(revoke.statusCode).toBe(403);
      expect(revoke.json().error.code).toBe("STEP_UP_REQUIRED");
      const nurseRows = await credentialRows(nurse.membershipId);
      expect(nurseRows[0]).toMatchObject({ status: "active", revoked_at: null });
      expect(await credentialRows(admin2.membershipId)).toEqual([]);
      await app.close();
    });

    it("cross-tenant: another organization's administrator can neither record nor read this organization's licences", async () => {
      const app = bootApp([adminB]);
      const nurseRowsBefore = await credentialRows(nurse.membershipId);

      const grant = await app.inject({
        method: "POST",
        url: grantUrl(nurse.membershipId),
        headers: headersOf(adminB),
        payload: { ...grantBody, credentialType: "np" },
      });
      const list = await app.inject({
        method: "GET",
        url: grantUrl(nurse.membershipId),
        headers: headersOf(adminB),
      });

      expect(grant.statusCode).toBe(404);
      expect(await credentialRows(nurse.membershipId)).toEqual(nurseRowsBefore);
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual([]);
      // the refusal audit rows of organization A are invisible to organization B's own review read
      const seenByB = await withOrgContext(
        handle.db,
        { organizationId: orgB, userId: adminB.membershipId },
        (tx) =>
          readSignalEvents(
            tx as never,
            { organizationId: orgB },
            {
              eventTypes: [SELF_GRANT_EVENT],
              from: new Date(Date.now() - 3_600_000),
              to: new Date(Date.now() + 60_000),
              limit: 100,
            },
          ),
      );
      expect(seenByB.events).toEqual([]);
      await app.close();
    });

    it("lets a member revoke their own licence", async () => {
      const app = bootApp([admin1]);
      const [own] = await credentialRows(admin1.membershipId);

      const res = await app.inject({
        method: "DELETE",
        url: `${grantUrl(admin1.membershipId)}/${own?.id}`,
        headers: headersOf(admin1),
        payload: { reason: "left the profession" },
      });

      expect(res.statusCode).toBe(204);
      expect((await credentialRows(admin1.membershipId))[0]).toMatchObject({ status: "revoked" });
      await app.close();
    });

    it("the credential store itself refuses a self-grant: the backstop under the route for any other caller", async () => {
      const store = createDrizzleCredentialStore(handle.db);

      await expect(
        store.grant(orgA, {
          membershipId: admin2.membershipId,
          grantedByMembershipId: admin2.membershipId,
          credentialType: "rn",
          effectiveAt: "2020-01-01",
        }),
      ).rejects.toMatchObject({ code: "CREDENTIAL_SELF_GRANT_REFUSED", statusCode: 403 });

      expect(await credentialRows(admin2.membershipId)).toEqual([]);
    });

    it("CW-MON-01: the refusal raises privileged.credential_self_grant_attempt through the real review reader", async () => {
      const rules = SECURITY_RULES.filter(
        (r): r is SignalRule => r.kind !== "bulk_access" && r.lane === "org",
      );
      const read = await withOrgContext(
        handle.db,
        { organizationId: orgA, userId: "" },
        (tx) =>
          readSignalEvents(
            tx as never,
            { organizationId: orgA },
            {
              eventTypes: signalEventTypes(rules),
              from: new Date(Date.now() - 3_600_000),
              to: new Date(Date.now() + 60_000),
              limit: 1000,
            },
          ),
      );

      const findings = evaluateSignalRules(rules, read.events, { organizationId: orgA }).filter(
        (f) => f.ruleId === RULE_ID,
      );

      expect(findings.length).toBeGreaterThanOrEqual(1);
      const refusalIds = new Set(
        read.events.filter((e) => e.eventType === SELF_GRANT_EVENT).map((e) => e.id),
      );
      for (const finding of findings) {
        expect(finding).toMatchObject({
          severity: "warn",
          lane: "org",
          organizationId: orgA,
          count: 1,
        });
        expect(finding.controls).toEqual(["CW-MON-01", "CW-AC-46"]);
        expect(refusalIds.has(finding.subject.ref)).toBe(true);
      }
    });
  },
);
