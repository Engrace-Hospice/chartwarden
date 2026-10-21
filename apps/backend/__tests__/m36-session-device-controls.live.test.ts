/**
 * M36 WP 5.5 (ADR-0083, PROPOSED) - session and device controls, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role and a LIVE Valkey.
 *
 * The production composition, not a shim: REAL Better Auth sessions behind the REAL Fastify bridge and authenticate hook, the REAL DB permission
 * resolver and session-context store (so the REAL step-up predicate reads the session row), the REAL device routes, the REAL endpoint
 * registration route, and the REAL Socket.IO realtime server on the same HTTP server with the REAL Valkey emitter closing a revoked
 * session's room. Nothing about authentication is injected.
 *
 *   1. LIST       the owner sees only their own sessions, the current one marked, a coarse label, push flag; no token / IP / raw user agent.
 *   2. REVOKE     the revoked session's next REST call is 401; its live socket is closed (the realtime recheck is set to 10 minutes, so the
 *                 close is the revoke's doing); the endpoint it registered is expired while the other session's stays verified; the other
 *                 session and its socket keep working; one audit row names actor and target and carries no secret.
 *   3. IDOR       another user's revoke is the SAME 404 as an unknown id and changes nothing; a repeat revoke is that 404 too.
 *   4. ADMIN      messaging.sessions.manage lists/revokes another user's session in the organisation (audited, endpoint expired under the
 *                 target's user RLS scope); refused 403 without the key; a stale step-up is refused; another tenant's officer gets an empty list
 *                 and a 404 and nothing changes.
 *   5. RE-REGISTER the same push endpoint re-registered from a new session is verified again and linked to it (no unique-index failure).
 *   6. CURRENT    revoking the current session says so, and the next call is 401.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... CHARTWARDEN_TEST_REDIS_URL=redis://... bun run test:m36:session-devices:live
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
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { Client } from "pg";
import { type Socket, io as connect } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, createSessionAuthenticate } from "../src/bootstrap/index";
import {
  type RealtimeHandle,
  createRealtimeEmitter,
  sessionRoom,
  startRealtimeServer,
} from "../src/bootstrap/realtime";
import { wireModuleSeams } from "../src/index";
import { mountMessagingRoutes } from "../src/modules/36-messaging/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const REDIS_URL = process.env.CHARTWARDEN_TEST_REDIS_URL;
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
const ORG = "33333333-3333-4333-8333-3333000a8501";
const ORG_2 = "44444444-4444-4444-8444-4444000a8502";
const ORIGIN = "http://localhost:3000";
const UA_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const UA_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const PUSH_A1 = "https://push.example.test/sub/a1-aaaaaaaaaaaaaaaa";
const PUSH_A2 = "https://push.example.test/sub/a2-bbbbbbbbbbbbbbbb";
const SELF_KEYS = ["notifications.endpoint.manage"];

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
  "M36 WP 5.5 session and device controls, LIVE Postgres + Valkey",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let auth: ReturnType<typeof createIdentityAuth>;
    let app: FastifyInstance;
    let realtime: RealtimeHandle;
    let baseUrl = "";
    const redis: Redis[] = [];
    const sockets: Socket[] = [];

    const newRedis = () => {
      const r = new Redis(REDIS_URL as string, { maxRetriesPerRequest: null });
      r.on("error", () => {});
      redis.push(r);
      return r;
    };

    async function seedPerson(
      label: string,
      org: string,
      permissionKeys: readonly string[],
    ): Promise<Person> {
      const email = `${label}-${randomUUID().slice(0, 8)}@wp55.test`;
      const password = `Wx9$${randomUUID()}Qz!`;
      await auth.api.signUpEmail({ body: { email, password, name: label } });
      const userId = (await admin.query(`SELECT id FROM "user" WHERE email=$1`, [email])).rows[0]
        .id as string;
      const membershipId = (
        await admin.query(
          "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
          [userId, org],
        )
      ).rows[0].id as string;
      const roleKey = `r_${label}_${randomUUID().slice(0, 6)}`;
      const roleId = (
        await admin.query(
          "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,$2,$2,'clinical_staff',true) RETURNING id",
          [org, roleKey],
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

    /** A real sign-in (own user agent) bound to the organisation, as select-organization would. */
    async function login(person: Person, org: string, userAgent: string): Promise<Login> {
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
      return {
        cookie: res.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        csrf: res.cookies.find((c) => c.name === "chartwarden_csrf")?.value ?? "",
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

    /** Sign-up itself mints a pre-org session; drop every session of these people so each test starts from a known list. */
    const resetSessions = async (...people: readonly Person[]) => {
      await admin.query("DELETE FROM session WHERE user_id = ANY($1::uuid[])", [
        people.map((p) => p.userId),
      ]);
    };

    const endpointRows = async (userId: string) =>
      (
        await admin.query(
          "SELECT endpoint_value, verification_status, session_id FROM delivery_endpoint WHERE user_id=$1 ORDER BY created_at",
          [userId],
        )
      ).rows as {
        endpoint_value: string;
        verification_status: string;
        session_id: string | null;
      }[];

    async function openSocket(who: Login): Promise<Socket> {
      const socket = connect(baseUrl, {
        path: "/socket.io",
        transports: ["websocket"],
        extraHeaders: { cookie: who.cookie },
        reconnection: false,
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("connect_error", (err) => reject(err));
      });
      return socket;
    }

    const closedWithin = (socket: Socket, ms: number) =>
      new Promise<boolean>((resolve) => {
        if (socket.disconnected) return resolve(true);
        const timer = setTimeout(() => resolve(false), ms);
        socket.once("disconnect", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

    let a: Person;
    let b: Person;
    let officer: Person;
    let outsider: Person;
    let officerLogin: Login;

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
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'wp55a','wp55a','wp55a','active'),($2,'wp55b','wp55b','wp55b','active')",
        [ORG, ORG_2],
      );
      handle = createDbClient({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
      auth = createIdentityAuth(handle.db as never);

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
      const emitter = createRealtimeEmitter(newRedis());
      mountMessagingRoutes(app, handle.db as never, {
        sessionDevices: {
          disconnectSession: (sessionId) => emitter.disconnectRoom(sessionRoom(sessionId)),
        },
      });
      await app.listen({ port: 0, host: "127.0.0.1" });
      baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const pub = newRedis();
      const sub = pub.duplicate();
      sub.on("error", () => {});
      redis.push(sub);
      realtime = startRealtimeServer({
        httpServer: app.server,
        pubClient: pub,
        subClient: sub,
        trustedOrigins: [ORIGIN],
        // 10 minutes: any close inside this suite's few seconds is the REVOKE's doing, not the periodic re-check.
        recheckIntervalMs: 600_000,
        authenticate: async (headers) => {
          const snap = await getIdentitySession(auth, headers);
          if (!snap?.activeOrganizationId) return null;
          return {
            userId: snap.userId,
            organizationId: snap.activeOrganizationId,
            sessionId: snap.sessionId,
          };
        },
        resolveRooms: async () => [],
        stillValid: async ({ sessionId }) =>
          ((await admin.query("SELECT 1 FROM session WHERE id=$1", [sessionId])).rowCount ?? 0) > 0,
      });

      a = await seedPerson("a", ORG, SELF_KEYS);
      b = await seedPerson("b", ORG, SELF_KEYS);
      officer = await seedPerson("officer", ORG, [...SELF_KEYS, "messaging.sessions.manage"]);
      outsider = await seedPerson("outsider", ORG_2, [...SELF_KEYS, "messaging.sessions.manage"]);
      officerLogin = await login(officer, ORG, UA_MAC);
      await admin.query(
        "UPDATE session SET last_step_up_at=now(), last_step_up_factor='totp' WHERE id=$1",
        [officerLogin.sessionId],
      );
    }, 300_000);

    afterAll(async () => {
      for (const s of sockets) s.close();
      await realtime?.close();
      await app?.close();
      for (const r of redis) r.disconnect();
      resetAbacRegistry();
      resetAuthorizationContract();
      resetRbacEngine();
      await handle?.close();
      await admin?.end();
    });

    it("is unauthenticated-safe: no session means 401 on every route", async () => {
      expect((await call("GET", "/api/v1/devices", null)).statusCode).toBe(401);
      expect((await call("DELETE", "/api/v1/devices/anything", null)).statusCode).toBe(401);
      expect(
        (await call("GET", `/api/v1/messaging/governance/sessions?user_id=${a.userId}`, null))
          .statusCode,
      ).toBe(401);
    });

    it("revoking a session: next REST call 401, socket closed, endpoint expired, the other session untouched, audited", async () => {
      await resetSessions(a);
      const a1 = await login(a, ORG, UA_MAC);
      const a2 = await login(a, ORG, UA_IPHONE);
      // Each session registers its own push endpoint through the real route (the link is stamped server-side).
      expect(
        (
          await call("POST", "/api/v1/notifications/endpoints", a1, {
            channel: "push",
            target: PUSH_A1,
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await call("POST", "/api/v1/notifications/endpoints", a2, {
            channel: "push",
            target: PUSH_A2,
          })
        ).statusCode,
      ).toBe(201);
      const linked = await endpointRows(a.userId);
      expect(linked.map((r) => [r.endpoint_value, r.session_id])).toEqual([
        [PUSH_A1, a1.sessionId],
        [PUSH_A2, a2.sessionId],
      ]);

      // LIST: own sessions only, current marked, coarse labels, push flag, no secret.
      const list = await call("GET", "/api/v1/devices", a1);
      expect(list.statusCode).toBe(200);
      const devices = list.json().devices as Array<Record<string, unknown>>;
      expect(devices).toHaveLength(2);
      expect(devices[0]).toMatchObject({
        id: a1.sessionId,
        current: true,
        label: "Chrome · macOS",
        push_registered: true,
      });
      expect(devices[1]).toMatchObject({
        id: a2.sessionId,
        current: false,
        label: "Safari · iOS",
        push_registered: true,
      });
      for (const d of devices) {
        expect(Object.keys(d).sort()).toEqual([
          "created_at",
          "current",
          "id",
          "label",
          "last_used_at",
          "push_registered",
        ]);
      }
      const tokens = (
        await admin.query("SELECT token, ip_address, user_agent FROM session WHERE user_id=$1", [
          a.userId,
        ])
      ).rows as {
        token: string;
        ip_address: string | null;
        user_agent: string | null;
      }[];
      for (const t of tokens) {
        expect(list.body).not.toContain(t.token);
        expect(list.body).not.toContain("Mozilla");
        if (t.ip_address) expect(list.body).not.toContain(t.ip_address);
      }
      expect(list.body).not.toContain(PUSH_A1);

      // Two live sockets, one per session.
      const s1 = await openSocket(a1);
      const s2 = await openSocket(a2);
      expect(s1.connected && s2.connected).toBe(true);

      // REVOKE a2 from a1.
      const revoked = await call("DELETE", `/api/v1/devices/${a2.sessionId}`, a1);
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json()).toEqual({ revoked: true, current: false, push_endpoints_expired: 1 });

      expect((await call("GET", "/api/v1/devices", a2)).statusCode).toBe(401); // next REST call
      expect(await closedWithin(s2, 5_000)).toBe(true); // the socket, closed by the revoke (recheck is 10 min)
      expect(s1.connected).toBe(true); // the other session's socket is untouched
      expect((await call("GET", "/api/v1/devices", a1)).statusCode).toBe(200);
      expect(
        (await admin.query("SELECT 1 FROM session WHERE id=$1", [a2.sessionId])).rowCount,
      ).toBe(0);

      const after = await endpointRows(a.userId);
      expect(after.find((r) => r.endpoint_value === PUSH_A2)?.verification_status).toBe("expired");
      expect(after.find((r) => r.endpoint_value === PUSH_A1)?.verification_status).toBe("verified");

      // A new socket with the dead session is refused at the handshake.
      const refused = connect(baseUrl, {
        path: "/socket.io",
        transports: ["websocket"],
        extraHeaders: { cookie: a2.cookie },
        reconnection: false,
      });
      sockets.push(refused);
      await new Promise<void>((resolve) => refused.once("connect_error", () => resolve()));
      expect(refused.connected).toBe(false);

      // AUDIT: one row, actor = target = a, no secret.
      const audit = (
        await admin.query(
          "SELECT organization_id, actor_user_id, outcome, resource_kind, resource_id, context FROM audit_event WHERE event_type='m36.session.revoked' AND resource_id=$1",
          [a2.sessionId],
        )
      ).rows as Array<{
        organization_id: string;
        actor_user_id: string;
        outcome: string;
        resource_kind: string;
        context: Record<string, unknown>;
      }>;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        organization_id: ORG,
        actor_user_id: a.userId,
        outcome: "success",
        resource_kind: "session",
      });
      expect(audit[0]?.context).toMatchObject({
        targetUserId: a.userId,
        byAdmin: false,
        current: false,
        endpointsExpired: 1,
      });
      const flat = JSON.stringify(audit[0]?.context);
      for (const t of tokens) expect(flat).not.toContain(t.token);
      expect(flat).not.toContain("Mozilla");
      expect(flat).not.toContain(PUSH_A2);

      // A repeat is the same 404 as an unknown id; no second audit row.
      const repeat = await call("DELETE", `/api/v1/devices/${a2.sessionId}`, a1);
      const unknown = await call("DELETE", "/api/v1/devices/nosuchsession", a1);
      expect(repeat.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(repeat.json().error.code).toBe(unknown.json().error.code);
      expect(
        (
          await admin.query(
            "SELECT 1 FROM audit_event WHERE event_type='m36.session.revoked' AND resource_id=$1",
            [a2.sessionId],
          )
        ).rowCount,
      ).toBe(1);
      s1.close();
    }, 60_000);

    it("another user cannot see or revoke it: the same 404 as an unknown id, and nothing changes", async () => {
      await resetSessions(a, b);
      const a1 = await login(a, ORG, UA_MAC);
      const b1 = await login(b, ORG, UA_IPHONE);
      const seen = await call("GET", "/api/v1/devices", b1);
      expect((seen.json().devices as Array<{ id: string }>).map((d) => d.id)).toEqual([
        b1.sessionId,
      ]);
      const foreign = await call("DELETE", `/api/v1/devices/${a1.sessionId}`, b1);
      const unknown = await call("DELETE", "/api/v1/devices/nosuchsession", b1);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json().error.code).toBe(unknown.json().error.code);
      expect(foreign.json().error.message.replace(a1.sessionId, "X")).toBe(
        unknown.json().error.message.replace("nosuchsession", "X"),
      );
      expect((await call("GET", "/api/v1/devices", a1)).statusCode).toBe(200); // still alive
      // The owner of another TENANT is refused the same way.
      const o1 = await login(outsider, ORG_2, UA_MAC);
      expect((await call("DELETE", `/api/v1/devices/${a1.sessionId}`, o1)).statusCode).toBe(404);
    }, 60_000);

    it("security officer: lists and revokes another user's session (audited, endpoint expired under the target's scope); refused without the key", async () => {
      await resetSessions(a, b);
      const b1 = await login(b, ORG, UA_MAC);
      expect(
        (
          await call("POST", "/api/v1/notifications/endpoints", b1, {
            channel: "push",
            target: `${PUSH_A1}-b`,
          })
        ).statusCode,
      ).toBe(201);

      // Without the key: 403 on both.
      const plain = await login(a, ORG, UA_MAC);
      expect(
        (await call("GET", `/api/v1/messaging/governance/sessions?user_id=${b.userId}`, plain))
          .statusCode,
      ).toBe(403);
      expect(
        (await call("DELETE", `/api/v1/messaging/governance/sessions/${b1.sessionId}`, plain))
          .statusCode,
      ).toBe(403);
      expect((await call("GET", "/api/v1/devices", b1)).statusCode).toBe(200);

      const list = await call(
        "GET",
        `/api/v1/messaging/governance/sessions?user_id=${b.userId}`,
        officerLogin,
      );
      expect(list.statusCode).toBe(200);
      expect(
        list.json().devices as Array<{ id: string; current: boolean; push_registered: boolean }>,
      ).toEqual([
        expect.objectContaining({ id: b1.sessionId, current: false, push_registered: true }),
      ]);
      expect(
        (
          await admin.query(
            "SELECT context FROM audit_event WHERE event_type='m36.session.admin_listed' AND resource_id=$1",
            [b.userId],
          )
        ).rowCount,
      ).toBeGreaterThanOrEqual(1);

      // A stale step-up is refused and changes nothing.
      await admin.query(
        "UPDATE session SET last_step_up_at=now() - interval '1 hour' WHERE id=$1",
        [officerLogin.sessionId],
      );
      const stale = await call(
        "DELETE",
        `/api/v1/messaging/governance/sessions/${b1.sessionId}`,
        officerLogin,
      );
      expect(stale.statusCode).toBe(403);
      expect(stale.json().error.code).toBe("STEP_UP_REQUIRED");
      expect((await call("GET", "/api/v1/devices", b1)).statusCode).toBe(200);
      await admin.query("UPDATE session SET last_step_up_at=now() WHERE id=$1", [
        officerLogin.sessionId,
      ]);

      const socket = await openSocket(b1);
      const revoked = await call(
        "DELETE",
        `/api/v1/messaging/governance/sessions/${b1.sessionId}`,
        officerLogin,
      );
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json()).toEqual({ revoked: true, current: false, push_endpoints_expired: 1 });
      expect((await call("GET", "/api/v1/devices", b1)).statusCode).toBe(401);
      expect(await closedWithin(socket, 5_000)).toBe(true);
      expect((await endpointRows(b.userId)).every((r) => r.verification_status === "expired")).toBe(
        true,
      );
      const audit = (
        await admin.query(
          "SELECT actor_user_id, severity, context FROM audit_event WHERE event_type='m36.session.revoked' AND resource_id=$1",
          [b1.sessionId],
        )
      ).rows as Array<{
        actor_user_id: string;
        severity: string;
        context: Record<string, unknown>;
      }>;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_user_id: officer.userId, severity: "warn" });
      expect(audit[0]?.context).toMatchObject({ targetUserId: b.userId, byAdmin: true });
    }, 60_000);

    it("another tenant's officer sees nothing and revokes nothing", async () => {
      await resetSessions(a, outsider);
      const a3 = await login(a, ORG, UA_MAC);
      const out = await login(outsider, ORG_2, UA_MAC);
      await admin.query(
        "UPDATE session SET last_step_up_at=now(), last_step_up_factor='totp' WHERE id=$1",
        [out.sessionId],
      );
      const list = await call(
        "GET",
        `/api/v1/messaging/governance/sessions?user_id=${a.userId}`,
        out,
      );
      expect(list.statusCode).toBe(200);
      expect(list.json().devices).toEqual([]);
      expect(
        (await call("DELETE", `/api/v1/messaging/governance/sessions/${a3.sessionId}`, out))
          .statusCode,
      ).toBe(404);
      expect((await call("GET", "/api/v1/devices", a3)).statusCode).toBe(200);
    }, 60_000);

    it("re-registering the same push endpoint from a new session verifies it again and links it to that session", async () => {
      await resetSessions(a);
      const a4 = await login(a, ORG, UA_IPHONE);
      const res = await call("POST", "/api/v1/notifications/endpoints", a4, {
        channel: "push",
        target: PUSH_A2,
      });
      expect(res.statusCode).toBe(201);
      const row = (await endpointRows(a.userId)).find((r) => r.endpoint_value === PUSH_A2);
      expect(row).toMatchObject({ verification_status: "verified", session_id: a4.sessionId });
    }, 60_000);

    it("revoking the CURRENT session says so and signs the caller out", async () => {
      const a5 = await login(a, ORG, UA_MAC);
      const res = await call("DELETE", `/api/v1/devices/${a5.sessionId}`, a5);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ revoked: true, current: true });
      expect((await call("GET", "/api/v1/devices", a5)).statusCode).toBe(401);
    }, 60_000);

    it("the delivery_endpoint RLS is still the user's own after the new column (another user's row is invisible as chartwarden_app)", async () => {
      const result = await handle.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.user_id', ${b.userId}, true)`);
        return tx.execute(
          sql`SELECT count(*)::int AS n FROM delivery_endpoint WHERE user_id = ${a.userId}::uuid`,
        );
      });
      expect((result.rows[0] as { n: number }).n).toBe(0);
    }, 60_000);
  },
);
