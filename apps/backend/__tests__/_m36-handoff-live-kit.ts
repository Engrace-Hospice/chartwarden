// WP 3.5 live-suite support (not a test file): the database/app-role bootstrap, the user and channel seeding, the real
// catalog-validating outbox publisher, the handoff binding and the HTTP helpers both handoff live suites share.
// Every handoff write runs as the NOBYPASSRLS `wardenx_app` role; the superuser `admin` connection only seeds and inspects.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
} from "@chartwarden/auth";
import { type DbClient, createDbClient } from "@chartwarden/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import { buildHandoffDeps } from "../src/modules/36-messaging/handoffs/deps";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { buildTaskDeps } from "../src/modules/36-messaging/tasks/deps";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

export const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
export const ROLES = [
  "wardenx_destruction",
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
];
export const HANDOFF_FLAG = "messaging.handoffs";
export const STAFF_KEYS = ["messaging.read", "messaging.send", "patient.read"];
export const ADMIN_KEYS = [...STAFF_KEYS, "messaging.template.manage"];

export function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["clinical_rn"];
  request.context.locationIds = [];
}

export const plainDoc = (value: string) => ({
  schemaVersion: 1,
  doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] },
});
export const errorCode = (res: { json(): { error?: { code?: string }; code?: string } }) =>
  res.json().error?.code ?? res.json().code;

export interface LiveKit {
  readonly admin: Client;
  readonly appConn: Client;
  readonly handle: { db: DbClient; close: () => Promise<void> };
  readonly service: ReturnType<typeof createDbMessagingRouteService>;
  readonly orgA: string;
  readonly orgB: string;
  /** Mutable test knobs the binding's ports read lazily. */
  readonly caseload: Map<string, string[]>;
  readonly part2Denied: Set<string>;
  readonly noPermissions: Set<string>;
  readonly seedUser: (suffix: string, orgId: string, keys?: string[]) => Promise<string>;
  readonly build: (enabled: boolean) => {
    server: FastifyInstance;
    handoffs: ReturnType<typeof buildHandoffDeps>;
    tasks: ReturnType<typeof buildTaskDeps>;
  };
  readonly one: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  readonly count: (sql: string, params?: unknown[]) => Promise<number>;
  readonly close: () => Promise<void>;
}

async function applyMigrations(admin: Client): Promise<void> {
  const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
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

export function catalogOutbox() {
  const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
  return {
    publish: (tx: unknown, e: Record<string, unknown>) =>
      publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
  };
}

export async function bootLiveKit(
  dbUrl: string,
  orgA: string,
  orgB: string,
  tag: string,
): Promise<LiveKit> {
  const admin = new Client({ connectionString: dbUrl });
  await admin.connect();
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  for (const r of ROLES) {
    await admin.query(
      `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
        `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
    );
  }
  await applyMigrations(admin);
  await admin.query(
    `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'${tag}-a','A','A'),($2,'${tag}-b','B','B')`,
    [orgA, orgB],
  );
  await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
  const handle = createDbClient({ connectionString: appRoleUrl(dbUrl) });
  const appConn = new Client({ connectionString: appRoleUrl(dbUrl) });
  await appConn.connect();

  const granted: Array<{ orgId: string; userId: string; keys: string[] }> = [];
  const caseload = new Map<string, string[]>();
  const part2Denied = new Set<string>();
  const noPermissions = new Set<string>();
  let seq = 0;
  const KEK = randomBytes(32);

  const service = createDbMessagingRouteService(handle.db, {
    kek: KEK,
    outbox: catalogOutbox() as never,
    part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
  });
  const registry = createPredicateRegistry();
  registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
    const channelId = typeof target.id === "string" ? target.id : null;
    if (!channelId || !ctx.organizationId || !ctx.userId) return false;
    return service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
  });
  registerAbacRegistry(registry);

  const seedUser = async (suffix: string, orgId: string, keys: string[] = STAFF_KEYS) => {
    seq += 1;
    const id = (
      await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$2) RETURNING id`, [
        `${tag}-${suffix}-${seq}@x.test`,
        `${tag} ${suffix}`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, orgId],
    );
    granted.push({ orgId, userId: id, keys });
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore(
        granted.map((g) => ({
          orgId: g.orgId,
          userId: g.userId,
          grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: g.keys }],
        })),
      ).store,
    );
    return id;
  };

  const build: LiveKit["build"] = (enabled) => {
    const outbox = catalogOutbox();
    const tasks = buildTaskDeps({
      db: handle.db,
      flags: { forOrg: async () => ({ "messaging.tasks": true }) },
      outbox: outbox as never,
      messaging: service,
      careTeamMembers: async () => [],
    });
    const handoffs = buildHandoffDeps({
      db: handle.db,
      flags: { forOrg: async () => ({ [HANDOFF_FLAG]: enabled }) },
      outbox: outbox as never,
      messaging: service,
      caseloadPatientIds: async (_org, userId) => caseload.get(userId) ?? [],
      patientLabels: async (_org, ids) =>
        new Map(ids.map((id) => [id, { displayName: "Ann B.", mrnSuffix: "1234" }] as const)),
      part2Gate: {
        allowedUserIds: async ({ patientId, userIds }) =>
          new Set(userIds.filter((u) => !part2Denied.has(`${u}:${patientId}`))),
      },
      permissionsFor: async (_org, userId) =>
        noPermissions.has(userId) ? new Set<string>() : new Set(STAFF_KEYS),
    });
    const server = buildServer({
      db: handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(handle.db),
    });
    registerMessagingRoutes(server, {
      service,
      announcements: createDbAnnouncementService(handle.db),
      tasks,
      handoffs,
    });
    return { server, handoffs, tasks };
  };

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params)).rows as T[];
  return {
    admin,
    appConn,
    handle,
    service,
    orgA,
    orgB,
    caseload,
    part2Denied,
    noPermissions,
    seedUser,
    build,
    one,
    count: async (sql, params = []) => (await one<{ n: number }>(sql, params))[0]?.n ?? 0,
    close: async () => {
      await handle.close();
      await appConn.end();
      await admin.end();
    },
  };
}

/** A care-team channel for a patient (the task derives its patient from the channel subject). */
export async function mkChannel(
  kit: LiveKit,
  kind: string,
  subject: string | null,
  members: string[],
): Promise<string> {
  const id = (
    await kit.admin.query(
      `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
       VALUES ($1,$2,$3,$4,'care_related') RETURNING id`,
      [kit.orgA, kind, subject, `wp35-${kind}-${randomUUID().slice(0, 8)}`],
    )
  ).rows[0].id as string;
  for (const userId of members) {
    await kit.admin.query(
      `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
       VALUES ($1,$2,$3,'member','manual')`,
      [kit.orgA, id, userId],
    );
  }
  return id;
}

export const as = (userId: string, org: string, key?: string) => ({
  "x-test-user": userId,
  "x-test-org": org,
  ...(key ? { "idempotency-key": key } : {}),
});
