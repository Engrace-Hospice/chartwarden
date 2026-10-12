/**
 * M36 WP 1.7 — tenant & IDOR proof, LIVE Postgres as the NOBYPASSRLS `wardenx_app` role (+ a real Valkey for the socket half).
 *
 * An adversarial pass over every M36 route and the realtime gateway. Two organisations (A, B); inside A, members and a
 * non-member of private channels (a DM and a `location` channel). Everything runs on the real route stack: the real
 * Authorization Contract, the real `channel_visibility` / `channel_member_admin` ABAC predicates, the Postgres idempotency
 * store and the catalog-validating outbox publisher.
 *
 *   1. COVERAGE GUARD   every route a M36 registrar mounts is in ROUTES with a verdict; a new route or registrar fails here.
 *   2. NO ORACLE        an attacker (org B, or an in-org non-member) using A's channel / message / endpoint / alert / rule /
 *                       patient / user id gets the SAME status and body shape as for a random uuid, and 4xx never 2xx.
 *   3. NO LEAK          no error carries A's body text, names, or user ids.
 *   4. NO WRITE         the whole battery leaves every M36 table, audit_event and outbox_event byte-identical.
 *   5. RLS AT THE DB    as `wardenx_app` with app.org_id = B: zero A rows readable, A-org INSERT / UPDATE rejected.
 *   6. SOCKETS          (needs WARDENX_TEST_REDIS_URL) a B socket and a non-member socket receive no hint for A's channels
 *                       and cannot choose a room.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… [WARDENX_TEST_REDIS_URL=redis://…] bun run test:m36:tenant-idor:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { type DbClient, createDbClient } from "@wardenx/db";
import { computeRoomSet } from "@wardenx/messaging";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { Client } from "pg";
import { type Socket, io as connect } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import {
  type RealtimeHandle,
  type RealtimePrincipal,
  createRealtimeEmitter,
  startRealtimeServer,
} from "../src/bootstrap/realtime";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import {
  createDrizzleCareTeamStore,
  createDrizzlePatientReaderStore,
} from "../src/modules/05-patient/seams/drizzle-stores";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import {
  channelHintAudience,
  createDbMessagingProvider,
} from "../src/modules/36-messaging/messaging-provider-db";
import { buildM36MessageHintConsumer } from "../src/modules/36-messaging/outbox-consumers/message-hints";
import { registerAdminAlertDeliveriesRoutes } from "../src/modules/36-messaging/routes/admin-alert-deliveries-routes";
import {
  CHANNEL_MEMBER_ADMIN_PREDICATE,
  CHANNEL_VISIBILITY_PREDICATE,
  channelMemberAdminPredicate,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/routes/messaging-routes";
import { registerMessagingWebhookRoutes } from "../src/modules/36-messaging/routes/webhook-routes";
import { createDbConsentEvaluator } from "../src/modules/39-consent/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const REDIS_URL = process.env.WARDENX_TEST_REDIS_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROUTES_DIR = join(__dirname, "../src/modules/36-messaging/routes");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const KEK = randomBytes(32);
const ORIGIN = "https://app.wardenx.test";
const SECRET_BODY = "WP17-SECRET-BODY-must-never-appear-in-an-error";
const A_NAME_TOKEN = "WP17-ORG-A-PERSON";

// ── the route inventory (the coverage guard's source of truth) ───────────────────────────────────────────────
// `idor`: takes a tenant-scoped id (or a body id) and is attacked below. `scoped`: no foreign id to guess - the actor's own
// org/user is the only input, proved by comparing what two orgs see. `excluded`: not a tenant-user route, with the reason.
type Verdict =
  | { readonly kind: "idor" | "scoped" }
  | { readonly kind: "excluded"; readonly reason: string };
const ROUTES: Record<string, Verdict> = {
  "GET /api/v1/messaging/channels": { kind: "scoped" },
  "GET /api/v1/messaging/channels/:id": { kind: "idor" },
  "GET /api/v1/messaging/channels/:id/messages": { kind: "idor" },
  "GET /api/v1/messaging/channels/:id/mention-candidates": { kind: "idor" },
  "POST /api/v1/messaging/channels/:id/messages": { kind: "idor" },
  "PATCH /api/v1/messaging/messages/:id": { kind: "idor" },
  "DELETE /api/v1/messaging/messages/:id": { kind: "idor" },
  "POST /api/v1/messaging/messages/:id/read": { kind: "idor" },
  "POST /api/v1/messaging/dm": { kind: "idor" },
  "GET /api/v1/messaging/dm/staff": { kind: "scoped" },
  "POST /api/v1/messaging/patients/:patientId/care-team-channel": { kind: "idor" },
  "POST /api/v1/messaging/channels/:id/members": { kind: "idor" },
  "DELETE /api/v1/messaging/channels/:id/members/:userId": { kind: "idor" },
  "POST /api/v1/messaging/announce": { kind: "scoped" },
  "GET /api/v1/notifications/preferences": { kind: "scoped" },
  "PUT /api/v1/notifications/preferences": { kind: "idor" },
  "POST /api/v1/notifications/endpoints": { kind: "scoped" },
  "POST /api/v1/notifications/endpoints/:id/verify": { kind: "idor" },
  "DELETE /api/v1/notifications/endpoints/:id": { kind: "idor" },
  "GET /api/v1/alerts/inbox": { kind: "scoped" },
  "POST /api/v1/alerts/:id/read": { kind: "idor" },
  "GET /api/v1/alert-rules": { kind: "scoped" },
  "PATCH /api/v1/alert-rules/:id": { kind: "idor" },
  "GET /api/v1/admin/messaging/alert-deliveries": {
    kind: "excluded",
    reason: "platform_ops, deliberately cross-tenant; a tenant admin is refused (asserted below)",
  },
  "POST /webhooks/twilio/sms-status": {
    kind: "excluded",
    reason: "vendor-signed, no tenant principal; unsigned call refused (asserted below)",
  },
  "POST /webhooks/twilio/voice-status": {
    kind: "excluded",
    reason: "vendor-signed, no tenant principal; unsigned call refused (asserted below)",
  },
  "POST /webhooks/postmark/event": {
    kind: "excluded",
    reason: "vendor-signed, no tenant principal; unsigned call refused (asserted below)",
  },
};
/** The registrar files under routes/ - a new file must be classified here, then mounted in `registeredRoutes`. */
const REGISTRAR_FILES = [
  "admin-alert-deliveries-routes.ts",
  "messaging-routes.ts",
  "messaging-typebox.ts", // schemas only
  "webhook-routes.ts",
];

function registeredRoutes(): string[] {
  const probe = Fastify();
  const seen = new Set<string>();
  probe.addHook("onRoute", (route) => {
    for (const m of ([] as string[]).concat(route.method as string | string[])) {
      if (m !== "HEAD" && m !== "OPTIONS") seen.add(`${m} ${route.url}`);
    }
  });
  registerMessagingRoutes(probe, { service: {} as never });
  registerAdminAlertDeliveriesRoutes(probe, {} as never);
  registerMessagingWebhookRoutes(probe, { publicBaseUrl: "https://x.test" } as never);
  return [...seen].sort();
}

// ── principals & helpers ─────────────────────────────────────────────────────────────────────────────────────
interface Who {
  readonly name: string;
  readonly userId: string;
  readonly org: string;
  readonly roles: readonly string[];
}

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles ? roles.split(",") : ["clinical_rn"];
  request.context.locationIds = [];
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const VOLATILE_KEYS = new Set(["requestId", "correlationId", "timestamp", "traceId"]);
/** Status + body with ids and per-request fields masked, so a real id and a random id can be compared exactly. */
function shape(res: { statusCode: number; body: string }): string {
  let body: unknown = res.body;
  try {
    body = JSON.parse(res.body);
  } catch {
    // non-JSON body: compared verbatim
  }
  const scrub = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(scrub)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k]) => !VOLATILE_KEYS.has(k))
              .map(([k, x]) => [k, scrub(x)]),
          )
        : typeof v === "string"
          ? v.replace(UUID, "<id>")
          : v;
  return `${res.statusCode} ${JSON.stringify(scrub(body))}`;
}

describe.skipIf(!DB_URL)("M36 WP 1.7 tenant & IDOR proof — LIVE Postgres", () => {
  let admin: Client;
  let appUrl: string;
  let handle: { db: DbClient; close: () => Promise<void> };
  let service: ReturnType<typeof createDbMessagingRouteService>;
  let app: FastifyInstance;
  let orgA: string;
  let orgB: string;
  let u1: Who;
  let u2: Who;
  let outsider: Who;
  let adminA: Who;
  let bUser: Who;
  let b2: Who;
  let adminB: Who;
  let patientA: string;
  let dmA: string;
  let locA: string;
  let dmB: string;
  let msgDmA: string;
  let msgLocA: string;
  let endpointA: string;
  let alertA: string;
  let ruleA: string;
  let careTeamA: string;
  const exercised = new Set<string>();
  const attackers = new Set<string>();

  async function applyMigrations() {
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  const seedUser = async (name: string, org: string, roles: string[], label: string) => {
    const id = (
      await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$2) RETURNING id`, [
        `wp17-${name}@x.test`,
        `${label} ${name}`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, org],
    );
    return { name, userId: id, org, roles } satisfies Who;
  };

  const headers = (who: Who, extra: Record<string, string> = {}) => ({
    "x-test-user": who.userId,
    "x-test-org": who.org,
    "x-test-roles": who.roles.join(","),
    ...extra,
  });

  /** One request against a ROUTES key; `params` fills `:id`/`:userId`/`:patientId`. */
  async function call(
    route: string,
    who: Who,
    params: Record<string, string> = {},
    payload?: unknown,
    extraHeaders: Record<string, string> = {},
    query = "",
  ) {
    expect(ROUTES[route], `unknown route ${route}`).toBeDefined();
    const [method, template] = route.split(" ") as [string, string];
    let url = template;
    for (const [k, v] of Object.entries(params)) url = url.replace(`:${k}`, v);
    exercised.add(route);
    if (attackers.has(who.name)) exercisedByAttacker.add(route);
    const needsKey =
      route === "POST /api/v1/messaging/channels/:id/messages" ||
      route === "POST /api/v1/messaging/announce";
    const res = await app.inject({
      method: method as "GET",
      url: url + query,
      headers: headers(who, {
        ...(needsKey ? { "idempotency-key": randomUUID() } : {}),
        ...extraHeaders,
      }),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return res;
  }
  const exercisedByAttacker = new Set<string>();

  /** The world fingerprint: a row-hash of every table an M36 write could touch, plus audit and outbox. */
  const FINGERPRINT_TABLES = [
    "channel",
    "channel_member",
    "message",
    "message_revision",
    "message_receipt",
    "message_attachment",
    "message_entity_reference",
    "delivery_endpoint",
    "user_notification_preferences",
    "alert_rule",
    "alert_receipt",
    "audit_event",
    "outbox_event",
  ];
  async function fingerprint(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const t of FINGERPRINT_TABLES) {
      const r = await admin.query(
        `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`,
      );
      out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
    }
    return out;
  }
  const cell = async (sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params)).rows[0].n as number;

  /** attacker's call with a real foreign id must be indistinguishable from the same call with a random id. */
  async function expectNoOracle(
    route: string,
    attacker: Who,
    real: Record<string, string>,
    payload?: unknown,
    query = "",
  ) {
    attackers.add(attacker.name);
    const control = Object.fromEntries(Object.keys(real).map((k) => [k, randomUUID()]));
    const got = await call(route, attacker, real, payload, {}, query);
    const ctl = await call(route, attacker, control, payload, {}, query);
    const label = `${attacker.name} ${route} ${JSON.stringify(real)}`;
    expect(got.statusCode, `${label}: ${got.body}`).toBeGreaterThanOrEqual(400);
    expect(got.statusCode, label).toBeLessThan(500);
    expect(shape(got), `${label}: differs from a nonexistent id`).toBe(shape(ctl));
    expectNoLeak(got.body, attacker, label);
  }
  function expectNoLeak(body: string, attacker: Who, label: string) {
    expect(body, label).not.toContain(SECRET_BODY);
    expect(body, label).not.toContain(A_NAME_TOKEN);
    for (const w of [u1, u2, adminA, outsider]) {
      if (w.userId !== attacker.userId)
        expect(body, `${label} leaks ${w.name}`).not.toContain(w.userId);
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
    orgA = (
      await admin.query(
        "INSERT INTO organization (slug,legal_name,display_name) VALUES ('wp17-a','A','A') RETURNING id",
      )
    ).rows[0].id as string;
    orgB = (
      await admin.query(
        "INSERT INTO organization (slug,legal_name,display_name) VALUES ('wp17-b','B','B') RETURNING id",
      )
    ).rows[0].id as string;
    u1 = await seedUser("u1", orgA, ["clinical_rn"], A_NAME_TOKEN);
    u2 = await seedUser("u2", orgA, ["clinical_rn"], A_NAME_TOKEN);
    outsider = await seedUser("outsider", orgA, ["clinical_rn"], A_NAME_TOKEN);
    adminA = await seedUser("adminA", orgA, ["org_admin"], A_NAME_TOKEN);
    bUser = await seedUser("b1", orgB, ["clinical_rn"], "WP17-ORG-B-PERSON");
    b2 = await seedUser("b2", orgB, ["clinical_rn"], "WP17-ORG-B-PERSON");
    adminB = await seedUser("adminB", orgB, ["org_admin"], "WP17-ORG-B-PERSON");
    patientA = (
      await admin.query(
        `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,'MRN-WP17','Care','Team','1990-01-01','F','active') RETURNING id`,
        [orgA],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,'primary_rn',CURRENT_DATE)`,
      [patientA, orgA, u1.userId],
    );

    appUrl = await appRoleConnectionString(admin, DB_URL as string);
    handle = createDbClient({ connectionString: appUrl });
    registerPatientSeams({
      db: handle.db,
      careTeam: { store: createDrizzleCareTeamStore(handle.db) },
      readerStore: createDrizzlePatientReaderStore(handle.db),
    });
    registerSeam("ConsentEvaluator", createDbConsentEvaluator(handle.db));

    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
    };
    const provider = createDbMessagingProvider(handle.db);
    service = createDbMessagingRouteService(handle.db, {
      kek: KEK,
      outbox: outbox as never,
      syncCareTeamChannel: (o, p) => provider.syncCareTeamChannel(o, p),
      sendEndpointVerificationCode: async () => undefined,
    });

    const base = ["messaging.read", "messaging.send", "messaging.dm"];
    const self = ["notifications.preferences.manage", "notifications.endpoint.manage"];
    const adminKeys = [
      "messaging.manage_members",
      "messaging.announce",
      "alert.rules.read",
      "alert.rules.manage",
    ];
    const grants = createInMemoryEffectivePermissionStore(
      [u1, u2, outsider, adminA, bUser, b2, adminB].map((w) => ({
        orgId: w.org,
        userId: w.userId,
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: [
              ...base,
              ...self,
              ...(w.roles.includes("org_admin") ? adminKeys : ["alert.rules.read"]),
            ],
          },
        ],
      })),
    );
    registerEffectivePermissionResolver(grants.store);
    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registry.register(CHANNEL_MEMBER_ADMIN_PREDICATE, channelMemberAdminPredicate(service));
    registerAbacRegistry(registry);

    app = buildServer({
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(handle.db),
    });
    registerMessagingRoutes(app, { service });

    // ── fixtures: org A's private world, org B's own ────────────────────────────────────────────────────────
    dmA = (await service.openDm(orgA, u1.userId, u2.userId)).channelId;
    dmB = (await service.openDm(orgB, bUser.userId, b2.userId)).channelId;
    locA = (
      await admin.query(
        `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
         VALUES ($1,'location',$2,'WP17 private location','care_related') RETURNING id`,
        [orgA, randomUUID()],
      )
    ).rows[0].id as string;
    for (const w of [u1, u2]) {
      await admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
         VALUES ($1,$2,$3,'member','manual')`,
        [orgA, locA, w.userId],
      );
    }
    msgDmA = (
      await service.sendMessage(orgA, {
        channelId: dmA,
        authorUserId: u1.userId,
        body: SECRET_BODY,
      })
    ).messageId;
    msgLocA = (
      await service.sendMessage(orgA, {
        channelId: locA,
        authorUserId: u1.userId,
        body: SECRET_BODY,
      })
    ).messageId;
    await service.editMessage(orgA, {
      userId: u1.userId,
      messageId: msgDmA,
      body: `${SECRET_BODY} (edited)`,
    });
    await service.sendMessage(orgB, {
      channelId: dmB,
      authorUserId: bUser.userId,
      body: "org B hello",
    });
    await admin.query(
      `INSERT INTO message_attachment (message_id, document_ref, mime_type, byte_size, filename)
       VALUES ($1,$2,'application/pdf',10,'wp17.pdf')`,
      [msgDmA, randomUUID()],
    );
    careTeamA = (await service.openCareTeamChannel(orgA, u1.userId, patientA)).channelId;
    endpointA = (
      await service.registerEndpoint(orgA, u1.userId, { channel: "email", target: "wp17-a@x.test" })
    ).endpointId;
    await service.putPreferences(orgA, u1.userId, {
      routingMap: {},
      quietHours: { tz: "Pacific/Auckland", ranges: [], severityOverride: "critical" },
      vacationForwardToUserId: null,
      vacationUntil: null,
    });
    alertA = (
      await admin.query(
        `INSERT INTO alert (organization_id, event_type, severity, payload, correlation_id)
         VALUES ($1,'m36.test','warn','{"secret":"${A_NAME_TOKEN}"}','wp17') RETURNING id`,
        [orgA],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO notification_delivery (alert_id, recipient_user_id, alert_category, alert_severity, channel)
       VALUES ($1,$2,'clinical_routine','warn','email')`,
      [alertA, u1.userId],
    );
    const platformRule = (
      await admin.query(
        `INSERT INTO alert_rule (organization_id, event_type, category, severity_floor, recipient_resolver)
         VALUES (NULL,'wp17.test.event','operational','info','tenant_admins') RETURNING id`,
      )
    ).rows[0].id as string;
    ruleA = (
      await call("PATCH /api/v1/alert-rules/:id", adminA, { id: platformRule }, { enabled: false })
    ).json().ruleId as string;
    expect(ruleA).not.toBe(platformRule);
    exercised.clear();
    exercisedByAttacker.clear();
    attackers.clear();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close();
    await admin?.end();
  });

  // ── 1. coverage guard ──────────────────────────────────────────────────────────────────────────────────────
  describe("coverage guard", () => {
    it("every route a M36 registrar mounts has a verdict (and no verdict is stale)", () => {
      expect(registeredRoutes()).toEqual(Object.keys(ROUTES).sort());
    });
    it("every registrar file under routes/ is classified", () => {
      expect(
        readdirSync(ROUTES_DIR)
          .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
          .sort(),
      ).toEqual([...REGISTRAR_FILES].sort());
    });
  });

  // ── 2/3. no existence oracle, no leak ──────────────────────────────────────────────────────────────────────
  describe("channel-id routes: org B and an in-org non-member get the answer for a nonexistent id", () => {
    const channelRoutes = [
      "GET /api/v1/messaging/channels/:id",
      "GET /api/v1/messaging/channels/:id/messages",
      "GET /api/v1/messaging/channels/:id/mention-candidates",
    ];
    it("legitimate members read (the attacks below are not vacuous)", async () => {
      for (const ch of [dmA, locA]) {
        const res = await call("GET /api/v1/messaging/channels/:id/messages", u2, { id: ch });
        expect(res.statusCode).toBe(200);
        expect(JSON.stringify(res.json())).toContain("messageId");
      }
    });
    for (const route of channelRoutes) {
      it(`${route}`, async () => {
        for (const attacker of [bUser, outsider]) {
          for (const id of [dmA, locA, careTeamA]) await expectNoOracle(route, attacker, { id });
        }
      });
    }
    it("POST send (incl. a reply) into A's channels", async () => {
      const route = "POST /api/v1/messaging/channels/:id/messages";
      for (const attacker of [bUser, outsider]) {
        for (const id of [dmA, locA]) {
          await expectNoOracle(route, attacker, { id }, { body: "attack" });
          await expectNoOracle(
            route,
            attacker,
            { id },
            { body: "attack", parentMessageId: msgDmA },
          );
        }
      }
    });
    it("lists show only the caller's own channels", async () => {
      for (const [who, ownIds, foreign] of [
        [bUser, [dmB], [dmA, locA, careTeamA]],
        [outsider, [], [dmA, locA, careTeamA, dmB]],
        [b2, [dmB], [dmA, locA]],
      ] as Array<[Who, string[], string[]]>) {
        attackers.add(who.name);
        const res = await call("GET /api/v1/messaging/channels", who);
        expect(res.statusCode).toBe(200);
        const ids = (res.json().channels as Array<{ channelId: string }>).map((c) => c.channelId);
        for (const f of foreign) expect(ids).not.toContain(f);
        for (const o of ownIds) expect(ids).toContain(o);
        expectNoLeak(res.body, who, `list ${who.name}`);
      }
    });
  });

  describe("message-id routes", () => {
    it("edit / delete / mark-read of A's messages", async () => {
      for (const route of [
        "PATCH /api/v1/messaging/messages/:id",
        "DELETE /api/v1/messaging/messages/:id",
        "POST /api/v1/messaging/messages/:id/read",
      ]) {
        const payload = route.startsWith("PATCH")
          ? { body: "tampered" }
          : route.endsWith("read")
            ? {}
            : undefined;
        for (const attacker of [bUser, outsider]) {
          for (const id of [msgDmA, msgLocA])
            await expectNoOracle(route, attacker, { id }, payload);
        }
      }
    });
    it("a member who is not the author cannot edit or delete", async () => {
      attackers.add(u2.name);
      for (const [route, payload] of [
        ["PATCH /api/v1/messaging/messages/:id", { body: "tampered" }],
        ["DELETE /api/v1/messaging/messages/:id", undefined],
      ] as const) {
        const res = await call(route, u2, { id: msgDmA }, payload);
        expect(res.statusCode).toBe(403);
      }
      attackers.delete(u2.name);
    });
  });

  describe("reply / quote references from another tenant or channel", () => {
    it("parentMessageId and quotedMessageId must be a message of the SAME channel, else the answer for a random id", async () => {
      const route = "POST /api/v1/messaging/channels/:id/messages";
      const cases: Array<[Who, string, string]> = [
        [bUser, dmB, msgDmA], // another org's message
        [u1, locA, msgDmA], // another channel of the same org
        [outsider, dmA, msgDmA], // a channel the sender cannot see
      ];
      for (const [who, channel, foreign] of cases) {
        attackers.add(who.name);
        for (const field of ["parentMessageId", "quotedMessageId"] as const) {
          const real = await call(route, who, { id: channel }, { body: "x", [field]: foreign });
          const ctl = await call(route, who, { id: channel }, { body: "x", [field]: randomUUID() });
          const label = `${who.name} ${field}`;
          expect(real.statusCode, `${label}: ${real.body}`).toBe(ctl.statusCode);
          expect(real.statusCode, label).toBeGreaterThanOrEqual(400);
          expect(real.statusCode, label).toBeLessThan(500);
          expect(shape(real), label).toBe(shape(ctl));
          if (who === u1) {
            const code = field === "parentMessageId" ? "PARENT_MESSAGE_NOT_IN_CHANNEL" : "QUOTED_MESSAGE_NOT_IN_CHANNEL";
            expect(real.body, label).toContain(code);
          }
        }
      }
    });
    it("positive control: a same-channel parent and quote are accepted", async () => {
      const route = "POST /api/v1/messaging/channels/:id/messages";
      const ok = await call(route, u1, { id: dmA }, { body: "ok", parentMessageId: msgDmA, quotedMessageId: msgDmA });
      expect(ok.statusCode, ok.body).toBe(201);
    });
  });

  describe("dm, staff directory, care-team channel", () => {
    it("org B cannot open a DM with an org A user, same answer as for a random user", async () => {
      attackers.add(bUser.name);
      const real = await call("POST /api/v1/messaging/dm", bUser, {}, { userId: u1.userId });
      const ctl = await call("POST /api/v1/messaging/dm", bUser, {}, { userId: randomUUID() });
      expect(real.statusCode).toBe(404);
      expect(shape(real)).toBe(shape(ctl));
    });
    it("the staff directory never lists the other org", async () => {
      for (const [who, foreignToken] of [
        [bUser, A_NAME_TOKEN],
        [u1, "WP17-ORG-B-PERSON"],
      ] as Array<[Who, string]>) {
        attackers.add(who.name);
        const res = await call("GET /api/v1/messaging/dm/staff", who, {}, undefined, {}, "?q=WP17");
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain(foreignToken);
      }
    });
    it("a care-team channel for an org A patient is not reachable from org B, nor by an unassigned in-org user", async () => {
      const route = "POST /api/v1/messaging/patients/:patientId/care-team-channel";
      await expectNoOracle(route, bUser, { patientId: patientA });
      await expectNoOracle(route, outsider, { patientId: patientA });
    });
  });

  describe("member administration", () => {
    const addRoute = "POST /api/v1/messaging/channels/:id/members";
    const delRoute = "DELETE /api/v1/messaging/channels/:id/members/:userId";
    it("org B admin / A non-admin cannot add or remove members of A's channels", async () => {
      for (const attacker of [adminB, outsider]) {
        for (const id of [locA, dmA]) {
          await expectNoOracle(addRoute, attacker, { id }, { userId: attacker.userId });
          await expectNoOracle(delRoute, attacker, { id, userId: u1.userId });
        }
      }
    });
    it("an A admin cannot manage B's channel, nor pull a B user into A", async () => {
      await expectNoOracle(addRoute, adminA, { id: dmB }, { userId: u1.userId });
      await expectNoOracle(delRoute, adminA, { id: dmB, userId: bUser.userId });
      attackers.add(adminA.name);
      const real = await call(addRoute, adminA, { id: locA }, { userId: bUser.userId });
      const ctl = await call(addRoute, adminA, { id: locA }, { userId: randomUUID() });
      expect(real.statusCode).toBeGreaterThanOrEqual(400);
      expect(shape(real)).toBe(shape(ctl));
      attackers.delete(adminA.name);
    });
  });

  describe("announce, notifications, alerts, rules", () => {
    it("an org B admin's announcement lands in B only; a non-admin and a forged org header are refused", async () => {
      const before = await cell(`SELECT count(*)::int AS n FROM message WHERE organization_id=$1`, [
        orgA,
      ]);
      attackers.add(adminB.name);
      const ok = await call("POST /api/v1/messaging/announce", adminB, {}, { body: "from B" });
      expect(ok.statusCode).toBe(201);
      expect(
        await cell(`SELECT count(*)::int AS n FROM channel WHERE id=$1 AND organization_id=$2`, [
          ok.json().channelId,
          orgB,
        ]),
      ).toBe(1);
      expect(
        await cell(`SELECT count(*)::int AS n FROM message WHERE organization_id=$1`, [orgA]),
      ).toBe(before);
      attackers.add(outsider.name);
      expect(
        (await call("POST /api/v1/messaging/announce", outsider, {}, { body: "x" })).statusCode,
      ).toBe(403);
      const forged = { ...adminB, org: orgA, name: "adminB-forged-org" };
      attackers.add(forged.name);
      for (const [route, params, payload] of [
        ["POST /api/v1/messaging/announce", {}, { body: "x" }],
        ["GET /api/v1/messaging/channels", {}, undefined],
        ["GET /api/v1/messaging/channels/:id/messages", { id: dmA }, undefined],
      ] as const) {
        const res = await call(route, forged, params, payload);
        expect(res.statusCode, route).toBeGreaterThanOrEqual(400);
      }
      expect(
        await cell(`SELECT count(*)::int AS n FROM message WHERE organization_id=$1`, [orgA]),
      ).toBe(before);
    });
    it("preferences are per user and org; B cannot forward vacation to an A user", async () => {
      attackers.add(bUser.name);
      const res = await call("GET /api/v1/notifications/preferences", bUser);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("Pacific/Auckland");
      const body = (to: string) => ({
        routingMap: {},
        quietHours: { tz: "UTC", ranges: [], severityOverride: "critical" },
        vacationForwardToUserId: to,
        vacationUntil: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const real = await call("PUT /api/v1/notifications/preferences", bUser, {}, body(u1.userId));
      const ctl = await call(
        "PUT /api/v1/notifications/preferences",
        bUser,
        {},
        body(randomUUID()),
      );
      expect(real.statusCode).toBeGreaterThanOrEqual(400);
      expect(shape(real)).toBe(shape(ctl));
    });
    it("endpoints of another user or org are a 404 like a random id", async () => {
      attackers.add("endpoint-attackers");
      await call(
        "POST /api/v1/notifications/endpoints",
        u2,
        {},
        { channel: "email", target: "wp17-u2@x.test" },
      );
      for (const attacker of [bUser, u2]) {
        await expectNoOracle(
          "POST /api/v1/notifications/endpoints/:id/verify",
          attacker,
          { id: endpointA },
          { token: "000000" },
        );
        await expectNoOracle("DELETE /api/v1/notifications/endpoints/:id", attacker, {
          id: endpointA,
        });
      }
    });
    it("alerts: B's inbox is empty of A's, and A's alert id cannot be marked read from B", async () => {
      attackers.add(bUser.name);
      const inbox = await call("GET /api/v1/alerts/inbox", bUser);
      expect(inbox.statusCode).toBe(200);
      expect(inbox.body).not.toContain(A_NAME_TOKEN);
      expect(inbox.body).not.toContain(alertA);
      await expectNoOracle("POST /api/v1/alerts/:id/read", bUser, { id: alertA });
      await expectNoOracle("POST /api/v1/alerts/:id/read", outsider, { id: alertA });
    });
    it("alert rules: B never sees or patches A's override", async () => {
      attackers.add(adminB.name);
      const list = await call("GET /api/v1/alert-rules", adminB);
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain(ruleA);
      expect(list.body).not.toContain(orgA);
      await expectNoOracle(
        "PATCH /api/v1/alert-rules/:id",
        adminB,
        { id: ruleA },
        { enabled: true },
      );
    });
    it("the platform-ops drill and vendor webhooks refuse a tenant admin / an unsigned call", async () => {
      const probe = buildServer({
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      registerAdminAlertDeliveriesRoutes(probe, {
        list: async () => [],
        audit: async () => undefined,
      } as never);
      registerMessagingWebhookRoutes(probe, {
        publicBaseUrl: "https://api.wardenx.test",
        resolveTwilioAuthToken: () => "t",
        service: {
          recordTwilioSmsStatus: async () => {
            throw new Error("must not run");
          },
        },
      } as never);
      try {
        const drill = await probe.inject({
          method: "GET",
          url: "/api/v1/admin/messaging/alert-deliveries",
          headers: headers(adminA),
        });
        expect(drill.statusCode).toBeGreaterThanOrEqual(401);
        expect(drill.statusCode).toBeLessThan(500);
        const hook = await probe.inject({
          method: "POST",
          url: "/webhooks/twilio/sms-status",
          payload: { MessageSid: "SM1", MessageStatus: "delivered" },
        });
        expect(hook.statusCode).toBeGreaterThanOrEqual(400);
        expect(hook.statusCode).toBeLessThan(500);
      } finally {
        await probe.close();
      }
    });
  });

  // ── 4. nothing changed ─────────────────────────────────────────────────────────────────────────────────────
  describe("the attack battery wrote nothing", () => {
    it("re-running every attack leaves each M36 table, audit_event and outbox_event byte-identical", async () => {
      // Freeze the world, replay a cross-section of the denied calls, compare. (The per-test assertions above already
      // proved every one of these is a 4xx; this proves a 4xx did not leave a partial write behind.)
      const before = await fingerprint();
      const replay: Array<[string, Who, Record<string, string>, unknown?]> = [
        ["PATCH /api/v1/messaging/messages/:id", bUser, { id: msgDmA }, { body: "tampered" }],
        ["PATCH /api/v1/messaging/messages/:id", outsider, { id: msgLocA }, { body: "tampered" }],
        ["DELETE /api/v1/messaging/messages/:id", bUser, { id: msgDmA }],
        ["DELETE /api/v1/messaging/messages/:id", outsider, { id: msgLocA }],
        ["POST /api/v1/messaging/messages/:id/read", bUser, { id: msgDmA }, {}],
        ["POST /api/v1/messaging/messages/:id/read", outsider, { id: msgLocA }, { upTo: true }],
        ["POST /api/v1/messaging/channels/:id/messages", bUser, { id: dmA }, { body: "x" }],
        [
          "POST /api/v1/messaging/channels/:id/messages",
          outsider,
          { id: locA },
          { body: "x", parentMessageId: msgLocA },
        ],
        [
          "POST /api/v1/messaging/channels/:id/messages",
          bUser,
          { id: dmB },
          { body: "x", parentMessageId: msgDmA },
        ],
        [
          "POST /api/v1/messaging/channels/:id/messages",
          bUser,
          { id: dmB },
          { body: "x", quotedMessageId: msgDmA },
        ],
        [
          "POST /api/v1/messaging/channels/:id/messages",
          u1,
          { id: locA },
          { body: "x", quotedMessageId: msgDmA },
        ],
        [
          "POST /api/v1/messaging/channels/:id/members",
          adminB,
          { id: locA },
          { userId: bUser.userId },
        ],
        [
          "POST /api/v1/messaging/channels/:id/members",
          adminA,
          { id: locA },
          { userId: bUser.userId },
        ],
        [
          "DELETE /api/v1/messaging/channels/:id/members/:userId",
          adminB,
          { id: locA, userId: u1.userId },
        ],
        ["POST /api/v1/messaging/announce", outsider, {}, { body: "x" }],
        ["POST /api/v1/messaging/dm", bUser, {}, { userId: u1.userId }],
        [
          "POST /api/v1/notifications/endpoints/:id/verify",
          bUser,
          { id: endpointA },
          { token: "000000" },
        ],
        ["DELETE /api/v1/notifications/endpoints/:id", bUser, { id: endpointA }],
        ["POST /api/v1/alerts/:id/read", bUser, { id: alertA }],
        ["PATCH /api/v1/alert-rules/:id", adminB, { id: ruleA }, { enabled: true }],
      ];
      for (const [route, who, params, payload] of replay) {
        const res = await call(route, who, params, payload);
        expect(res.statusCode, `${who.name} ${route}`).toBeGreaterThanOrEqual(400);
      }
      expect(await fingerprint()).toEqual(before);
    });
  });

  // ── coverage: every route was driven by an attacker (idor) or by two orgs (scoped) ─────────────────────────
  describe("route coverage", () => {
    it("every idor route was attacked and every scoped route exercised in this run", () => {
      const missing = Object.entries(ROUTES)
        .filter(([route, v]) =>
          v.kind === "idor"
            ? !exercisedByAttacker.has(route)
            : v.kind === "scoped"
              ? !exercised.has(route)
              : false,
        )
        .map(([route]) => route);
      expect(missing).toEqual([]);
    });
  });

  // ── 5. RLS at the database, as the app role ────────────────────────────────────────────────────────────────
  describe("RLS as the real wardenx_app role with app.org_id = B", () => {
    async function asOrgB<T>(fn: (c: Client) => Promise<T>): Promise<T> {
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.org_id', $1, true)", [orgB]);
        return await fn(c);
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        await c.end();
      }
    }
    it("connects as a non-superuser, non-BYPASSRLS role", async () => {
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      const r = await c.query(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      await c.end();
      expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });
    const orgScoped = [
      "channel",
      "channel_member",
      "message",
      "message_revision",
      "message_receipt",
    ];
    it.each(orgScoped)(
      "SELECT on %s returns no org A rows (and the table is non-empty for A)",
      async (table) => {
        expect(
          await cell(`SELECT count(*)::int AS n FROM "${table}" WHERE organization_id=$1`, [orgA]),
        ).toBeGreaterThan(0);
        await asOrgB(async (c) => {
          const a = await c.query(
            `SELECT count(*)::int AS n FROM "${table}" WHERE organization_id=$1`,
            [orgA],
          );
          expect(a.rows[0].n).toBe(0);
          const all = await c.query(`SELECT DISTINCT organization_id FROM "${table}"`);
          expect(all.rows.every((r) => r.organization_id === orgB)).toBe(true);
        });
      },
    );
    it("message_attachment (child of message) is unreadable for org A's message", async () => {
      expect(await cell(`SELECT count(*)::int AS n FROM message_attachment`)).toBeGreaterThan(0);
      await asOrgB(async (c) => {
        expect((await c.query("SELECT count(*)::int AS n FROM message_attachment")).rows[0].n).toBe(
          0,
        );
      });
    });
    it("with no org context at all nothing is readable", async () => {
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        for (const t of [...orgScoped, "message_attachment"]) {
          expect((await c.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n, t).toBe(0);
        }
      } finally {
        await c.end();
      }
    });
    it("INSERT carrying org A's organization_id is rejected by WITH CHECK", async () => {
      const inserts: Array<[string, string, () => unknown[]]> = [
        [
          "message",
          `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256)
           VALUES ($1,$2,$3,'user','\\x00',repeat('a',64))`,
          () => [dmA, orgA, u1.userId],
        ],
        [
          "channel",
          `INSERT INTO channel (organization_id, channel_kind, title, retention_class) VALUES ($1,'announcement','x','operational')`,
          () => [orgA],
        ],
        [
          "channel_member",
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source) VALUES ($1,$2,$3,'member','manual')`,
          () => [orgA, dmA, outsider.userId],
        ],
        [
          "message_receipt",
          `INSERT INTO message_receipt (organization_id, message_id, user_id) VALUES ($1,$2,$3)`,
          () => [orgA, msgLocA, outsider.userId],
        ],
        [
          "message_revision",
          `INSERT INTO message_revision (organization_id, message_id, revision_no, body_cipher, body_sha256, body_kind, body_written_at, edited_by)
           VALUES ($1,$2,99,'\\x00',repeat('a',64),'plain',now(),$3)`,
          () => [orgA, msgDmA, u1.userId],
        ],
        [
          "message_attachment",
          `INSERT INTO message_attachment (message_id, document_ref, mime_type, byte_size, filename) VALUES ($1,$2,'a/b',1,'x')`,
          () => [msgDmA, randomUUID()],
        ],
      ];
      for (const [table, sql, args] of inserts) {
        await asOrgB(async (c) => {
          // message_attachment has no organization_id of its own (parent-join policy), so any
          // rejection is accepted there; every other table must be refused by RLS itself.
          const reason =
            table === "message_attachment"
              ? /row-level security|violates|permission denied|not-null|null value/i
              : /row-level security/i;
          await expect(c.query(sql, args()), table).rejects.toThrow(reason);
        });
      }
      expect(
        await cell(`SELECT count(*)::int AS n FROM message WHERE body_sha256 = repeat('a',64)`),
      ).toBe(0);
    });
    it("composite FKs: an org B row cannot point at an org A channel or message (FK checks bypass RLS)", async () => {
      const insMsg = `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, parent_message_id, quoted_message_id)
                      VALUES ($1,$2,$3,'user','\\x00',repeat('a',64),$4,$5)`;
      const cases: Array<[string, string, unknown[]]> = [
        ["message.channel_id -> org A channel", insMsg, [dmA, orgB, bUser.userId, null, null]],
        ["message.parent_message_id -> org A message", insMsg, [dmB, orgB, bUser.userId, msgDmA, null]],
        ["message.quoted_message_id -> org A message", insMsg, [dmB, orgB, bUser.userId, null, msgDmA]],
        [
          "channel_member.channel_id -> org A channel",
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source) VALUES ($1,$2,$3,'member','manual')`,
          [orgB, dmA, bUser.userId],
        ],
        [
          "message_receipt.message_id -> org A message",
          `INSERT INTO message_receipt (organization_id, message_id, user_id) VALUES ($1,$2,$3)`,
          [orgB, msgDmA, bUser.userId],
        ],
      ];
      for (const [label, sql, args] of cases) {
        await asOrgB(async (c) => {
          await expect(c.query(sql, args), label).rejects.toThrow(/violates foreign key constraint/i);
        });
      }
      // positive control: the same message insert against org B's own channel is accepted
      await asOrgB(async (c) => {
        const ok = await c.query(insMsg, [dmB, orgB, bUser.userId, null, null]);
        expect(ok.rowCount).toBe(1);
      });
    });
    it("channel_member.last_read_message_id: a cross-tenant pointer is refused; erasing the message only nulls the pointer", async () => {
      const upd = `UPDATE channel_member SET last_read_message_id = $1
                   WHERE organization_id = $2 AND channel_id = $3 AND user_id = $4`;
      await asOrgB(async (c) => {
        await expect(c.query(upd, [msgDmA, orgB, dmB, bUser.userId])).rejects.toThrow(
          /violates foreign key constraint/i,
        );
      });
      // SET NULL: point u1's membership at a throwaway org A message, erase it, the member row survives
      const mid = (
        await admin.query(
          `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256)
           VALUES ($1,$2,$3,'user','\\x00',repeat('b',64)) RETURNING id`,
          [dmA, orgA, u1.userId],
        )
      ).rows[0].id as string;
      await admin.query(upd, [mid, orgA, dmA, u1.userId]);
      expect(
        await cell(`SELECT count(*)::int AS n FROM channel_member WHERE last_read_message_id = $1`, [
          mid,
        ]),
      ).toBe(1);
      await admin.query(`DELETE FROM message WHERE id = $1`, [mid]);
      expect(
        await cell(
          `SELECT count(*)::int AS n FROM channel_member
            WHERE organization_id = $1 AND channel_id = $2 AND user_id = $3 AND last_read_message_id IS NULL`,
          [orgA, dmA, u1.userId],
        ),
      ).toBe(1);
    });
    it("UPDATE / DELETE of org A rows touches zero rows; moving a B row into org A is rejected", async () => {
      await asOrgB(async (c) => {
        const upd = await c.query(
          `UPDATE message SET status='deleted', deleted_at=now(), edited_at=NULL WHERE organization_id=$1 OR id=$2`,
          [orgA, msgDmA],
        );
        expect(upd.rowCount).toBe(0);
        expect((await c.query(`UPDATE channel SET title='pwn' WHERE id=$1`, [dmA])).rowCount).toBe(
          0,
        );
        expect(
          (await c.query(`UPDATE channel_member SET removed_at=now() WHERE channel_id=$1`, [locA]))
            .rowCount,
        ).toBe(0);
        expect(
          (
            await c.query(
              `UPDATE message_receipt SET status='read', read_at=now() WHERE message_id=$1`,
              [msgDmA],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (await c.query(`DELETE FROM message_attachment WHERE message_id=$1`, [msgDmA])).rowCount,
        ).toBe(0);
        expect(
          (await c.query(`DELETE FROM channel_member WHERE channel_id=$1`, [locA])).rowCount,
        ).toBe(0);
      });
      await asOrgB(async (c) => {
        await expect(
          c.query(`UPDATE channel SET organization_id=$1 WHERE id=$2`, [orgA, dmB]),
        ).rejects.toThrow(/row-level security/i);
      });
      expect(
        await cell(`SELECT count(*)::int AS n FROM channel WHERE id=$1 AND organization_id=$2`, [
          dmB,
          orgB,
        ]),
      ).toBe(1);
    });
  });
});

// ── 6. sockets ───────────────────────────────────────────────────────────────────────────────────────────────
// Needs Postgres (real service) and Valkey. The gateway is the real one; authentication is a token table and the room
// set is the production `resolveRooms` body (computeRoomSet over the real `listChannels`).
describe.skipIf(!DB_URL || !REDIS_URL)(
  "M36 WP 1.7 realtime: no cross-tenant or non-member hint",
  () => {
    // The Postgres fixture is rebuilt here so this block is independent of the HTTP block above.
    let admin: Client;
    let handle: { db: DbClient; close: () => Promise<void> };
    let service: ReturnType<typeof createDbMessagingRouteService>;
    const redis: Redis[] = [];
    const clients: Socket[] = [];
    let httpServer: Server;
    let realtime: RealtimeHandle;
    let url: string;
    let orgA: string;
    let orgB: string;
    let member: string;
    let peer: string;
    let nonMember: string;
    let foreign: string;
    let privateA: string;
    let privateMsg: string;

    const newRedis = () => {
      const r = new Redis(REDIS_URL as string, { maxRetriesPerRequest: null });
      r.on("error", () => {});
      redis.push(r);
      return r;
    };
    const readyEmitter = async () => {
      const r = newRedis();
      await new Promise<void>((res) =>
        r.status === "ready" ? res() : r.once("ready", () => res()),
      );
      return createRealtimeEmitter(r);
    };
    const open = (token: string) => {
      const s = connect(url, {
        transports: ["websocket"],
        reconnection: false,
        extraHeaders: { cookie: `better-auth.session_token=${token}`, origin: ORIGIN },
      });
      clients.push(s);
      return s;
    };
    const connected = (s: Socket) =>
      new Promise<void>((res, rej) => {
        s.once("connect", () => res());
        s.once("connect_error", (e) => rej(e));
      });
    /** Every hint a socket receives within `ms`. */
    const hintsWithin = (s: Socket, ms: number) =>
      new Promise<unknown[]>((res) => {
        const got: unknown[] = [];
        const on = (h: unknown) => got.push(h);
        s.on("hint", on);
        setTimeout(() => {
          s.off("hint", on);
          res(got);
        }, ms);
      });

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
        let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (process.env.WARDENX_TEST_NO_PGVECTOR) {
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
          sql = sql.replace(/\bvector\(\d+\)/g, "text");
          sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
        }
        await admin.query(sql);
      }
      const org = async (slug: string) =>
        (
          await admin.query(
            `INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,$1,$1) RETURNING id`,
            [slug],
          )
        ).rows[0].id as string;
      orgA = await org("wp17s-a");
      orgB = await org("wp17s-b");
      const user = async (n: string, o: string) => {
        const id = (
          await admin.query(`INSERT INTO "user" (email,name) VALUES ($1,$1) RETURNING id`, [
            `wp17s-${n}@x.test`,
          ])
        ).rows[0].id as string;
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
          [id, o],
        );
        return id;
      };
      member = await user("member", orgA);
      peer = await user("peer", orgA);
      nonMember = await user("nonmember", orgA);
      foreign = await user("foreign", orgB);
      handle = createDbClient({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
      const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
      service = createDbMessagingRouteService(handle.db, {
        kek: KEK,
        outbox: {
          publish: (tx: unknown, e: Record<string, unknown>) =>
            publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
        } as never,
      });
      privateA = (await service.openDm(orgA, member, peer)).channelId;
      privateMsg = (
        await service.sendMessage(orgA, {
          channelId: privateA,
          authorUserId: member,
          body: "hello",
        })
      ).messageId;

      const principals: Record<string, RealtimePrincipal> = {
        tok_member: { userId: member, organizationId: orgA, sessionId: "s1" },
        tok_nonmember: { userId: nonMember, organizationId: orgA, sessionId: "s2" },
        tok_foreign: { userId: foreign, organizationId: orgB, sessionId: "s3" },
      };
      httpServer = createServer();
      const pub = newRedis();
      const sub = pub.duplicate();
      sub.on("error", () => {});
      redis.push(sub);
      realtime = startRealtimeServer({
        httpServer,
        pubClient: pub,
        subClient: sub,
        trustedOrigins: [ORIGIN],
        recheckIntervalMs: 60_000,
        authenticate: async (h) =>
          principals[/session_token=([^;]+)/.exec(h.cookie ?? "")?.[1] ?? ""] ?? null,
        // the production resolveRooms body (apps/backend/src/index.ts)
        resolveRooms: async ({ organizationId, userId }) =>
          computeRoomSet({
            userId,
            orgId: organizationId,
            channels: (await service.listChannels(organizationId, userId)).map((c) => ({
              channelId: c.channelId,
              kind: c.kind,
              subjectId: c.subjectId,
            })),
          }),
        stillValid: async () => true,
      });
      await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    }, 240_000);

    afterAll(async () => {
      for (const c of clients) c.close();
      await realtime?.close();
      httpServer?.close();
      for (const r of redis) r.disconnect();
      await handle?.close();
      await admin?.end();
    });

    it("a committed message in a private channel hints its members only: not a non-member, not another org", async () => {
      const [m, nm, f] = [open("tok_member"), open("tok_nonmember"), open("tok_foreign")];
      await Promise.all([connected(m), connected(nm), connected(f)]);
      await new Promise((r) => setTimeout(r, 300));
      const emitter = await readyEmitter();
      const consumer = buildM36MessageHintConsumer({
        audience: (o, c) => channelHintAudience(handle.db, o, c),
        emitToRooms: (rooms, hint) => emitter.emit(rooms, "hint", hint),
      });
      const event = (organizationId: string, channelId: string) => ({
        id: randomUUID(),
        organizationId,
        eventType: "m36.message.sent",
        aggregateKind: "message",
        aggregateId: privateMsg,
        payload: { organizationId, channelId, messageId: privateMsg, at: new Date().toISOString() },
        attemptCount: 0,
        createdAt: new Date(),
      });
      const heard = [hintsWithin(m, 1200), hintsWithin(nm, 1200), hintsWithin(f, 1200)];
      await consumer.handle(event(orgA, privateA));
      // a forged envelope: org B's tenant with org A's channel id - RLS makes the audience empty, nothing is emitted
      await consumer.handle(event(orgB, privateA));
      const [forMember, forNonMember, forForeign] = await Promise.all(heard);
      expect(forMember).toHaveLength(1);
      expect(forMember![0]).toMatchObject({ ids: { channelId: privateA, messageId: privateMsg } });
      expect(forNonMember).toEqual([]);
      expect(forForeign).toEqual([]);
    });

    it("a client cannot choose a room: join / subscribe / channel names from the client deliver nothing", async () => {
      const nm = open("tok_nonmember");
      const f = open("tok_foreign");
      await Promise.all([connected(nm), connected(f)]);
      const targets = [
        `user:${orgA}:${member}`,
        `channel:${privateA}`,
        privateA,
        `account:${member}`,
      ];
      for (const s of [nm, f]) {
        for (const evt of ["join", "subscribe", "join_room", "channel.subscribe"]) {
          for (const t of targets) s.emit(evt, t);
          s.emit(evt, { room: targets[0], channelId: privateA });
        }
      }
      await new Promise((r) => setTimeout(r, 300));
      const emitter = await readyEmitter();
      const heard = [hintsWithin(nm, 1000), hintsWithin(f, 1000)];
      await emitter.emit(targets, "hint", {
        kind: "message.new",
        cursor: "c",
        ids: { channelId: privateA },
      });
      expect(await Promise.all(heard)).toEqual([[], []]);
    });

    it("an announcement hint goes to the sender's org room only", async () => {
      const nm = open("tok_nonmember");
      const f = open("tok_foreign");
      await Promise.all([connected(nm), connected(f)]);
      await new Promise((r) => setTimeout(r, 300));
      const emitter = await readyEmitter();
      const heard = [hintsWithin(nm, 1000), hintsWithin(f, 1000)];
      await emitter.emit([`org:${orgA}`], "hint", { kind: "message.new", cursor: "c", ids: {} });
      const [forA, forB] = await Promise.all(heard);
      expect(forA).toHaveLength(1);
      expect(forB).toEqual([]);
    });
  },
);
