/**
 * M36 WP 3.4 - communication tasks, LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * The real route stack (Authorization Contract, `channel_visibility`, the DB route service, the audit plumbing) over the
 * REAL catalog-validating outbox publisher (not NOOP_OUTBOX), so every payload is checked against the catalog schema.
 *
 *   1. IDEMPOTENCY  N concurrent creates for one (message, assignee) => 1 row, 1 created event, 1 outbox row; a closed
 *                   prior task does not block a new one.
 *   2. LIFECYCLE    accept / complete / cancel / reassign through the routes; the clinical close-reason rule; 403 and 404.
 *   3. TENANCY      org B reads and mutates nothing of org A (HTTP and raw SQL); a cross-org insert is rejected.
 *   4. CHECKS       the DB itself refuses a clinical close without a reason, a non-clinical patient task, etc.
 *   5. GRANTS       wardenx_app cannot DELETE either table, cannot UPDATE identity columns, event rows are append-only.
 *   6. AUDIT        trigger rows land for the task and its events; the patient id is never copied; the read event lands.
 *   7. OFFBOARDING  revoke / deactivate => creator, then care team, else needs_owner; redelivery converges; suspend no-op.
 *   8. CASCADE      a hard-deleted message removes its tasks and events.
 *   9. TILE         the open-tasks count is the caller's own, on channels the caller can still view.
 *  10. FLAG         off => 404 / disabled list.  11. WIRING: the boot builds, binds and reassigns (bound is computing).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m36:tasks:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the wardenx_* roles.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
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
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { endChannelMembershipsForUser } from "../src/modules/36-messaging/messaging-provider-db";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { buildM36AccessRevocationConsumer } from "../src/modules/36-messaging/outbox-consumers/access-revocation";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { buildTaskDeps } from "../src/modules/36-messaging/tasks/deps";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_destruction",
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
];
const KEK = randomBytes(32);
const ORG_A = "11111111-1111-4111-8111-1111000e0001";
const ORG_B = "22222222-2222-4222-8222-2222000e0002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-00000000e1e1";
const FLAG = "messaging.tasks";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["clinical_rn"];
  request.context.locationIds = [];
}

const plainDoc = (value: string) => ({
  schemaVersion: 1,
  doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] },
});
const errorCode = (res: { json(): { error?: { code?: string }; code?: string } }) =>
  res.json().error?.code ?? res.json().code;

describe.skipIf(!DB_URL)("M36 WP 3.4 communication tasks - LIVE Postgres", () => {
  let admin: Client;
  let appConn: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let service: ReturnType<typeof createDbMessagingRouteService>;
  let app: FastifyInstance;
  let offApp: FastifyInstance;
  let binding: ReturnType<typeof buildTaskDeps>;
  let creator: string;
  let assignee: string;
  let third: string;
  let outsider: string;
  let orgBUser: string;
  let dm: string;
  let careTeam: string;
  let careTeamIds: string[] = [];
  let seq = 0;
  const granted: Array<{ orgId: string; userId: string }> = [];

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
  const grantSender = (orgId: string, userId: string) => {
    granted.push({ orgId, userId });
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore(
        granted.map((g) => ({
          orgId: g.orgId,
          userId: g.userId,
          grants: [
            {
              roleKey: "seed",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["messaging.read", "messaging.send"],
            },
          ],
        })),
      ).store,
    );
  };
  const seedUser = async (suffix: string, organizationId: string) => {
    seq += 1;
    const id = (
      await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$2) RETURNING id`, [
        `wp34-${suffix}-${seq}@x.test`,
        `WP34 ${suffix}`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, organizationId],
    );
    grantSender(organizationId, id);
    return id;
  };
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params)).rows as T[];
  const count = async (sql: string, params: unknown[] = []) =>
    (await one<{ n: number }>(sql, params))[0]?.n ?? 0;
  const addMember = (channelId: string, userId: string) =>
    admin.query(
      `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
       VALUES ($1,$2,$3,'member','manual')`,
      [ORG_A, channelId, userId],
    );
  const mkChannel = async (kind: string, subject: string | null, members: string[]) => {
    seq += 1;
    const id = (
      await admin.query(
        `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
         VALUES ($1,$2,$3,$4,'care_related') RETURNING id`,
        [ORG_A, kind, subject, `wp34-${kind}-${seq}`],
      )
    ).rows[0].id as string;
    for (const userId of members) await addMember(id, userId);
    return id;
  };

  function build(enabled: boolean): {
    server: FastifyInstance;
    tasks: ReturnType<typeof buildTaskDeps>;
  } {
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
    };
    const tasks = buildTaskDeps({
      db: handle.db,
      flags: { forOrg: async () => ({ [FLAG]: enabled }) },
      outbox: outbox as never,
      messaging: service,
      careTeamMembers: async () => careTeamIds,
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
    });
    return { server, tasks };
  }

  const as = (userId: string, org = ORG_A, key?: string) => ({
    "x-test-user": userId,
    "x-test-org": org,
    ...(key ? { "idempotency-key": key } : {}),
  });
  const post = async (channel: string, userId: string) => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/messaging/channels/${channel}/messages`,
      headers: as(userId, ORG_A, randomUUID()),
      payload: { bodyDoc: plainDoc("please follow up") } as object,
    });
    expect(res.statusCode).toBe(201);
    return res.json().messageId as string;
  };
  const convert = (
    userId: string,
    channel: string,
    message: string,
    to: string,
    extra: Record<string, unknown> = {},
    server = app,
  ) =>
    server.inject({
      method: "POST",
      url: `/api/v1/messaging/channels/${channel}/messages/${message}/tasks`,
      headers: as(userId),
      payload: { assignee_user_id: to, ...extra } as object,
    });
  const act = (userId: string, taskId: string, action: string, payload?: object, org = ORG_A) =>
    app.inject({
      method: "POST",
      url: `/api/v1/messaging/tasks/${taskId}/${action}`,
      headers: as(userId, org),
      ...(payload ? { payload } : {}),
    });
  const getTask = (userId: string, taskId: string, org = ORG_A, server = app) =>
    server.inject({
      method: "GET",
      url: `/api/v1/messaging/tasks/${taskId}`,
      headers: as(userId, org),
    });
  const newTask = async (channel: string, by: string, to: string, extra = {}) => {
    const message = await post(channel, by);
    const res = await convert(by, channel, message, to, extra);
    expect(res.statusCode).toBe(201);
    return { message, taskId: res.json().task.id as string };
  };
  const taskRow = async (id: string) =>
    (await one<Record<string, unknown>>("SELECT * FROM communication_task WHERE id=$1", [id]))[0];
  const eventTypes = async (id: string) =>
    (
      await one<{ event_type: string }>(
        "SELECT event_type FROM communication_task_event WHERE task_id=$1 ORDER BY created_at, id",
        [id],
      )
    ).map((e) => e.event_type);
  const outboxCount = (eventName: string, aggregateId: string) =>
    count("SELECT count(*)::int AS n FROM outbox_event WHERE event_type=$1 AND aggregate_id=$2", [
      eventName,
      aggregateId,
    ]);

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
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wp34-a','A','A'),($2,'wp34-b','B','B')`,
      [ORG_A, ORG_B],
    );
    creator = await seedUser("creator", ORG_A);
    assignee = await seedUser("assignee", ORG_A);
    third = await seedUser("third", ORG_A);
    outsider = await seedUser("outsider", ORG_A);
    orgBUser = await seedUser("b", ORG_B);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    appConn = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await appConn.connect();

    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
    service = createDbMessagingRouteService(handle.db, {
      kek: KEK,
      outbox: {
        publish: (tx: unknown, e: Record<string, unknown>) =>
          publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
      } as never,
      part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
    });
    dm = (await service.openDm(ORG_A, creator, assignee)).channelId;
    careTeam = await mkChannel("care_team", PATIENT, [creator, assignee]);

    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registerAbacRegistry(registry);
    const on = build(true);
    app = on.server;
    binding = on.tasks;
    offApp = build(false).server;
    await app.ready();
    await offApp.ready();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await offApp?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close();
    await appConn?.end();
    await admin?.end();
  });

  describe("create, idempotency and reopen", () => {
    it("creates a task, derives the patient from the channel and publishes one catalog-valid created event", async () => {
      const message = await post(careTeam, creator);
      const res = await convert(creator, careTeam, message, assignee, { clinical_concern: false });
      expect(res.statusCode).toBe(201);
      const taskId = res.json().task.id as string;
      expect(await taskRow(taskId)).toMatchObject({
        patient_id: PATIENT,
        clinical_concern: true,
        status: "open",
        assignee_id: assignee,
        created_by: creator,
      });
      expect(await eventTypes(taskId)).toEqual(["created"]);
      const [outboxRow] = await one<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM outbox_event WHERE event_type='m36.task.created' AND aggregate_id=$1",
        [taskId],
      );
      expect(Object.keys(outboxRow?.payload ?? {}).sort()).toEqual([
        "assigneeUserId",
        "at",
        "channelId",
        "createdByUserId",
        "messageId",
        "organizationId",
        "taskId",
      ]);
      expect(JSON.stringify(outboxRow)).not.toContain(PATIENT);
    });

    it("N concurrent creates for one (message, assignee) leave exactly one row, one event and one outbox row", async () => {
      const message = await post(dm, creator);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => convert(creator, dm, message, assignee)),
      );
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(7);
      const ids = new Set(results.map((r) => r.json().task.id as string));
      expect(ids.size).toBe(1);
      const taskId = [...ids][0] as string;
      expect(
        await count("SELECT count(*)::int AS n FROM communication_task WHERE message_id=$1", [
          message,
        ]),
      ).toBe(1);
      expect(await eventTypes(taskId)).toEqual(["created"]);
      expect(await outboxCount("m36.task.created", taskId)).toBe(1);
    });

    it("refuses an assignee who cannot read the channel with 422 and writes nothing", async () => {
      const message = await post(dm, creator);
      const res = await convert(creator, dm, message, outsider);
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe("TASK_ASSIGNEE_INVALID");
      expect(
        await count("SELECT count(*)::int AS n FROM communication_task WHERE message_id=$1", [
          message,
        ]),
      ).toBe(0);
    });

    it("lets a closed prior task be followed by a new one for the same message and assignee", async () => {
      const { message, taskId } = await newTask(dm, creator, assignee);
      expect((await act(assignee, taskId, "complete", { reason: "action_taken" })).statusCode).toBe(
        200,
      );
      const again = await convert(creator, dm, message, assignee);
      expect(again.statusCode).toBe(201);
      expect(again.json().task.id).not.toBe(taskId);
      expect(
        await count("SELECT count(*)::int AS n FROM communication_task WHERE message_id=$1", [
          message,
        ]),
      ).toBe(2);
    });
  });

  describe("lifecycle through the routes", () => {
    it("accepts, refuses a clinical close without a reason, and closes with one", async () => {
      const { taskId } = await newTask(careTeam, creator, assignee);
      expect((await act(assignee, taskId, "accept")).json().task.status).toBe("accepted");
      const missing = await act(assignee, taskId, "complete", {});
      expect(missing.statusCode).toBe(422);
      expect(errorCode(missing)).toBe("TASK_CLOSE_REASON_REQUIRED");
      const bad = await act(assignee, taskId, "complete", { reason: "because" });
      expect(errorCode(bad)).toBe("TASK_CLOSE_REASON_INVALID");
      const done = await act(assignee, taskId, "complete", { reason: "handled_elsewhere" });
      expect(done.json().task).toMatchObject({
        status: "done",
        closed_reason: "handled_elsewhere",
      });
      expect(await eventTypes(taskId)).toEqual(["created", "accepted", "done"]);
      expect((await act(assignee, taskId, "accept")).statusCode).toBe(409);
    });

    it("gives the creator 403 on accept and a stranger the same 404 as a random id", async () => {
      const { taskId } = await newTask(dm, creator, assignee);
      expect((await act(creator, taskId, "accept")).statusCode).toBe(403);
      const stranger = await act(outsider, taskId, "accept");
      const random = await act(outsider, randomUUID(), "accept");
      expect(stranger.statusCode).toBe(404);
      const strip = (b: string) => b.replace(/"[^"]*[Ii]d":"[^"]*"/g, "");
      expect(strip(stranger.body)).toBe(strip(random.body));
    });

    it("lists my tasks by scope and shows a stranger none", async () => {
      const { taskId } = await newTask(dm, creator, assignee);
      const list = (userId: string, query = "") =>
        app.inject({ method: "GET", url: `/api/v1/messaging/tasks${query}`, headers: as(userId) });
      const ids = (res: { json(): { tasks: Array<{ id: string }> } }) =>
        res.json().tasks.map((t) => t.id);
      const assigned = await list(assignee);
      expect(assigned.json().enabled).toBe(true);
      expect(ids(assigned)).toContain(taskId);
      expect(ids(await list(creator, "?scope=created"))).toContain(taskId);
      expect((await list(outsider)).json().tasks).toEqual([]);
    });

    it("reassigns to a reader of the channel, refuses an existing holder and a non-reader", async () => {
      const { message, taskId } = await newTask(careTeam, creator, assignee);
      await addMember(careTeam, third);
      const moved = await act(creator, taskId, "reassign", { assignee_user_id: third });
      expect(moved.json().task).toMatchObject({ assignee_id: third, status: "open" });
      const second = await convert(creator, careTeam, message, assignee);
      expect(second.statusCode).toBe(201);
      const clash = await act(creator, second.json().task.id, "reassign", {
        assignee_user_id: third,
      });
      expect(clash.statusCode).toBe(409);
      expect(errorCode(clash)).toBe("TASK_ASSIGNEE_ALREADY_HAS_ACTIVE");
      const hidden = await act(creator, second.json().task.id, "reassign", {
        assignee_user_id: outsider,
      });
      expect(errorCode(hidden)).toBe("TASK_ASSIGNEE_INVALID");
    });
  });

  describe("tenancy (as wardenx_app)", () => {
    it("lets org B read and mutate nothing of org A over HTTP", async () => {
      const { taskId } = await newTask(dm, creator, assignee);
      expect((await getTask(orgBUser, taskId, ORG_B)).statusCode).toBe(404);
      expect((await act(orgBUser, taskId, "accept", undefined, ORG_B)).statusCode).toBe(404);
      const list = await app.inject({
        method: "GET",
        url: "/api/v1/messaging/tasks?scope=created&state=all",
        headers: as(orgBUser, ORG_B),
      });
      expect(list.json().tasks).toEqual([]);
      expect((await taskRow(taskId))?.status).toBe("open");
    });

    it("sees none of org A under org B's GUC and rejects a cross-org insert", async () => {
      expect(
        await count("SELECT count(*)::int AS n FROM communication_task WHERE organization_id=$1", [
          ORG_A,
        ]),
      ).toBeGreaterThan(0);
      await appConn.query("BEGIN");
      try {
        await appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
        for (const table of ["communication_task", "communication_task_event"]) {
          expect((await appConn.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(
            0,
          );
        }
        const [m] = await one<{ id: string }>(
          "SELECT id::text FROM message WHERE organization_id=$1 LIMIT 1",
          [ORG_A],
        );
        await expect(
          appConn.query(
            `INSERT INTO communication_task (organization_id, message_id, channel_id, created_by, assignee_id)
             VALUES ($1,$2,$3,$4,$5)`,
            [ORG_A, (m as { id: string }).id, dm, creator, assignee],
          ),
        ).rejects.toThrow(/row-level security|violates/);
      } finally {
        await appConn.query("ROLLBACK");
      }
    });
  });

  describe("database backstops", () => {
    it("refuses, even via raw SQL, a clinical close without a reason and a non-clinical patient task", async () => {
      const { taskId } = await newTask(careTeam, creator, assignee);
      await expect(
        admin.query("UPDATE communication_task SET status='done', closed_at=now() WHERE id=$1", [
          taskId,
        ]),
      ).rejects.toThrow(/communication_task_clinical_close_needs_reason/);
      await expect(
        admin.query("UPDATE communication_task SET clinical_concern=false WHERE id=$1", [taskId]),
      ).rejects.toThrow(/communication_task_patient_is_clinical/);
      await expect(
        admin.query("UPDATE communication_task SET closed_reason='duplicate' WHERE id=$1", [
          taskId,
        ]),
      ).rejects.toThrow(/communication_task_reason_only_when_closed/);
    });

    it("gives wardenx_app no DELETE and no UPDATE of identity columns, and keeps events append-only", async () => {
      const { taskId } = await newTask(dm, creator, assignee);
      const denied = async (sql: string) => {
        await appConn.query("BEGIN");
        try {
          await appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
          await expect(appConn.query(sql, [taskId])).rejects.toThrow(/permission denied/);
        } finally {
          await appConn.query("ROLLBACK");
        }
      };
      await denied("DELETE FROM communication_task WHERE id=$1");
      await denied("DELETE FROM communication_task_event WHERE task_id=$1");
      await denied("UPDATE communication_task SET patient_id=NULL WHERE id=$1");
      await denied("UPDATE communication_task SET created_by=assignee_id WHERE id=$1");
      await denied("UPDATE communication_task SET message_id=gen_random_uuid() WHERE id=$1");
      await denied("UPDATE communication_task_event SET reason_code='x' WHERE task_id=$1");
    });
  });

  describe("audit", () => {
    it("writes trigger rows for the task and its events and never copies the patient id", async () => {
      const { taskId } = await newTask(careTeam, creator, assignee);
      await act(assignee, taskId, "accept");
      const rows = await one<{ event_type: string; resource_kind: string }>(
        "SELECT event_type, resource_kind FROM audit_event WHERE resource_id=$1",
        [taskId],
      );
      const kinds = new Set(rows.map((r) => r.event_type));
      expect(kinds.has("communication_task.insert")).toBe(true);
      expect(kinds.has("communication_task.update")).toBe(true);
      expect(
        await count(
          "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='communication_task_event'",
        ),
      ).toBeGreaterThan(0);
      const dump = JSON.stringify(
        await one(
          "SELECT before, after FROM audit_event WHERE resource_kind LIKE 'communication_task%'",
        ),
      );
      expect(dump).not.toContain(PATIENT);
    });

    it("lands a read event with a non-empty resource id when a task is opened", async () => {
      const { taskId } = await newTask(dm, creator, assignee);
      const reads = () =>
        count(
          `SELECT count(*)::int AS n FROM audit_event
            WHERE organization_id=$1 AND event_type='communication_task.viewed' AND resource_id=$2 AND actor_user_id=$3`,
          [ORG_A, taskId, assignee],
        );
      const before = await reads();
      expect((await getTask(assignee, taskId)).statusCode).toBe(200);
      expect(await reads()).toBe(before + 1);
    });
  });

  describe("offboarding reassignment", () => {
    const revokeEvent = (leaver: string, eventType: string, payload: Record<string, unknown>) =>
      ({
        id: randomUUID(),
        organizationId: ORG_A,
        eventType,
        aggregateKind: "membership",
        aggregateId: leaver,
        payload: { userId: leaver, ...payload },
        attemptCount: 0,
        createdAt: new Date(),
      }) satisfies DispatchableOutboxEvent;
    const consumer = () =>
      buildM36AccessRevocationConsumer({
        endChannelMemberships: (orgId, userId) =>
          endChannelMembershipsForUser(handle.db, orgId, userId),
        reassignOwnedItems: async (orgId, userId) => {
          await binding.reassignForLeaver(orgId, userId);
        },
      });
    const revoke = (leaver: string, eventType = "m2.membership.revoked") =>
      consumer().handle(revokeEvent(leaver, eventType, { to: "revoked", scope: "org" }));
    const reassignedOutbox = () =>
      count("SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m36.task.reassigned'");

    it("hands the task back to its creator and converges on redelivery", async () => {
      const leaver = await seedUser("leaver1", ORG_A);
      const ch = (await service.openDm(ORG_A, creator, leaver)).channelId;
      const { taskId } = await newTask(ch, creator, leaver);
      await revoke(leaver);
      expect(await taskRow(taskId)).toMatchObject({ assignee_id: creator, status: "open" });
      expect(await eventTypes(taskId)).toEqual(["created", "reassigned"]);
      const [ev] = await one<{ actor_kind: string; reason_code: string }>(
        "SELECT actor_kind, reason_code FROM communication_task_event WHERE task_id=$1 AND event_type='reassigned'",
        [taskId],
      );
      expect(ev).toEqual({ actor_kind: "system", reason_code: "offboarding" });
      const outboxBefore = await reassignedOutbox();
      await revoke(leaver, "m2.user.deactivated");
      expect(await eventTypes(taskId)).toEqual(["created", "reassigned"]);
      expect(await reassignedOutbox()).toBe(outboxBefore);
    });

    it("falls back to the first eligible care-team member when the leaver also created the task", async () => {
      const leaver = await seedUser("leaver2", ORG_A);
      const nonMember = await seedUser("cteam-out", ORG_A);
      const member = await seedUser("cteam-in", ORG_A);
      const patient = randomUUID();
      const ch = await mkChannel("care_team", patient, [leaver, member]);
      const { taskId } = await newTask(ch, leaver, leaver);
      careTeamIds = [nonMember, leaver, member];
      try {
        await revoke(leaver);
      } finally {
        careTeamIds = [];
      }
      expect(await taskRow(taskId)).toMatchObject({ assignee_id: member, needs_owner: false });
    });

    it("flags needs_owner when nobody is eligible, keeps the leaver, and does it once", async () => {
      const leaver = await seedUser("leaver3", ORG_A);
      const peer = await seedUser("leaver3-peer", ORG_A);
      const ch = (await service.openDm(ORG_A, leaver, peer)).channelId;
      const { taskId } = await newTask(ch, leaver, leaver);
      await revoke(leaver);
      expect(await taskRow(taskId)).toMatchObject({ assignee_id: leaver, needs_owner: true });
      expect(await eventTypes(taskId)).toEqual(["created", "needs_owner"]);
      expect(await outboxCount("m36.task.needs_owner", taskId)).toBe(1);
      await revoke(leaver);
      expect(await eventTypes(taskId)).toEqual(["created", "needs_owner"]);
    });

    it("does nothing on suspend (reinstatable)", async () => {
      const leaver = await seedUser("leaver4", ORG_A);
      const ch = (await service.openDm(ORG_A, creator, leaver)).channelId;
      const { taskId } = await newTask(ch, creator, leaver);
      await consumer().handle(revokeEvent(leaver, "m2.membership.suspended", { to: "suspended" }));
      expect(await taskRow(taskId)).toMatchObject({ assignee_id: leaver, needs_owner: false });
    });
  });

  describe("cascade and the open-tasks tile", () => {
    it("removes a hard-deleted message's tasks and events", async () => {
      const { message, taskId } = await newTask(dm, creator, assignee);
      await admin.query("DELETE FROM message WHERE id=$1", [message]);
      expect(await taskRow(taskId)).toBeUndefined();
      expect(
        await count("SELECT count(*)::int AS n FROM communication_task_event WHERE task_id=$1", [
          taskId,
        ]),
      ).toBe(0);
    });

    it("counts only the caller's own active tasks on the patient, on channels the caller can still view", async () => {
      const a = await seedUser("tile-a", ORG_A);
      const b = await seedUser("tile-b", ORG_A);
      const tilePatient = randomUUID();
      const ch = await mkChannel("care_team", tilePatient, [a, b]);
      await newTask(ch, a, b);
      const { taskId } = await newTask(ch, a, b);
      expect((await act(a, taskId, "cancel", { reason: "duplicate" })).statusCode).toBe(200);
      expect(await binding.service.openTaskCount(ORG_A, tilePatient, a)).toBe(1);
      expect(await binding.service.openTaskCount(ORG_A, tilePatient, b)).toBe(1);
      expect(await binding.service.openTaskCount(ORG_A, tilePatient, outsider)).toBe(0);
      await endChannelMembershipsForUser(handle.db, ORG_A, b);
      expect(await binding.service.openTaskCount(ORG_A, tilePatient, b)).toBe(0);
    });
  });

  describe("flag and wiring", () => {
    it("is 404 on the write and single routes and an empty disabled list while the flag is off", async () => {
      const message = await post(dm, creator);
      expect((await convert(creator, dm, message, assignee, {}, offApp)).statusCode).toBe(404);
      const { taskId } = await newTask(dm, creator, assignee);
      expect((await getTask(creator, taskId, ORG_A, offApp)).statusCode).toBe(404);
      const list = await offApp.inject({
        method: "GET",
        url: "/api/v1/messaging/tasks",
        headers: as(creator),
      });
      expect(list.json()).toEqual({ enabled: false, tasks: [] });
    });

    it("has the composition root build, mount, consume and reassign (bound is computing)", () => {
      const root = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
      expect(root).toContain("buildTaskDeps({");
      expect(root).toContain("tasks: m36Tasks");
      expect(root).toContain("buildM36TaskNotificationsConsumer({");
      expect(root).toContain("m36Tasks?.reassignForLeaver(orgId, userId)");
      expect(root).not.toContain("reassignOwnedItems: reassignOwnedItemsNoop");
      const mount = readFileSync(join(__dirname, "../src/modules/36-messaging/index.ts"), "utf8");
      expect(mount).toContain("tasks: opts.tasks");
    });
  });
});
