/**
 * M36 WP 5.9 (ADR-0084, PROPOSED) - workforce offboarding (Workflow F), LIVE Postgres as the NOBYPASSRLS `wardenx_app` role and a LIVE Valkey.
 *
 * The production composition, not a shim: REAL Better Auth sessions behind the REAL authenticate hook and DB permission resolver, the REAL
 * offboarding routes (permission, supervisor-reassign keys, fresh step-up), the REAL session revoke (ADR-0083), the REAL ack service and its
 * ADR-0078 supervisor reassign, the REAL task and handoff sweeps, the REAL alert emitter, the REAL catalog-validating outbox publisher.
 *
 *   1. PREVIEW     counts per item, nothing changes, one audit row; refused 403 without the key; a user who has not left is a 409.
 *   2. EXECUTE     Workflow F end to end for a departed user with an open ack request (reassigned, history names who/why), an open urgent
 *                  message (surfaced), a task and a handoff (moved), two sessions + push endpoints (revoked / expired, next REST call 401),
 *                  channel memberships ended, a scheduled send / reminder / snooze (removed, nothing sent as them), a draft (kept),
 *                  past messages (attribution kept), an on-call seat (advisory; M19 untouched).
 *   3. NO ELIGIBLE a request nobody can take stays assigned and visible in the supervisors' queue, one supervisor alert, needs_person.
 *   4. RE-RUN      a repeat changes nothing and notifies nobody again.
 *   5. RESUME      a step that fails once is `failed`, the others finish, and the next run finishes the remainder.
 *   6. ACCESS      no step-up, no key, no review key: refused and nothing changes; another tenant's officer gets the same 404 as an unknown id.
 *   7. AUDIT       the rows carry ids, fixed keys and counts only.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... WARDENX_TEST_REDIS_URL=redis://... bun run test:m36:workforce-offboarding:live
 * Use a PRIVATE pgvector/pgvector:pg18 container and a PRIVATE valkey/valkey:8: the suite resets the public schema and the wardenx_* roles.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  createCredentialThrottle,
  createDbActorEnrichmentReader,
  createDbSessionContextStore,
  createIdentityAuth,
  createInMemoryFailedLoginStore,
  createSessionContextResolver,
  getIdentitySession,
  registerDbEffectivePermissionResolver,
  registerIdentityAuth,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { createDbClient } from "@wardenx/db";
import {
  PLATFORM_DEFAULT_ALERT_RULES,
  createAlertEmitter,
  toNewAlertRuleRows,
} from "@wardenx/messaging";
import type { OffboardingDto, OffboardingItemKey } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrizzleFeatureFlagReader } from "../src/bootstrap/feature-flag-store";
import { buildServer, createSessionAuthenticate } from "../src/bootstrap/index";
import { createRealtimeEmitter, sessionRoom } from "../src/bootstrap/realtime";
import { wireModuleSeams } from "../src/index";
import { buildAckDeps } from "../src/modules/36-messaging/ack-requests/deps";
import { buildHandoffDeps } from "../src/modules/36-messaging/handoffs/deps";
import {
  createDrizzleAlertEmitterPorts,
  mountMessagingRoutes,
} from "../src/modules/36-messaging/index";
import { endChannelMembershipsForUser } from "../src/modules/36-messaging/messaging-provider-db";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { buildTaskDeps } from "../src/modules/36-messaging/tasks/deps";
import { appRoleConnectionString } from "./_live-app-role";
import { catalogOutbox } from "./_m36-handoff-live-kit";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const REDIS_URL = process.env.WARDENX_TEST_REDIS_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_platform_login",
  "wardenx_platform",
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "tenant_platform_writer",
];
const ORG = "33333333-3333-4333-8333-3333000a9501";
const ORG_2 = "44444444-4444-4444-8444-4444000a9502";
const ORIGIN = "http://localhost:3000";
const UA_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const UA_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const PUSH_1 = "https://push.example.test/sub/leaver-1-aaaaaaaaaaaa";
const PUSH_2 = "https://push.example.test/sub/leaver-2-bbbbbbbbbbbb";
const PUSH_OLD = "https://push.example.test/sub/leaver-old-cccccccccc";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a95a1";
const PATIENT_2 = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a95a2";
const PATIENT_3 = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a95a3";
const STAFF = ["messaging.read", "messaging.send", "patient.read", "notifications.endpoint.manage"];
const RECEIVE = [...STAFF, "messaging.urgent.receive"];
const SEND = [...STAFF, "messaging.urgent.send"];
const OFFICER_KEYS = [...STAFF, "messaging.review", "messaging.offboarding.manage"];

interface Login {
  readonly cookie: string;
  readonly csrf: string;
  readonly sessionId: string;
}
interface Person {
  readonly userId: string;
  readonly email: string;
  readonly password: string;
}

describe.skipIf(!DB_URL || !REDIS_URL)(
  "M36 WP 5.9 workforce offboarding (Workflow F), LIVE Postgres + Valkey",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let auth: ReturnType<typeof createIdentityAuth>;
    let app: FastifyInstance;
    let redis: Redis;
    const opsNotices: string[] = [];
    const failTasksOnce = { armed: false };

    let nurse: Person; // sends the requests, creates the task/handoff
    let rn: Person; // the eligible colleague
    let leaver: Person;
    let officer: Person;
    let noStepUp: Person;
    let noReview: Person;
    let plain: Person;
    let outsider: Person; // officer of ANOTHER tenant
    let officerLogin: Login;
    let leaverSessions: Login[] = [];
    let channel = "";
    let channel2 = "";
    let ackMoved = "";
    let ackStuck = "";
    let urgentMsg = "";
    let taskId = "";
    let handoffId = "";
    let pastMessage = "";

    const BASE = "/api/v1/messaging/governance/offboarding";

    async function seedPerson(
      label: string,
      org: string,
      permissionKeys: readonly string[],
    ): Promise<Person> {
      const email = `${label}-${randomUUID().slice(0, 8)}@wp59.test`;
      const password = `Wx9$${randomUUID()}Qz!`;
      await auth.api.signUpEmail({ body: { email, password, name: label } });
      const userId = (await admin.query(`SELECT id FROM "user" WHERE email=$1`, [email])).rows[0]
        .id as string;
      await admin.query(`UPDATE "user" SET status='active' WHERE id=$1`, [userId]);
      const membershipId = (
        await admin.query(
          "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
          [userId, org],
        )
      ).rows[0].id as string;
      const roleId = (
        await admin.query(
          "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,$2,$2,'clinical_staff',true) RETURNING id",
          [org, `r_${label}_${randomUUID().slice(0, 6)}`],
        )
      ).rows[0].id as string;
      for (const key of permissionKeys) {
        await admin.query(
          "INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,$3)",
          [org, roleId, key],
        );
      }
      await admin.query(
        "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
        [org, membershipId, roleId],
      );
      return { userId, email, password };
    }

    async function login(
      person: Person,
      org: string,
      userAgent: string,
      stepUp = false,
    ): Promise<Login> {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: ORIGIN, "user-agent": userAgent },
        payload: { email: person.email, password: person.password },
      });
      expect(res.statusCode).toBe(200);
      const sessionId = (
        await admin.query(
          "SELECT id FROM session WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
          [person.userId],
        )
      ).rows[0].id as string;
      await admin.query("UPDATE session SET active_organization_id=$1 WHERE id=$2", [
        org,
        sessionId,
      ]);
      if (stepUp) {
        await admin.query(
          "UPDATE session SET last_step_up_at=now(), last_step_up_factor='totp' WHERE id=$1",
          [sessionId],
        );
      }
      return {
        cookie: res.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        csrf: res.cookies.find((c) => c.name === "wardenx_csrf")?.value ?? "",
        sessionId,
      };
    }

    const call = (
      method: "GET" | "POST" | "DELETE",
      url: string,
      who: Login | null,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url,
        headers: {
          origin: ORIGIN,
          ...(who ? { cookie: who.cookie, "x-csrf-token": who.csrf } : {}),
        },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });

    const preview = (who: Login | null, userId: string) => call("GET", `${BASE}/${userId}`, who);
    const execute = (who: Login | null, userId: string) =>
      call("POST", `${BASE}/${userId}/execute`, who);
    const item = (dto: OffboardingDto, key: OffboardingItemKey) => {
      const found = dto.items.find((i) => i.key === key);
      if (!found) throw new Error(`missing item ${key}`);
      return found;
    };
    const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await admin.query(sql, params)).rows as T[];
    const count = async (sql: string, params: unknown[] = []) =>
      Number((await admin.query(sql, params)).rows[0]?.n ?? 0);

    async function message(author: string, ch: string, extra = ""): Promise<string> {
      const cols = extra === "" ? "" : `, ${extra.split("|")[0]}`;
      const vals = extra === "" ? "" : `, ${extra.split("|")[1]}`;
      return (
        await admin.query(
          `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256, body_kind${cols})
           VALUES ($1,$2,$3,'user','\\x01aa',repeat('0',64),'plain'${vals}) RETURNING id`,
          [ORG, ch, author],
        )
      ).rows[0].id as string;
    }

    async function channelOf(subject: string, members: readonly string[]): Promise<string> {
      const id = (
        await admin.query(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
           VALUES ($1,'care_team',$2,$3,'care_related') RETURNING id`,
          [ORG, subject, `wp59-${randomUUID().slice(0, 8)}`],
        )
      ).rows[0].id as string;
      for (const userId of members) {
        await admin.query(
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source) VALUES ($1,$2,$3,'member','manual')`,
          [ORG, id, userId],
        );
      }
      return id;
    }

    /** Everything a re-run must NOT change, as one comparable snapshot. */
    const footprint = async () => ({
      ackEvents: await count("SELECT count(*)::int AS n FROM message_acknowledgment_event"),
      outbox: await count(
        "SELECT count(*)::int AS n FROM outbox_event WHERE event_type LIKE 'm36.%'",
      ),
      alerts: await count("SELECT count(*)::int AS n FROM alert"),
      sessions: await count("SELECT count(*)::int AS n FROM session WHERE user_id=$1", [
        leaver.userId,
      ]),
      messages: await count("SELECT count(*)::int AS n FROM message"),
    });

    beforeAll(async () => {
      process.env.BETTER_AUTH_SECRET ??= "test-secret-at-least-32-characters-long-xx";
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
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'wp59a','wp59a','wp59a','active'),($2,'wp59b','wp59b','wp59b','active')",
        [ORG, ORG_2],
      );
      handle = createDbClient({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
      auth = createIdentityAuth(handle.db as never);
      redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: null });
      redis.on("error", () => {});

      resetAuthorizationContract();
      resetRbacEngine();
      resetAbacRegistry();
      registerDbEffectivePermissionResolver(handle.db as never);
      const store = createDbSessionContextStore(
        handle.db as never,
        createDbActorEnrichmentReader(handle.db as never),
      );
      wireModuleSeams({ sessionContextStore: store });
      const resolver = createSessionContextResolver(store);
      const service = createDbMessagingRouteService(handle.db, {
        outbox: catalogOutbox() as never,
        part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
      });

      app = buildServer({
        db: handle.db as never,
        security: { rateLimitEnabled: false },
        authenticate: createSessionAuthenticate({
          getSnapshot: (request) => getIdentitySession(auth, request.raw.headers),
          getResolver: () => resolver,
        }),
      });
      registerIdentityAuth(app, auth, {
        credentialThrottle: createCredentialThrottle(createInMemoryFailedLoginStore()),
        onAuditError: (err) => {
          throw err;
        },
      });

      for (const r of toNewAlertRuleRows(PLATFORM_DEFAULT_ALERT_RULES)) {
        await admin.query(
          `INSERT INTO alert_rule (organization_id,event_type,category,severity_floor,recipient_resolver,resolver_args,channels_override,system_locked,enabled)
           VALUES (NULL,$1,$2,$3,$4,$5::jsonb,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [
            r.eventType,
            r.category,
            r.severityFloor,
            r.recipientResolver,
            JSON.stringify(r.resolverArgs),
            r.channelsOverride,
            r.systemLocked,
            r.enabled,
          ],
        );
      }

      nurse = await seedPerson("nurse", ORG, SEND);
      rn = await seedPerson("rn", ORG, RECEIVE);
      leaver = await seedPerson("leaver", ORG, RECEIVE);
      officer = await seedPerson("officer", ORG, OFFICER_KEYS);
      noStepUp = await seedPerson("nostepup", ORG, OFFICER_KEYS);
      noReview = await seedPerson("noreview", ORG, [...STAFF, "messaging.offboarding.manage"]);
      plain = await seedPerson("plain", ORG, STAFF);
      outsider = await seedPerson("outsider", ORG_2, OFFICER_KEYS);

      const careTeam = [nurse.userId, rn.userId, leaver.userId];
      const ack = buildAckDeps({
        db: handle.db,
        flags: { forOrg: async () => ({ "messaging.ack_requests": true }) },
        outbox: catalogOutbox() as never,
        messaging: service,
        permissionsFor: async (org, userId) =>
          new Set(
            (
              await admin.query(
                `SELECT DISTINCT rp.permission_key FROM membership m
                   JOIN membership_role mr ON mr.membership_id = m.id
                   JOIN role_permission rp ON rp.role_id = mr.role_id
                  WHERE m.user_id=$1 AND m.organization_id=$2 AND m.status='active'`,
                [userId, org],
              )
            ).rows.map((r: { permission_key: string }) => r.permission_key),
          ),
        part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
        careTeamMembers: async () => careTeam,
      });
      const tasks = buildTaskDeps({
        db: handle.db,
        flags: { forOrg: async () => ({ "messaging.tasks": true }) },
        outbox: catalogOutbox() as never,
        messaging: service,
        careTeamMembers: async () => [],
      });
      const handoffs = buildHandoffDeps({
        db: handle.db,
        flags: { forOrg: async () => ({ "messaging.handoffs": true }) },
        outbox: catalogOutbox() as never,
        messaging: service,
        caseloadPatientIds: async () => [],
        patientLabels: async (_org, ids) =>
          new Map(ids.map((id) => [id, { displayName: "A B.", mrnSuffix: "1234" }] as const)),
        part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
        permissionsFor: async () => new Set(STAFF),
      });
      const emitter = createAlertEmitter({
        ...createDrizzleAlertEmitterPorts(handle.db, {
          flags: createDrizzleFeatureFlagReader(handle.db),
        }),
        now: () => new Date(),
      });
      const realtimeEmitter = createRealtimeEmitter(redis);
      mountMessagingRoutes(app, handle.db as never, {
        sessionDevices: {
          disconnectSession: (sessionId) => realtimeEmitter.disconnectRoom(sessionRoom(sessionId)),
        },
        offboarding: {
          ack: ack.service,
          attention: { alerts: emitter, opsNotice: (n) => opsNotices.push(n.kind) },
          endMemberships: (orgId, userId) => endChannelMembershipsForUser(handle.db, orgId, userId),
          reassignTasks: async (orgId, userId) => {
            if (failTasksOnce.armed) {
              failTasksOnce.armed = false;
              throw new Error("boom with a secret connection string");
            }
            return tasks.reassignForLeaver(orgId, userId);
          },
          resolveHandoffs: handoffs.reassignForLeaver,
        },
      });
      await app.listen({ port: 0, host: "127.0.0.1" });
      void (app.server.address() as AddressInfo);

      // Workplace: one channel with an eligible colleague, one where nobody else can take a request.
      channel = await channelOf(PATIENT, [nurse.userId, rn.userId, leaver.userId]);
      channel2 = await channelOf(PATIENT_2, [nurse.userId, leaver.userId]);
      pastMessage = await message(leaver.userId, channel);

      // Open acknowledgment requests assigned to the leaver, created through the real service.
      const nurseRef = { orgId: ORG, userId: nurse.userId };
      const m1 = await message(nurse.userId, channel);
      const m2 = await message(nurse.userId, channel2);
      ackMoved = (
        await ack.service.create(nurseRef, { messageId: m1, assigneeUserId: leaver.userId })
      ).request.id;
      ackStuck = (
        await ack.service.create(nurseRef, { messageId: m2, assigneeUserId: leaver.userId })
      ).request.id;
      // An urgent message with no tracked request: nothing can move its recipient.
      urgentMsg = await message(
        nurse.userId,
        channel2,
        `urgency, urgent_recipient_user_id|'urgent', '${leaver.userId}'`,
      );
      // A task and a handoff the leaver holds.
      const taskMsg = await message(nurse.userId, channel);
      taskId = (
        await admin.query(
          `INSERT INTO communication_task (organization_id, message_id, channel_id, created_by, assignee_id, status)
           VALUES ($1,$2,$3,$4,$5,'open') RETURNING id`,
          [ORG, taskMsg, channel, nurse.userId, leaver.userId],
        )
      ).rows[0].id as string;
      handoffId = (
        await admin.query(
          `INSERT INTO clinical_handoff (organization_id, from_user_id, to_user_id, expires_at)
           VALUES ($1,$2,$3, now() + interval '4 hours') RETURNING id`,
          [ORG, nurse.userId, leaver.userId],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO clinical_handoff_item (organization_id, handoff_id, patient_id, item_kind, ref_id, accountable_user_id)
         VALUES ($1,$2,$3,'patient',$3,$4)`,
        [ORG, handoffId, PATIENT, nurse.userId],
      );
      // Personal leftovers.
      await admin.query(
        `INSERT INTO scheduled_message (organization_id, channel_id, user_id, body_cipher, scheduled_for)
         VALUES ($1,$2,$3,'\\x01aa', now() + interval '2 hours')`,
        [ORG, channel, leaver.userId],
      );
      const remMsg = await message(nurse.userId, channel);
      await admin.query(
        `INSERT INTO message_reminder (organization_id, user_id, channel_id, message_id, remind_at) VALUES ($1,$2,$3,$4, now() + interval '2 hours')`,
        [ORG, leaver.userId, channel, remMsg],
      );
      await admin.query(
        `INSERT INTO message_snooze (organization_id, user_id, channel_id, snoozed_until) VALUES ($1,$2,$3, now() + interval '2 hours')`,
        [ORG, leaver.userId, await channelOf(PATIENT_3, [nurse.userId, leaver.userId])],
      );
      await admin.query(
        `INSERT INTO message_draft (organization_id, channel_id, user_id, body_cipher, device_id) VALUES ($1,$2,$3,'\\x01aa','dev-1')`,
        [ORG, channel, leaver.userId],
      );

      // Two real sessions with a push endpoint each, plus an old endpoint no session links to.
      await admin.query("DELETE FROM session WHERE user_id=$1", [leaver.userId]);
      leaverSessions = [await login(leaver, ORG, UA_MAC), await login(leaver, ORG, UA_IPHONE)];
      for (const [i, who] of leaverSessions.entries()) {
        const res = await call("POST", "/api/v1/notifications/endpoints", who, {
          channel: "push",
          target: i === 0 ? PUSH_1 : PUSH_2,
        });
        expect(res.statusCode).toBe(201);
      }
      await admin.query(
        `INSERT INTO delivery_endpoint (user_id, channel, endpoint_value, verification_status, verified_at) VALUES ($1,'push',$2,'verified',now())`,
        [leaver.userId, PUSH_OLD],
      );
      await admin.query("DELETE FROM session WHERE user_id = ANY($1::uuid[])", [
        [officer.userId, noStepUp.userId, noReview.userId, plain.userId, outsider.userId],
      ]);
      officerLogin = await login(officer, ORG, UA_MAC, true);
    }, 300_000);

    afterAll(async () => {
      await app?.close();
      redis?.disconnect();
      resetAbacRegistry();
      resetAuthorizationContract();
      resetRbacEngine();
      await handle?.close();
      await admin?.end();
    });

    it("refuses an unauthenticated call and an unprivileged caller, and a user who has not left is a 409", async () => {
      expect((await preview(null, leaver.userId)).statusCode).toBe(401);
      expect((await execute(null, leaver.userId)).statusCode).toBe(401);
      const plainLogin = await login(plain, ORG, UA_MAC, true);
      expect((await preview(plainLogin, leaver.userId)).statusCode).toBe(403);
      expect((await execute(plainLogin, leaver.userId)).statusCode).toBe(403);
      // The leaver has not left yet: an active member is not offboarding.
      expect((await preview(officerLogin, leaver.userId)).statusCode).toBe(409);
      const r409 = await execute(officerLogin, leaver.userId);
      expect(r409.statusCode, r409.body).toBe(409);
      expect((await call("GET", "/api/v1/devices", leaverSessions[0] as Login)).statusCode).toBe(
        200,
      );
    });

    it("PREVIEW counts every item, changes nothing and writes one audit row", async () => {
      // Identity deactivates the member (the membership ends; the sessions are still on the books in this scenario).
      await admin.query("UPDATE membership SET status='revoked' WHERE user_id=$1", [leaver.userId]);
      // The sessions are still on the books, so until the execute step revokes them the session is still alive for plain REST.
      expect((await call("GET", "/api/v1/devices", leaverSessions[0] as Login)).statusCode).toBe(
        200,
      );
      const before = await footprint();
      const res = await preview(officerLogin, leaver.userId);
      expect(res.statusCode, res.body).toBe(200);
      const dto = res.json() as OffboardingDto;
      expect(item(dto, "sessions_devices")).toMatchObject({ state: "pending", count: 5 }); // 2 sessions + 3 endpoints
      expect(item(dto, "channel_memberships")).toMatchObject({ state: "pending", count: 3 });
      expect(item(dto, "tasks")).toMatchObject({ state: "pending", count: 1 });
      expect(item(dto, "handoffs")).toMatchObject({ state: "pending", count: 1 });
      expect(item(dto, "ack_assigned")).toMatchObject({ state: "pending", count: 2 });
      expect(item(dto, "ack_sent")).toMatchObject({ state: "kept", count: 0 });
      expect(item(dto, "urgent_untracked")).toMatchObject({ state: "needs_person", count: 1 });
      expect(item(dto, "oncall_seats").state).toBe("advisory");
      expect(item(dto, "scheduled_sends")).toMatchObject({ state: "pending", count: 1 });
      expect(item(dto, "reminders_snoozes")).toMatchObject({ state: "pending", count: 2 });
      expect(item(dto, "drafts")).toMatchObject({ state: "kept", count: 1 });
      expect(dto.complete).toBe(false);
      expect(await footprint()).toEqual(before);
      const audit = await rows<{ context: { complete: boolean; items: Record<string, unknown> } }>(
        "SELECT context FROM audit_event WHERE event_type='m36.offboarding.viewed' AND resource_id=$1",
        [leaver.userId],
      );
      expect(audit).toHaveLength(1);
      expect(Object.keys(audit[0]?.context.items ?? {}).sort()).toEqual(
        [...dto.items.map((i) => i.key)].sort(),
      );
    });

    it("refuses an execute without a fresh step-up, without the review key, and for another tenant; foreign = unknown", async () => {
      const stale = await login(noStepUp, ORG, UA_MAC, false);
      const noStep = await execute(stale, leaver.userId);
      expect(noStep.statusCode).toBe(403);
      expect(noStep.body).toContain("STEP_UP_REQUIRED");
      const lacksReview = await login(noReview, ORG, UA_MAC, true);
      expect((await execute(lacksReview, leaver.userId)).statusCode).toBe(403);
      const other = await login(outsider, ORG_2, UA_MAC, true);
      const foreign = await preview(other, leaver.userId);
      const unknown = await preview(other, randomUUID());
      expect(foreign.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(Object.keys(foreign.json()).sort()).toEqual(Object.keys(unknown.json()).sort());
      expect((await execute(other, leaver.userId)).statusCode).toBe(404);
      expect(
        await count("SELECT count(*)::int AS n FROM session WHERE user_id=$1", [leaver.userId]),
      ).toBe(2);
    });

    it("EXECUTE finishes Workflow F: moves what it can, ends access, and shows what still needs a person", async () => {
      const res = await execute(officerLogin, leaver.userId);
      expect(res.statusCode, res.body).toBe(200);
      const dto = res.json() as OffboardingDto;

      expect(item(dto, "sessions_devices")).toMatchObject({ state: "done", count: 0 });
      expect(item(dto, "sessions_devices").acted).toBeGreaterThanOrEqual(5);
      expect(item(dto, "channel_memberships")).toMatchObject({ state: "done", acted: 3 });
      expect(item(dto, "tasks")).toMatchObject({ state: "done", acted: 1 });
      expect(item(dto, "handoffs")).toMatchObject({ state: "done", acted: 1 });
      expect(item(dto, "ack_assigned")).toMatchObject({
        state: "needs_person",
        count: 1,
        acted: 1,
        needs_person: 1,
      });
      expect(item(dto, "urgent_untracked")).toMatchObject({ state: "needs_person", count: 1 });
      expect(item(dto, "scheduled_sends")).toMatchObject({ state: "done", acted: 1 });
      expect(item(dto, "reminders_snoozes")).toMatchObject({ state: "done", acted: 2 });
      expect(item(dto, "drafts")).toMatchObject({ state: "kept", count: 1 });
      expect(dto.complete).toBe(false);
      expect([...dto.blocked_by].sort()).toEqual(["ack_assigned", "urgent_untracked"]);

      // The request with an eligible colleague moved through the ADR-0078 path: history names who and why.
      const moved = (
        await rows<{ assigned_user_id: string; status: string }>(
          "SELECT assigned_user_id, status FROM message_acknowledgment_request WHERE id=$1",
          [ackMoved],
        )
      )[0];
      expect(moved).toMatchObject({ assigned_user_id: rn.userId, status: "pending" });
      const history = await rows<Record<string, unknown>>(
        "SELECT event_type, actor_user_id, previous_assigned_user_id, assigned_user_id, reason_code FROM message_acknowledgment_event WHERE request_id=$1 AND event_type='reassigned'",
        [ackMoved],
      );
      expect(history).toEqual([
        {
          event_type: "reassigned",
          actor_user_id: officer.userId,
          previous_assigned_user_id: leaver.userId,
          assigned_user_id: rn.userId,
          reason_code: "assignee_unable_to_sign_in",
        },
      ]);

      // The request nobody can take stays visible, still pending, and the supervisors were told once.
      const stuck = (
        await rows<{ assigned_user_id: string; status: string; version: number }>(
          "SELECT assigned_user_id, status, version FROM message_acknowledgment_request WHERE id=$1",
          [ackStuck],
        )
      )[0];
      expect(stuck).toMatchObject({ assigned_user_id: leaver.userId, status: "pending" });
      const attention = await rows<{ payload: { reason: string } }>(
        "SELECT payload FROM alert WHERE correlation_id=$1",
        [`offboard-attn:${ackStuck}:${stuck?.version}`],
      );
      expect(attention).toHaveLength(1);
      expect(attention[0]?.payload.reason).toBe("assignee_departed");

      // Access: sessions gone (next REST call 401), endpoints expired (linked and unlinked alike), memberships ended.
      expect(
        await count("SELECT count(*)::int AS n FROM session WHERE user_id=$1", [leaver.userId]),
      ).toBe(0);
      for (const who of leaverSessions) {
        expect((await call("GET", "/api/v1/devices", who)).statusCode).toBe(401);
      }
      expect(
        await count(
          "SELECT count(*)::int AS n FROM delivery_endpoint WHERE user_id=$1 AND verification_status <> 'expired'",
          [leaver.userId],
        ),
      ).toBe(0);
      expect(
        await count(
          "SELECT count(*)::int AS n FROM channel_member WHERE user_id=$1 AND removed_at IS NULL",
          [leaver.userId],
        ),
      ).toBe(0);

      // Owned work moved through its own services.
      expect(
        (
          await rows<{ assignee_id: string }>(
            "SELECT assignee_id FROM communication_task WHERE id=$1",
            [taskId],
          )
        )[0]?.assignee_id,
      ).toBe(nurse.userId);
      expect(
        (
          await rows<{ state: string; closed_reason: string }>(
            "SELECT state, closed_reason FROM clinical_handoff WHERE id=$1",
            [handoffId],
          )
        )[0],
      ).toMatchObject({ state: "declined", closed_reason: "recipient_left" });

      // Nothing is sent as them; what they wrote stays attributed to them; the draft is kept.
      expect(
        await count("SELECT count(*)::int AS n FROM scheduled_message WHERE user_id=$1", [
          leaver.userId,
        ]),
      ).toBe(0);
      expect(
        await count("SELECT count(*)::int AS n FROM message_reminder WHERE user_id=$1", [
          leaver.userId,
        ]),
      ).toBe(0);
      expect(
        await count("SELECT count(*)::int AS n FROM message_snooze WHERE user_id=$1", [
          leaver.userId,
        ]),
      ).toBe(0);
      expect(
        await count("SELECT count(*)::int AS n FROM message_draft WHERE user_id=$1", [
          leaver.userId,
        ]),
      ).toBe(1);
      expect(
        (
          await rows<{ author_user_id: string; status: string }>(
            "SELECT author_user_id, status FROM message WHERE id=$1",
            [pastMessage],
          )
        )[0],
      ).toMatchObject({ author_user_id: leaver.userId, status: "sent" });
      expect(
        (
          await rows<{ urgent_recipient_user_id: string }>(
            "SELECT urgent_recipient_user_id FROM message WHERE id=$1",
            [urgentMsg],
          )
        )[0]?.urgent_recipient_user_id,
      ).toBe(leaver.userId);
      // M19 is not touched by this workflow.
      expect(await count("SELECT count(*)::int AS n FROM on_call_shift")).toBe(0);
    });

    it("a re-run changes nothing and notifies nobody again", async () => {
      const before = await footprint();
      const res = await execute(officerLogin, leaver.userId);
      expect(res.statusCode).toBe(200);
      const dto = res.json() as OffboardingDto;
      expect(dto.items.every((i) => i.acted === 0)).toBe(true);
      expect(item(dto, "ack_assigned")).toMatchObject({ state: "needs_person", count: 1 });
      const after = await footprint();
      // The only new rows are the audit trail; no ack event, no outbox event, no alert, no session, no message.
      expect(after).toEqual(before);
      expect(
        await count("SELECT count(*)::int AS n FROM alert WHERE correlation_id LIKE $1", [
          `offboard-attn:${ackStuck}:%`,
        ]),
      ).toBe(1);
    });

    it("a step that fails once is reported failed without its error text, and the next run finishes it", async () => {
      // A second departed user with one task, so the first run has something for the failing step to do.
      const second = await seedPerson("leaver2", ORG, RECEIVE);
      await admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source) VALUES ($1,$2,$3,'member','manual')`,
        [ORG, channel, second.userId],
      );
      const msg = await message(nurse.userId, channel);
      const t2 = (
        await admin.query(
          `INSERT INTO communication_task (organization_id, message_id, channel_id, created_by, assignee_id, status)
           VALUES ($1,$2,$3,$4,$5,'open') RETURNING id`,
          [ORG, msg, channel, nurse.userId, second.userId],
        )
      ).rows[0].id as string;
      await admin.query("UPDATE membership SET status='revoked' WHERE user_id=$1", [second.userId]);
      failTasksOnce.armed = true;
      const first = await execute(officerLogin, second.userId);
      expect(first.statusCode).toBe(200);
      expect(first.body).not.toContain("secret connection string");
      const firstDto = first.json() as OffboardingDto;
      expect(item(firstDto, "tasks")).toMatchObject({ state: "failed", count: 1 });
      expect(item(firstDto, "channel_memberships").state).toBe("done"); // the other steps still ran
      expect(firstDto.complete).toBe(false);
      const resumed = (await (await execute(officerLogin, second.userId)).json()) as OffboardingDto;
      expect(item(resumed, "tasks")).toMatchObject({ state: "done", acted: 1 });
      expect(item(resumed, "channel_memberships").acted).toBe(0); // nothing is redone
      expect(resumed.complete).toBe(true);
      expect(
        (
          await rows<{ assignee_id: string }>(
            "SELECT assignee_id FROM communication_task WHERE id=$1",
            [t2],
          )
        )[0]?.assignee_id,
      ).toBe(nurse.userId);
    });

    it("AUDIT: the rows carry ids, fixed keys and counts only", async () => {
      const executed = await rows<{
        actor_user_id: string;
        resource_id: string;
        context: { complete: boolean; items: Record<string, Record<string, unknown>> };
      }>(
        "SELECT actor_user_id, resource_id, context FROM audit_event WHERE event_type='m36.offboarding.executed' AND resource_id=$1 ORDER BY created_at",
        [leaver.userId],
      );
      expect(executed.length).toBeGreaterThanOrEqual(2); // the first run and the re-run both leave a row
      for (const row of executed) {
        expect(row.actor_user_id).toBe(officer.userId);
        for (const entry of Object.values(row.context.items)) {
          expect(Object.keys(entry).sort()).toEqual(["acted", "count", "state"]);
        }
        expect(JSON.stringify(row.context)).not.toMatch(/@wp59\.test|Mozilla|https?:/);
      }
      expect(executed[0]?.context.complete).toBe(false);
      // Each reassign and revoke also wrote its own audited rows through the services it reused.
      expect(
        await count(
          "SELECT count(*)::int AS n FROM audit_event WHERE event_type='m36.session.revoked'",
        ),
      ).toBe(2);
    });
  },
);
