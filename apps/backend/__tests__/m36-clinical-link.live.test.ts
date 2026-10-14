/**
 * M36 WP 3.2 - clinical links, LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * The real route stack (Authorization Contract, `channel_visibility`, the DB route service, the audit and read-audit
 * plumbing). Only the OWNING-MODULE seams are in-memory fakes (their `linkSummary` lands on other branches).
 *
 *   1. MIGRATION     the table, FORCE RLS, grants (no UPDATE), unique + FK, and NO column that could hold clinical text.
 *   2. WRITE         a link persists exactly (kind, source_id, patient_id, created_by); the message and its links are one
 *                    transaction; a refused link leaves no message; a resend/replay writes the links once.
 *   3. EDIT          reconciles: dropped links deleted, new ones inserted, a plain edit clears them.
 *   4. READ          the message DTO carries {link_id, kind, entity_id} only.
 *   5. OPEN          resolve: ok for a member who holds the permission + scope, the identical `unavailable` for a
 *                    non-member, org B, a random id, forbidden/erased/failing sources; the read-audit row lands.
 *   6. TENANCY       as org B the rows are invisible; an org A insert and any UPDATE are rejected; delete cascades.
 *   7. AUDIT         the PHI write-audit trigger fires and never copies source_id or patient_id.
 *   8. FLAG          off => a link is refused (422) and resolve is 404.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m36:clinical-link:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
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
import type { ClinicalLinkKind, ClinicalLinkSummary } from "@wardenx/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { createDbClinicalLinkStore } from "../src/modules/36-messaging/clinical-link/clinical-link-store-db";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const KEK = randomBytes(32);
const ORG_A = "11111111-1111-4111-8111-1111000c0001";
const ORG_B = "22222222-2222-4222-8222-2222000c0002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-00000000c1c1";
const ORDER = "11111111-1111-4111-8111-00000000c001";
const VISIT = "11111111-1111-4111-8111-00000000c002";
const MED = "11111111-1111-4111-8111-00000000c003";
const MEETING = "11111111-1111-4111-8111-00000000c004";
const ERASED = "11111111-1111-4111-8111-00000000c005";
const BOOM = "11111111-1111-4111-8111-00000000c006";
const FOREIGN = "11111111-1111-4111-8111-00000000c007";
const OTHER_PATIENT = "cccccccc-cccc-4ccc-8ccc-00000000c1c1";
const RANDOM = "99999999-9999-4999-8999-99999999c999";

const SUMMARIES = new Map<string, ClinicalLinkSummary>([
  [
    ORDER,
    { id: ORDER, patientId: PATIENT, status: "active", occurredAt: "2026-10-01T00:00:00.000Z" },
  ],
  [
    VISIT,
    { id: VISIT, patientId: PATIENT, status: "scheduled", occurredAt: "2026-10-20T09:00:00.000Z" },
  ],
  [MED, { id: MED, patientId: PATIENT, status: "active", occurredAt: null }],
  [MEETING, { id: MEETING, patientId: null, status: "scheduled", occurredAt: null }],
  [FOREIGN, { id: FOREIGN, patientId: OTHER_PATIENT, status: "active", occurredAt: null }],
] as never);

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["clinical_rn"];
  request.context.locationIds = [];
}

const para = (...content: unknown[]) => ({ type: "paragraph", content });
const link = (kind: ClinicalLinkKind, entityId: string) => ({
  type: "clinicalLink",
  kind,
  entityId,
});
const text = (value: string) => ({ type: "text", text: value });
const doc = (...content: unknown[]) => ({ schemaVersion: 1, doc: { type: "doc", content } });

describe.skipIf(!DB_URL)("M36 WP 3.2 clinical links - LIVE Postgres", () => {
  let admin: Client;
  let appConn: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let service: ReturnType<typeof createDbMessagingRouteService>;
  let app: FastifyInstance;
  let offApp: FastifyInstance;
  let u1: string;
  let u2: string;
  let outsider: string;
  let orgBUser: string;
  let dm: string;
  let sourceCalls = 0;

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
  const seedUser = async (suffix: string, organizationId: string) => {
    const id = (
      await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$2) RETURNING id`, [
        `wp32-${suffix}@x.test`,
        `WP32 ${suffix}`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, organizationId],
    );
    return id;
  };
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params)).rows as T[];
  const count = async (sql: string, params: unknown[] = []) =>
    (await one<{ n: number }>(sql, params))[0]?.n ?? 0;

  function build(enabled: boolean): FastifyInstance {
    const server = buildServer({
      db: handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(handle.db),
    });
    registerMessagingRoutes(server, {
      service,
      announcements: createDbAnnouncementService(handle.db),
      clinicalLinks: {
        isEnabled: async () => enabled,
        sources: {
          summary: async (_kind, _org, id) => {
            sourceCalls += 1;
            if (id === BOOM) throw new Error("Jane Doe morphine");
            return SUMMARIES.get(id) ?? null;
          },
        },
        store: createDbClinicalLinkStore(handle.db),
      },
    });
    return server;
  }

  const as = (userId: string, org = ORG_A, key?: string) => ({
    "x-test-user": userId,
    "x-test-org": org,
    ...(key ? { "idempotency-key": key } : {}),
  });
  const send = (
    server: FastifyInstance,
    userId: string,
    payload: Record<string, unknown>,
    key = randomUUID(),
  ) =>
    server.inject({
      method: "POST",
      url: `/api/v1/messaging/channels/${dm}/messages`,
      headers: as(userId, ORG_A, key),
      payload,
    });
  const edit = (userId: string, messageId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/messaging/messages/${messageId}`,
      headers: as(userId),
      payload,
    });
  const resolve = (userId: string, linkId: string, org = ORG_A, server = app) =>
    server.inject({
      method: "GET",
      url: `/api/v1/messaging/clinical-links/${linkId}/resolve`,
      headers: as(userId, org),
    });
  const linksOf = (messageId: string) =>
    one<{ link_kind: string; source_id: string; patient_id: string | null; created_by: string }>(
      `SELECT link_kind, source_id::text, patient_id::text, created_by::text
         FROM clinical_link WHERE message_id=$1 ORDER BY link_kind`,
      [messageId],
    );
  const messageRows = () =>
    count(`SELECT count(*)::int AS n FROM message WHERE channel_id=$1`, [dm]);

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
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wp32-a','A','A'),($2,'wp32-b','B','B')`,
      [ORG_A, ORG_B],
    );
    u1 = await seedUser("u1", ORG_A);
    u2 = await seedUser("u2", ORG_A);
    outsider = await seedUser("out", ORG_A);
    orgBUser = await seedUser("b", ORG_B);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    appConn = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await appConn.connect();

    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
    };
    service = createDbMessagingRouteService(handle.db, { kek: KEK, outbox: outbox as never });
    dm = (await service.openDm(ORG_A, u1, u2)).channelId;

    const keys = [
      "messaging.read",
      "messaging.send",
      "orders.read",
      "visit.read",
      "prescribing.read",
      "idg.read",
    ];
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        ...[u1, u2, outsider].map((userId) => ({
          orgId: ORG_A,
          userId,
          grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: keys }],
        })),
        {
          orgId: ORG_B,
          userId: orgBUser,
          grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: keys }],
        },
      ]).store,
    );
    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registry.register("caseload_or_scope", async (_ctx, target) => target.patientId === PATIENT);
    registry.register("idg_meeting_scope", async (_ctx, target) => target.id === MEETING);
    registerAbacRegistry(registry);
    app = build(true);
    offApp = build(false);
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

  describe("migration", () => {
    it("creates the table with FORCE RLS, no UPDATE grant, the unique target and a cascading composite FK", async () => {
      const [rls] = await one<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='clinical_link'`,
      );
      expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const grants = (
        await one<{ privilege_type: string }>(
          `SELECT privilege_type FROM information_schema.role_table_grants
            WHERE table_name='clinical_link' AND grantee='wardenx_app' ORDER BY 1`,
        )
      ).map((g) => g.privilege_type);
      expect(grants).toEqual(["DELETE", "INSERT", "SELECT"]);
      const cons = await one<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='clinical_link'::regclass`,
      );
      expect(cons.find((c) => c.conname === "clinical_link_unique_target")?.def).toContain(
        "UNIQUE (organization_id, message_id, link_kind, source_id)",
      );
      expect(cons.find((c) => c.conname === "clinical_link_message_org_fk")?.def).toMatch(
        /FOREIGN KEY \(organization_id, message_id\) REFERENCES message\(organization_id, id\) ON DELETE CASCADE/,
      );
      expect(cons.find((c) => c.conname === "clinical_link_kind_shape")?.def).toContain(
        "idg_meeting",
      );
    });

    it("has NO free-text column: only ids, the kind, the creator and a timestamp", async () => {
      const cols = await one<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='clinical_link' ORDER BY 1`,
      );
      expect(cols.map((c) => c.column_name)).toEqual([
        "created_at",
        "created_by",
        "id",
        "link_kind",
        "message_id",
        "organization_id",
        "patient_id",
        "source_id",
      ]);
      expect(cols.filter((c) => c.data_type === "text").map((c) => c.column_name)).toEqual([
        "link_kind",
      ]);
    });
  });

  describe("write", () => {
    it("persists exactly (kind, source_id, patient_id, created_by) in the message transaction, an IDG meeting with a null patient", async () => {
      const res = await send(app, u1, {
        bodyDoc: doc(para(text("see "), link("order", ORDER), link("idg_meeting", MEETING))),
      });
      expect(res.statusCode).toBe(201);
      const messageId = res.json().messageId as string;
      expect(await linksOf(messageId)).toEqual([
        { link_kind: "idg_meeting", source_id: MEETING, patient_id: null, created_by: u1 },
        { link_kind: "order", source_id: ORDER, patient_id: PATIENT, created_by: u1 },
      ]);
      const [m] = await one<{ body_kind: string }>(`SELECT body_kind FROM message WHERE id=$1`, [
        messageId,
      ]);
      expect(m?.body_kind).toBe("rich");
    });

    it("refuses an invalid link with the generic 422 and leaves NO message row (nothing half-written)", async () => {
      const before = await messageRows();
      const cases: Array<[string, Record<string, unknown>]> = [
        ["erased", link("order", ERASED)],
        ["foreign patient", link("order", FOREIGN)],
        ["seam failure", link("order", BOOM)],
        ["random", link("order", RANDOM)],
        ["null-patient on a patient kind", link("order", MEETING)],
        ["kind not permitted (documents.read absent)", link("document", ORDER)],
      ];
      const messages = new Set<string>();
      for (const [name, node] of cases) {
        const res = await send(app, u1, { bodyDoc: doc(para(node, link("visit", VISIT))) });
        expect(res.statusCode, name).toBe(422);
        expect(res.json().error.code, name).toBe("CLINICAL_LINK_NOT_AVAILABLE");
        messages.add(res.json().error.message);
      }
      expect([...messages]).toEqual(["link not available"]);
      expect(await messageRows()).toBe(before);
    });

    it("a failure while persisting the links rolls the message back (one transaction)", async () => {
      const before = await messageRows();
      const richBody = { schemaVersion: 1 as const, doc: doc(para(link("order", ORDER))).doc };
      await expect(
        service.sendMessage(ORG_A, {
          channelId: dm,
          authorUserId: u1,
          body: "[linked record]",
          bodyKind: "rich",
          richBody: richBody as never,
          // a patient id that is not a uuid fails the INSERT after the message row was written
          clinicalLinks: [{ kind: "order", sourceId: ORDER, patientId: "not-a-uuid" }],
        }),
      ).rejects.toThrow();
      expect(await messageRows()).toBe(before);
    });

    it("the write core refuses link nodes that were not validated (a path that skips the route)", async () => {
      const before = await messageRows();
      const richBody = { schemaVersion: 1 as const, doc: doc(para(link("order", ORDER))).doc };
      await expect(
        service.sendMessage(ORG_A, {
          channelId: dm,
          authorUserId: u1,
          body: "[linked record]",
          bodyKind: "rich",
          richBody: richBody as never,
        }),
      ).rejects.toMatchObject({ code: "CLINICAL_LINK_NOT_AVAILABLE" });
      expect(await messageRows()).toBe(before);
    });

    it("a resend under the same Idempotency-Key, and under a fresh key with the same clientMessageId, writes the links once", async () => {
      const clientMessageId = randomUUID();
      const payload = { bodyDoc: doc(para(link("visit", VISIT))), clientMessageId };
      const key = randomUUID();
      const first = await send(app, u1, payload, key);
      const replay = await send(app, u1, payload, key);
      const fresh = await send(app, u1, payload, randomUUID());
      expect([first.statusCode, replay.statusCode, fresh.statusCode]).toEqual([201, 201, 201]);
      const id = first.json().messageId as string;
      expect(replay.json().messageId).toBe(id);
      expect(fresh.json().messageId).toBe(id);
      expect(await linksOf(id)).toHaveLength(1);
    });

    it("the unique constraint refuses a duplicate (message, kind, source) at the database", async () => {
      const id = (await send(app, u1, { bodyDoc: doc(para(link("medication", MED))) })).json()
        .messageId as string;
      await expect(
        admin.query(
          `INSERT INTO clinical_link (organization_id, message_id, link_kind, source_id, patient_id, created_by)
           VALUES ($1,$2,'medication',$3,$4,$5)`,
          [ORG_A, id, MED, PATIENT, u1],
        ),
      ).rejects.toThrow(/clinical_link_unique_target/);
    });
  });

  describe("edit", () => {
    it("reconciles: dropped links deleted, new ones inserted, unchanged ones keep their row, a plain edit clears all", async () => {
      const id = (
        await send(app, u1, { bodyDoc: doc(para(link("order", ORDER), link("visit", VISIT))) })
      ).json().messageId as string;
      const before = await one<{ id: string; link_kind: string }>(
        `SELECT id::text, link_kind FROM clinical_link WHERE message_id=$1`,
        [id],
      );
      const keptId = before.find((r) => r.link_kind === "order")?.id;

      const res = await edit(u1, id, {
        bodyDoc: doc(para(link("order", ORDER), link("medication", MED))),
      });
      expect(res.statusCode).toBe(200);
      expect((await linksOf(id)).map((l) => l.link_kind)).toEqual(["medication", "order"]);
      const after = await one<{ id: string; link_kind: string }>(
        `SELECT id::text, link_kind FROM clinical_link WHERE message_id=$1`,
        [id],
      );
      expect(after.find((r) => r.link_kind === "order")?.id).toBe(keptId);

      const bad = await edit(u1, id, { bodyDoc: doc(para(link("order", FOREIGN))) });
      expect(bad.statusCode).toBe(422);
      expect((await linksOf(id)).map((l) => l.link_kind)).toEqual(["medication", "order"]);

      const plain = await edit(u1, id, { body: "never mind" });
      expect(plain.statusCode).toBe(200);
      expect(await linksOf(id)).toEqual([]);
    });
  });

  describe("read DTO", () => {
    it("returns {link_id, kind, entity_id} only: no status, label, patient or source text", async () => {
      const id = (await send(app, u1, { bodyDoc: doc(para(link("order", ORDER))) })).json()
        .messageId as string;
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${dm}/messages`,
        headers: as(u2),
      });
      const message = (res.json().messages as Array<Record<string, any>>).find(
        (m) => m.messageId === id,
      );
      const [row] = await linksOf(id);
      expect(message?.clinicalLinks).toHaveLength(1);
      expect(Object.keys(message?.clinicalLinks[0]).sort()).toEqual([
        "entity_id",
        "kind",
        "link_id",
      ]);
      expect(message?.clinicalLinks[0]).toMatchObject({ kind: "order", entity_id: row?.source_id });
      expect(JSON.stringify(message?.clinicalLinks)).not.toMatch(/active|status|scheduled/);
      expect(message?.body).toBe("[linked record]");
    });
  });

  describe("resolve", () => {
    let linkId: string;
    let meetingLinkId: string;
    beforeAll(async () => {
      const id = (
        await send(app, u1, {
          bodyDoc: doc(para(link("order", ORDER), link("idg_meeting", MEETING))),
        })
      ).json().messageId as string;
      const rows = await one<{ id: string; link_kind: string }>(
        `SELECT id::text, link_kind FROM clinical_link WHERE message_id=$1`,
        [id],
      );
      linkId = rows.find((r) => r.link_kind === "order")?.id as string;
      meetingLinkId = rows.find((r) => r.link_kind === "idg_meeting")?.id as string;
    });

    it("opens for a channel member with the permission + scope: live status, deep link, as_of, and lands the read-audit row", async () => {
      const readRows = () =>
        count(
          `SELECT count(*)::int AS n FROM audit_event
            WHERE organization_id=$1 AND event_type='clinical_link.viewed' AND resource_id=$2 AND actor_user_id=$3`,
          [ORG_A, linkId, u2],
        );
      const before = await readRows();
      const res = await resolve(u2, linkId);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        state: "ok",
        kind: "order",
        status: "active",
        occurred_at: "2026-10-01T00:00:00.000Z",
        link: `/orders/${ORDER}`,
        patient_id: PATIENT,
      });
      expect(Number.isNaN(Date.parse(res.json().as_of))).toBe(false);
      expect(await readRows()).toBe(before + 1);
      expect((await resolve(u2, meetingLinkId)).json()).toMatchObject({
        state: "ok",
        patient_id: null,
      });
    });

    it("reads through: the answer follows the source's CURRENT state", async () => {
      const original = SUMMARIES.get(ORDER) as ClinicalLinkSummary;
      SUMMARIES.set(ORDER, { ...original, status: "discontinued" });
      expect((await resolve(u2, linkId)).json()).toMatchObject({ status: "discontinued" });
      SUMMARIES.set(ORDER, original);
    });

    it("is the identical unavailable for a non-member, org B, a random id and a source that is gone or failing", async () => {
      const want = { state: "unavailable" };
      const random = await resolve(u1, randomUUID());
      expect([random.statusCode, random.json()]).toEqual([200, want]);
      for (const res of [await resolve(outsider, linkId), await resolve(orgBUser, linkId, ORG_B)]) {
        expect([res.statusCode, res.json()]).toEqual([200, want]);
      }
      const before = sourceCalls;
      await resolve(outsider, linkId);
      await resolve(orgBUser, linkId, ORG_B);
      expect(sourceCalls).toBe(before); // the source seam is never consulted for a viewer who cannot see the message

      for (const source of [ERASED, BOOM, FOREIGN]) {
        const m = (await send(app, u1, { bodyDoc: doc(para(text("x"))) })).json()
          .messageId as string;
        const [row] = await one<{ id: string }>(
          `INSERT INTO clinical_link (organization_id, message_id, link_kind, source_id, patient_id, created_by)
           VALUES ($1,$2,'order',$3,$4,$5) RETURNING id::text`,
          [ORG_A, m, source, PATIENT, u1],
        );
        const res = await resolve(u2, (row as { id: string }).id);
        expect([source, res.statusCode, res.json()]).toEqual([source, 200, want]);
      }
    });

    it("a deleted message's links no longer open", async () => {
      const m = (await send(app, u1, { bodyDoc: doc(para(link("order", ORDER))) })).json()
        .messageId as string;
      const [row] = await one<{ id: string }>(
        `SELECT id::text FROM clinical_link WHERE message_id=$1`,
        [m],
      );
      const id = (row as { id: string }).id;
      expect((await resolve(u2, id)).json().state).toBe("ok");
      await app.inject({
        method: "DELETE",
        url: `/api/v1/messaging/messages/${m}`,
        headers: as(u1),
      });
      expect((await resolve(u2, id)).json()).toEqual({ state: "unavailable" });
    });
  });

  describe("flag", () => {
    it("off: a link is refused (422), nothing is written, and resolve is 404", async () => {
      const before = await messageRows();
      const res = await send(offApp, u1, { bodyDoc: doc(para(link("order", ORDER))) });
      expect(res.statusCode).toBe(422);
      expect(await messageRows()).toBe(before);
      const [row] = await one<{ id: string }>(`SELECT id::text FROM clinical_link LIMIT 1`);
      expect((await resolve(u2, (row as { id: string }).id, ORG_A, offApp)).statusCode).toBe(404);
      const plain = await send(offApp, u1, { bodyDoc: doc(para(text("no links"))) });
      expect(plain.statusCode).toBe(201);
    });
  });

  describe("tenancy and audit (as wardenx_app)", () => {
    it("org B sees none of org A's rows; an org A insert and any UPDATE are rejected", async () => {
      const total = await count(
        `SELECT count(*)::int AS n FROM clinical_link WHERE organization_id=$1`,
        [ORG_A],
      );
      expect(total).toBeGreaterThan(0);
      await appConn.query("BEGIN");
      await appConn.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_B]);
      expect((await appConn.query("SELECT count(*)::int AS n FROM clinical_link")).rows[0].n).toBe(
        0,
      );
      const [m] = await one<{ id: string }>(
        `SELECT id::text FROM message WHERE organization_id=$1 LIMIT 1`,
        [ORG_A],
      );
      await appConn.query("SAVEPOINT s1");
      await expect(
        appConn.query(
          `INSERT INTO clinical_link (organization_id, message_id, link_kind, source_id, created_by)
           VALUES ($1,$2,'order',$3,$4)`,
          [ORG_A, (m as { id: string }).id, randomUUID(), u1],
        ),
      ).rejects.toThrow(/row-level security|violates/);
      await appConn.query("ROLLBACK TO SAVEPOINT s1");
      await appConn.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      await expect(appConn.query("UPDATE clinical_link SET patient_id = NULL")).rejects.toThrow(
        /permission denied/,
      );
      await appConn.query("ROLLBACK");
    });

    it("the write-audit trigger records insert and delete and never copies source_id or patient_id", async () => {
      const m = (await send(app, u1, { bodyDoc: doc(para(link("medication", MED))) })).json()
        .messageId as string;
      const [row] = await one<{ id: string }>(
        `SELECT id::text FROM clinical_link WHERE message_id=$1`,
        [m],
      );
      const id = (row as { id: string }).id;
      await edit(u1, m, { body: "plain now" });
      const events = await one<{ event_type: string; before: unknown; after: unknown }>(
        `SELECT event_type, before, after FROM audit_event
          WHERE resource_kind='clinical_link' AND resource_id=$1 ORDER BY created_at`,
        [id],
      );
      expect(events.map((e) => e.event_type)).toEqual([
        "clinical_link.insert",
        "clinical_link.delete",
      ]);
      const dump = JSON.stringify(events);
      expect(dump).not.toContain(MED);
      expect(dump).not.toContain(PATIENT);
    });

    it("deleting a message cascades to its links", async () => {
      const m = (await send(app, u1, { bodyDoc: doc(para(link("visit", VISIT))) })).json()
        .messageId as string;
      expect(
        await count(`SELECT count(*)::int AS n FROM clinical_link WHERE message_id=$1`, [m]),
      ).toBe(1);
      await admin.query(`DELETE FROM message WHERE id=$1`, [m]);
      expect(
        await count(`SELECT count(*)::int AS n FROM clinical_link WHERE message_id=$1`, [m]),
      ).toBe(0);
    });
  });

  describe("wiring (bound is not computing)", () => {
    it("the composition root builds the clinical-link deps from the feature-flag reader and passes them to the M36 mount", () => {
      const root = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
      expect(root).toContain(
        "clinicalLinks: buildClinicalLinkDeps({ db: dbHandle.db, flags: featureFlagReader })",
      );
      const mount = readFileSync(join(__dirname, "../src/modules/36-messaging/index.ts"), "utf8");
      expect(mount).toContain("clinicalLinks: opts.clinicalLinks");
    });
  });
});
