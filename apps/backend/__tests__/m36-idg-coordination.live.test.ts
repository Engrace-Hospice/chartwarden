/**
 * M36 WP 3.6 - IDG coordination, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Workflow C, end to end on the real route stack (Authorization Contract, `channel_visibility`, the DB route service,
 * the real catalog-validating outbox publisher, the read-audit plugin). Only the M14 meeting SUMMARY seam is an
 * in-memory fake (M36 reaches M14 through a seam, never its code); the M14 / M7 TABLES are real and fingerprinted.
 *
 *   1. ACCEPTANCE   an IDG member posts a root linked to a live meeting, a colleague replies, the reply becomes a task which
 *                   is accepted and completed: the idg_* and care_plan* tables are byte-identical, the meeting row is
 *                   untouched, and not one m14.* / idg.* / m7.* outbox event was written.
 *   2. LIST         roots only (no replies, deleted roots, roots without an idg link, other channels), newest first,
 *                   hydrated like the pin list; a non-care-team channel answers an empty list.
 *   3. AUDIT        the list read lands one audit row attributed to the reader and carrying the channel's patient.
 *   4. REFUSALS     a non-member, org B and a Part 2 denial get the answer a random channel gets; anonymous is 401.
 *   5. FLAGS        messaging.idg off, or messaging.clinical_links off => 200 enabled:false with nothing listed.
 *
 *   The promotion case (WP 3.7) is out of scope here: nothing in 3.6 writes a promotion.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:idg:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  createPredicateRegistry,
  registerAbacRegistry,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { createDbClinicalLinkStore } from "../src/modules/36-messaging/clinical-link/clinical-link-store-db";
import { buildIdgDiscussionDeps } from "../src/modules/36-messaging/idg/deps";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { buildTaskDeps } from "../src/modules/36-messaging/tasks/deps";
import {
  type LiveKit,
  STAFF_KEYS,
  as,
  bootLiveKit,
  catalogOutbox,
  errorCode,
  headerAuth,
  mkChannel,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-1111000d0001";
const ORG_B = "22222222-2222-4222-8222-2222000d0002";
const KEK = randomBytes(32);
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-00000000d6d6";
const OTHER_PATIENT = "cccccccc-cccc-4ccc-8ccc-00000000d6d6";
const MEETING = "11111111-1111-4111-8111-00000000d601";
const MEETING_2 = "11111111-1111-4111-8111-00000000d602";
const ORDER = "11111111-1111-4111-8111-00000000d603";
const RANDOM = "99999999-9999-4999-8999-99999999d699";
const IDG_KEYS = [...STAFF_KEYS, "idg.read", "orders.read"];
const FOREIGN_EVENT_PREFIX = /^(m14|m7|idg)\./;

const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string) => ({ type: "text", text: value });
const link = (kind: string, entityId: string) => ({ type: "clinicalLink", kind, entityId });
const doc = (...content: unknown[]) => ({ schemaVersion: 1, doc: { type: "doc", content } });

describe.skipIf(!DB_URL)("M36 WP 3.6 IDG coordination - LIVE Postgres", () => {
  let kit: LiveKit;
  let service: ReturnType<typeof createDbMessagingRouteService>;
  let app: FastifyInstance;
  let flagsOffApp: FastifyInstance;
  let linksOffApp: FastifyInstance;
  let author: string;
  let replier: string;
  let outsider: string;
  let orgBUser: string;
  let careTeam: string;
  let otherCareTeam: string;
  let location: string;
  const part2Denied = new Set<string>();

  const summaries = new Map([
    [MEETING, { id: MEETING, patientId: null, status: "live", occurredAt: null }],
    [MEETING_2, { id: MEETING_2, patientId: null, status: "scheduled", occurredAt: null }],
    [ORDER, { id: ORDER, patientId: PATIENT, status: "active", occurredAt: null }],
  ]);

  function build(flags: Record<string, boolean>): FastifyInstance {
    const server = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(kit.handle.db),
    });
    registerMessagingRoutes(server, {
      service,
      announcements: createDbAnnouncementService(kit.handle.db),
      clinicalLinks: {
        isEnabled: async () => true,
        sources: { summary: async (_k, _o, id) => (summaries.get(id) as never) ?? null },
        store: createDbClinicalLinkStore(kit.handle.db),
      },
      tasks: buildTaskDeps({
        db: kit.handle.db,
        flags: { forOrg: async () => ({ "messaging.tasks": true }) },
        outbox: catalogOutbox() as never,
        messaging: service,
        careTeamMembers: async () => [],
      }),
      idgDiscussions: buildIdgDiscussionDeps({
        db: kit.handle.db,
        cipher: createMessageBodyCipher({ kek: KEK }),
        flags: { forOrg: async () => flags },
      }),
    });
    return server;
  }

  const listUrl = (channel: string, query = "") =>
    `/api/v1/messaging/channels/${channel}/idg-discussions${query}`;
  const list = (user: string, channel: string, org = ORG_A, server = app, query = "") =>
    server.inject({ method: "GET", url: listUrl(channel, query), headers: as(user, org) });
  const post = async (user: string, channel: string, payload: Record<string, unknown>) => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/messaging/channels/${channel}/messages`,
      headers: as(user, ORG_A, randomUUID()),
      payload,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().messageId as string;
  };
  const root = (user: string, channel: string, ...linkNodes: unknown[]) =>
    post(user, channel, { bodyDoc: doc(para(text("IDG discussion "), ...linkNodes)) });
  const reply = (user: string, channel: string, parentMessageId: string, body = "reply") =>
    post(user, channel, { body, parentMessageId });

  /** A fingerprint per M14 / M7 table: a change to any row, in any column, changes it. */
  async function fingerprint(): Promise<Record<string, string>> {
    const tables = await kit.one<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND (table_name LIKE 'idg\\_%' OR table_name LIKE 'care\\_plan%') ORDER BY 1`,
    );
    const out: Record<string, string> = {};
    for (const { table_name } of tables) {
      const [row] = await kit.one<{ fp: string }>(
        `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS fp FROM "${table_name}" t`,
      );
      out[table_name] = row?.fp ?? "";
    }
    return out;
  }
  const foreignOutboxCount = () =>
    kit.count(
      `SELECT count(*)::int AS n FROM outbox_event
        WHERE event_type ~ '^(m14|m7|idg)\\.'`,
    );

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp36");
    service = createDbMessagingRouteService(kit.handle.db, {
      kek: KEK,
      outbox: catalogOutbox() as never,
      part2Gate: {
        allowedUserIds: async ({ patientId, userIds }) =>
          new Set(userIds.filter((u) => !part2Denied.has(`${u}:${patientId}`))),
      },
    });
    author = await kit.seedUser("author", ORG_A, IDG_KEYS);
    replier = await kit.seedUser("replier", ORG_A, IDG_KEYS);
    outsider = await kit.seedUser("outsider", ORG_A, IDG_KEYS);
    orgBUser = await kit.seedUser("orgb", ORG_B, IDG_KEYS);
    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registry.register("caseload_or_scope", async (_ctx, target) => target.patientId === PATIENT);
    registry.register("idg_meeting_scope", async (_ctx, target) =>
      [MEETING, MEETING_2].includes(String(target.id)),
    );
    resetAbacRegistry();
    registerAbacRegistry(registry);

    careTeam = await mkChannel(kit, "care_team", PATIENT, [author, replier]);
    otherCareTeam = await mkChannel(kit, "care_team", OTHER_PATIENT, [author, replier]);
    location = await mkChannel(kit, "location", randomUUID(), [author, replier]);

    // Real M14 and M7 rows (FKs relaxed for the seed only: this suite proves nobody WRITES them).
    await kit.admin.query("SET session_replication_role = replica");
    await kit.admin.query(
      `INSERT INTO idg_meeting (id, organization_id, location_id, scheduled_start, scheduled_end, status,
                                coordinator_membership_id, tenant_quorum_snapshot)
       VALUES ($1,$2,$3, now(), now() + interval '1 hour', 'live', $4, '{}'::jsonb)`,
      [MEETING, ORG_A, randomUUID(), randomUUID()],
    );
    await kit.admin.query(
      `INSERT INTO care_plan (organization_id, provider_entity_id, location_id, patient_id, admission_id, initial_due_at)
       VALUES ($1,$2,$3,$4,$5, now())`,
      [ORG_A, randomUUID(), randomUUID(), PATIENT, randomUUID()],
    );
    await kit.admin.query("SET session_replication_role = DEFAULT");

    app = build({ "messaging.idg": true, "messaging.clinical_links": true });
    flagsOffApp = build({ "messaging.clinical_links": true });
    linksOffApp = build({ "messaging.idg": true });
    await Promise.all([app.ready(), flagsOffApp.ready(), linksOffApp.ready()]);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await flagsOffApp?.close();
    await linksOffApp?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await kit?.close();
  });

  describe("acceptance: a discussion never completes an IDG meeting or changes the plan of care", () => {
    it("leaves the M14 / M7 tables and the outbox untouched through root, reply, task, accept and complete", async () => {
      const before = await fingerprint();
      expect(Object.keys(before)).toEqual(expect.arrayContaining(["idg_meeting", "care_plan"]));
      const eventsBefore = await foreignOutboxCount();

      const rootId = await root(author, careTeam, link("idg_meeting", MEETING));
      const replyId = await reply(replier, careTeam, rootId, "Please review the pain plan");
      const conv = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${careTeam}/messages/${replyId}/tasks`,
        headers: as(author, ORG_A),
        payload: { assignee_user_id: replier },
      });
      expect(conv.statusCode, conv.body).toBe(201);
      const taskId = conv.json().task.id as string;
      const act = (verb: string, payload: object) =>
        app.inject({
          method: "POST",
          url: `/api/v1/messaging/tasks/${taskId}/${verb}`,
          headers: as(replier, ORG_A),
          payload,
        });
      expect((await act("accept", {})).statusCode).toBe(200);
      expect((await act("complete", { reason: "action_taken" })).statusCode).toBe(200);

      const shown = await list(replier, careTeam);
      expect(shown.statusCode).toBe(200);
      expect(shown.json().discussions.map((d: { messageId: string }) => d.messageId)).toContain(
        rootId,
      );

      expect(await fingerprint()).toEqual(before);
      expect(await foreignOutboxCount()).toBe(eventsBefore);
      const [meeting] = await kit.one<{ status: string; actual_end: string | null }>(
        `SELECT status::text, actual_end::text FROM idg_meeting WHERE id=$1`,
        [MEETING],
      );
      expect(meeting).toEqual({ status: "live", actual_end: null });
    });

    it("every outbox event this feature's route stack wrote belongs to M36", async () => {
      const types = await kit.one<{ event_type: string }>(
        `SELECT DISTINCT event_type FROM outbox_event`,
      );
      expect(types.filter((t) => FOREIGN_EVENT_PREFIX.test(t.event_type))).toEqual([]);
    });
  });

  describe("list", () => {
    let wanted: string[];
    let rootWithReply: string;

    beforeAll(async () => {
      const first = await root(author, careTeam, link("idg_meeting", MEETING_2));
      rootWithReply = first;
      await reply(replier, careTeam, first, "first reply");
      await reply(author, careTeam, first, "second reply");
      const second = await root(
        replier,
        careTeam,
        link("idg_meeting", MEETING),
        link("idg_meeting", MEETING_2),
      );
      // Not discussions: no idg link, a different link kind, a reply, a deleted root, another channel.
      await root(author, careTeam);
      await root(author, careTeam, link("order", ORDER));
      const deleted = await root(author, careTeam, link("idg_meeting", MEETING));
      const del = await app.inject({
        method: "DELETE",
        url: `/api/v1/messaging/messages/${deleted}`,
        headers: as(author, ORG_A),
      });
      expect(del.statusCode, del.body).toBe(204);
      await root(author, otherCareTeam, link("idg_meeting", MEETING));
      wanted = [second, first];
    });

    it("returns the idg-linked roots only, newest first, with reply counts and the link ids", async () => {
      const res = await list(author, careTeam);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.enabled).toBe(true);
      expect(body.patientId).toBe(PATIENT);
      const ids = body.discussions.map((d: { messageId: string }) => d.messageId);
      // The acceptance test's own root is also a discussion; the two roots seeded here sit above it (newest first).
      expect(ids.slice(0, 2)).toEqual(wanted);
      const first = body.discussions.find(
        (d: { messageId: string }) => d.messageId === rootWithReply,
      );
      expect(first.replyCount).toBe(2);
      expect(first.clinicalLinks.map((l: { kind: string }) => l.kind)).toEqual(["idg_meeting"]);
      expect(Object.keys(first.clinicalLinks[0]).sort()).toEqual(["entity_id", "kind", "link_id"]);
      expect(first.parentMessageId ?? null).toBeNull();
    });

    it("lists a root with two idg links once", async () => {
      const ids = (await list(author, careTeam))
        .json()
        .discussions.map((d: { messageId: string }) => d.messageId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("honours the limit and refuses 0 and 101", async () => {
      const one = await list(author, careTeam, ORG_A, app, "?limit=1");
      expect(one.json().discussions).toHaveLength(1);
      expect((await list(author, careTeam, ORG_A, app, "?limit=0")).statusCode).toBe(422);
      expect((await list(author, careTeam, ORG_A, app, "?limit=101")).statusCode).toBe(422);
    });

    it("is scoped to its channel: the other patient's channel shows only its own discussion", async () => {
      const res = await list(author, otherCareTeam);
      expect(res.json().discussions).toHaveLength(1);
      expect(res.json().patientId).toBe(OTHER_PATIENT);
    });

    it("answers an empty list with no patient for a channel that is not a care-team channel", async () => {
      await root(author, location, link("idg_meeting", MEETING));
      const res = await list(author, location);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: true, discussions: [], patientId: null });
    });
  });

  describe("read audit", () => {
    it("lands one list_viewed row for the reader, carrying the channel's patient and the count, and no body text", async () => {
      const rows = () =>
        kit.one<{ context: { patientId?: string; count?: number } }>(
          `SELECT context FROM audit_event
            WHERE organization_id=$1 AND actor_user_id=$2 AND resource_kind='message'
              AND event_type='message.list_viewed' ORDER BY created_at`,
          [ORG_A, replier],
        );
      const before = (await rows()).length;
      const res = await list(replier, careTeam);
      expect(res.statusCode).toBe(200);
      const after = await rows();
      expect(after.length).toBe(before + 1);
      const landed = after.at(-1)?.context;
      expect(landed?.patientId).toBe(PATIENT);
      expect(landed?.count).toBe(res.json().discussions.length);
      expect(JSON.stringify(landed)).not.toContain("IDG discussion");
    });
  });

  describe("refusals", () => {
    it("gives a non-member, org B and a Part 2 denial the answer a random channel gets", async () => {
      part2Denied.add(`${replier}:${PATIENT}`);
      try {
        const random = await list(author, RANDOM);
        const cases = [
          await list(outsider, careTeam),
          await list(orgBUser, careTeam, ORG_B),
          await list(replier, careTeam),
        ];
        for (const res of cases) {
          expect(res.statusCode).toBe(random.statusCode);
          expect(errorCode(res)).toBe(errorCode(random));
          expect(res.body).not.toContain("IDG discussion");
          expect(res.body).not.toContain(PATIENT);
        }
      } finally {
        part2Denied.delete(`${replier}:${PATIENT}`);
      }
      expect((await list(replier, careTeam)).statusCode).toBe(200);
    });

    it("is 401 anonymous and 404 for a malformed id", async () => {
      const anon = await app.inject({ method: "GET", url: listUrl(careTeam) });
      expect(anon.statusCode).toBe(401);
      expect((await list(author, "not-a-uuid")).statusCode).toBe(404);
    });
  });

  describe("flags", () => {
    it("answers enabled:false with nothing listed when messaging.idg is off", async () => {
      const res = await list(author, careTeam, ORG_A, flagsOffApp);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: false, discussions: [], patientId: null });
    });

    it("answers enabled:false when messaging.clinical_links is off", async () => {
      const res = await list(author, careTeam, ORG_A, linksOffApp);
      expect(res.json()).toEqual({ enabled: false, discussions: [], patientId: null });
    });

    it("still refuses a non-member before reading the flag (no oracle through enabled)", async () => {
      const off = await list(outsider, careTeam, ORG_A, flagsOffApp);
      const on = await list(outsider, careTeam);
      expect(off.statusCode).toBe(on.statusCode);
      expect(errorCode(off)).toBe(errorCode(on));
    });
  });
});
