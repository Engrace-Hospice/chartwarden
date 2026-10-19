/**
 * M36 ADR-0081 (PROPOSED) - role-based send ("message the on-call RN"), LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * The real route stack (Authorization Contract incl. the REAL caseload_or_scope predicate, `channel_visibility`, the DB route service,
 * the audit plumbing, the M1 idempotency store) over the REAL urgent service, ack tracker and catalog-validating outbox publisher. Only
 * the EscalationRouter is a fake (M19's real router does not exist yet), behind the REAL `guardEscalationRouter`; the real deny-stub
 * answers the "not connected" case.
 *
 *   1. HAPPY PATH    one urgent message to the confirmed person; the request stores the ROLE (`addressed_role`) and the resolved
 *                    person (`assigned_user_id`, and the `requested` event); the send and the resolution read land audit rows.
 *   2. REPLAY        the same client id replays (200, one message) even after the roster moved on.
 *   3. REFUSALS      changed resolution (409), coverage gap and deny-stub (422), flag off (404), response tracking off (503), a
 *                    patient that is not the conversation's (404), a caller without the key (403): every one writes NOTHING.
 *   4. DB BACKSTOPS  migration 1129: the role CHECK, the role is immutable even for a superuser, a person-named request has none.
 *   5. TENANCY       another organisation sees no request row (RLS still FORCEd after the new column).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m36:role-send:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the wardenx_* roles.
 */
import { randomUUID } from "node:crypto";
import {
  createPredicateRegistry,
  registerAbacRegistry,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { EscalationRouteAnswer, EscalationRouter } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { escalationRouterDenyStub } from "../src/bootstrap/seams/providers";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/abac-predicates";
import { guardEscalationRouter } from "../src/modules/36-messaging/ack-escalation/escalation-router-guard";
import { buildAckDeps } from "../src/modules/36-messaging/ack-requests/deps";
import { createDbRoleReplayLookup } from "../src/modules/36-messaging/ack-requests/role-replay-lookup";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { createDbChannelFactsLookup } from "../src/modules/36-messaging/medication-questions/deps";
import { createMentionActorNameResolver } from "../src/modules/36-messaging/mention-non-member-service-db";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { buildUrgentDeps } from "../src/modules/36-messaging/urgent/deps";
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

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a810001";
const ORG_B = "22222222-2222-4222-8222-22220a810002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a81a1";
const OTHER_PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a81a2";
const FLAGS = {
  "messaging.role_send": true,
  "messaging.ack_requests": true,
  "messaging.urgent_clinical": true,
  "messaging.sbar": true,
};
const ROLE_KEYS = ["messaging.urgent.send", "messaging.oncall.send"];
const SEND_KEYS = [...STAFF_KEYS, ...ROLE_KEYS];
const RECEIVE_KEYS = [...STAFF_KEYS, "messaging.urgent.receive"];

const para = (value: string) => ({ type: "paragraph", content: [{ type: "text", text: value }] });
const sbarDoc = () => ({
  schemaVersion: 1,
  doc: {
    type: "doc",
    content: [
      {
        type: "sbar",
        urgencyHint: "routine",
        situation: [para("Uncontrolled pain nine of ten")],
        background: [para("Day three on service, on morphine")],
        assessment: [para("Pain is not controlled by the current plan")],
        recommendation: [para("Please review the plan within the hour")],
      },
    ],
  },
});

describe.skipIf(!DB_URL)("M36 ADR-0081 role-based send - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  let offApp: FastifyInstance;
  let untrackedApp: FastifyInstance;
  let nurse: string;
  let noKey: string;
  let rn: string;
  let rn2: string;
  let orgBUser: string;
  let channel: string;
  let careTeam: string[] = [];
  const keysOf = new Map<string, readonly string[]>();
  let router: EscalationRouter = escalationRouterDenyStub;

  const covering = (...ids: string[]): EscalationRouter => ({
    resolveTier: async (_org, request): Promise<EscalationRouteAnswer> => ({
      kind: "resolved",
      userIds: ids as [string, ...string[]],
      nextTier: null,
      timeZone: "America/Los_Angeles",
      tier: request.tier,
      asOf: request.asOf,
      source: "m19",
    }),
  });
  const gap: EscalationRouter = {
    resolveTier: async (_org, request): Promise<EscalationRouteAnswer> => ({
      kind: "coverage_gap",
      nextTier: null,
      timeZone: "America/Los_Angeles",
      tier: request.tier,
      asOf: request.asOf,
      source: "m19",
    }),
  };

  const seed = async (suffix: string, org: string, keys: string[]) => {
    const id = await kit.seedUser(suffix, org, keys);
    keysOf.set(id, keys);
    return id;
  };
  const permissionsFor = async (_org: string, userId: string) => new Set(keysOf.get(userId) ?? []);

  const makeServer = (flags: Record<string, boolean>) => {
    const server = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(kit.handle.db),
    });
    const shared = {
      db: kit.handle.db,
      flags: { forOrg: async () => flags },
      outbox: catalogOutbox() as never,
      permissionsFor,
      part2Gate: {
        allowedUserIds: async ({ userIds }: { userIds: readonly string[] }) => new Set(userIds),
      },
      careTeamMembers: async () => careTeam,
    };
    const ackBinding = buildAckDeps({ ...shared, messaging: kit.service });
    const urgent = buildUrgentDeps({
      ...shared,
      messaging: kit.service,
      responseTracker: ackBinding.responseTracker,
    });
    const channelFacts = createDbChannelFactsLookup(kit.handle.db);
    registerMessagingRoutes(server, {
      service: kit.service,
      announcements: createDbAnnouncementService(kit.handle.db),
      urgent,
      ackRequests: { service: ackBinding.service },
      oncall: {
        patientExists: async (_org, id) => id === PATIENT || id === OTHER_PATIENT,
        service: { get: async () => Promise.reject(new Error("directory not under test")) },
        roleSend: {
          isEnabled: async () => flags["messaging.role_send"] === true,
          router: guardEscalationRouter({
            resolveTier: (org, req) => router.resolveTier(org, req),
          }),
          displayName: createMentionActorNameResolver(kit.handle.db),
          channelPatient: async (org, ch) => {
            const facts = await channelFacts(org, ch);
            return facts?.kind === "care_team" ? facts.subjectId : null;
          },
          findReplay: createDbRoleReplayLookup(kit.handle.db),
        },
      },
    });
    return server;
  };

  const RES = (ch = channel) => `/api/v1/messaging/channels/${ch}/role-send/resolution`;
  const SEND = (ch = channel) => `/api/v1/messaging/channels/${ch}/role-send`;
  const resolve = (server: FastifyInstance, user: string, qs = `?role=rn&patient_id=${PATIENT}`) =>
    server.inject({ method: "GET", url: `${RES()}${qs}`, headers: as(user, ORG_A) });
  const send = (
    server: FastifyInstance,
    user: string,
    body: Record<string, unknown> = {},
    opts: { org?: string } = {},
  ) =>
    server.inject({
      method: "POST",
      url: SEND(),
      headers: as(user, opts.org ?? ORG_A, randomUUID()),
      payload: {
        role: "rn",
        patient_id: PATIENT,
        recipient_user_id: rn,
        body_doc: sbarDoc(),
        client_message_id: randomUUID(),
        ...body,
      },
    });
  const totals = async () => [
    await kit.count("SELECT count(*)::int AS n FROM message WHERE organization_id=$1", [ORG_A]),
    await kit.count("SELECT count(*)::int AS n FROM message_acknowledgment_request"),
    await kit.count("SELECT count(*)::int AS n FROM message_acknowledgment_event"),
    await kit.count("SELECT count(*)::int AS n FROM outbox_event"),
  ];
  const requestOf = async (messageId: string) =>
    (
      await kit.one<{
        id: string;
        addressed_role: string | null;
        assigned_user_id: string;
        requester_user_id: string;
      }>(
        "SELECT id, addressed_role, assigned_user_id, requester_user_id FROM message_acknowledgment_request WHERE message_id=$1",
        [messageId],
      )
    )[0];
  const asAdmin = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    try {
      await kit.admin.query(sql, params);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  };

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "adr81");
    nurse = await seed("nurse", ORG_A, SEND_KEYS);
    noKey = await seed("nokey", ORG_A, [...STAFF_KEYS, "messaging.urgent.send"]);
    rn = await seed("rn", ORG_A, RECEIVE_KEYS);
    rn2 = await seed("rn2", ORG_A, RECEIVE_KEYS);
    orgBUser = await seed("orgb", ORG_B, [...SEND_KEYS, ...RECEIVE_KEYS]);
    channel = await mkChannel(kit, "care_team", PATIENT, [nurse, noKey, rn, rn2]);
    careTeam = [nurse, noKey, rn, rn2];

    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return kit.service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    // The REAL M7 caseload_or_scope predicate over a caseload that holds the nurse's two patients.
    const predicates = buildCarePlanAbacPredicates({
      resolver: { loadPlan: async () => null } as never,
      isInCaseload: async (q) =>
        [nurse, noKey].includes(q.userId) && [PATIENT, OTHER_PATIENT].includes(q.patientId),
    });
    registry.register("caseload_or_scope", predicates.caseload_or_scope as never);
    registerAbacRegistry(registry);

    app = makeServer(FLAGS);
    offApp = makeServer({ ...FLAGS, "messaging.role_send": false });
    untrackedApp = makeServer({ ...FLAGS, "messaging.ack_requests": false });
    await Promise.all([app.ready(), offApp.ready(), untrackedApp.ready()]);
  }, 240_000);

  afterAll(async () => {
    await Promise.all([app?.close(), offApp?.close(), untrackedApp?.close()]);
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await kit?.close();
  });

  describe("send", () => {
    it("stores one urgent message, the ROLE and the resolved person, and audits the resolution and the send", async () => {
      router = covering(rn);
      const seen = await resolve(app, nurse);
      expect(seen.statusCode, seen.body).toBe(200);
      expect(seen.json()).toMatchObject({ status: "covered", people: [{ user_id: rn }] });
      const res = await send(app, nurse);
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ recipient_user_id: rn, role: "rn", created: true });
      const request = await requestOf(body.message_id);
      expect(request).toMatchObject({
        addressed_role: "rn",
        assigned_user_id: rn,
        requester_user_id: nurse,
      });
      // ADR-0081 follow-on: the request read exposes the role (closed enum) for the card.
      const read = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/escalations/${request?.id}`,
        headers: as(nurse, ORG_A),
      });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().request.addressed_role).toBe("rn");
      const first = await kit.one<{ event_type: string; assigned_user_id: string }>(
        "SELECT event_type, assigned_user_id FROM message_acknowledgment_event WHERE request_id=$1 ORDER BY created_at, id",
        [request?.id],
      );
      expect(first[0]).toMatchObject({ event_type: "requested", assigned_user_id: rn });
      const message = (
        await kit.one<{ urgency: string; urgent_recipient_user_id: string }>(
          "SELECT urgency, urgent_recipient_user_id FROM message WHERE id=$1",
          [body.message_id],
        )
      )[0];
      expect(message).toMatchObject({ urgency: "urgent", urgent_recipient_user_id: rn });
      const viewed =
        "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND actor_user_id=$2 AND resource_id=$3 AND event_type LIKE '%.viewed'";
      expect(await kit.count(viewed, [ORG_A, nurse, body.message_id])).toBeGreaterThanOrEqual(1);
      expect(await kit.count(viewed, [ORG_A, nurse, channel])).toBeGreaterThanOrEqual(1);
    });

    it("replays the same client id (200, one message) even after the roster moved on", async () => {
      router = covering(rn);
      const clientId = randomUUID();
      const first = await send(app, nurse, { client_message_id: clientId });
      expect(first.statusCode, first.body).toBe(201);
      router = covering(rn2);
      const before = await totals();
      const again = await send(app, nurse, { client_message_id: clientId });
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toMatchObject({ created: false, message_id: first.json().message_id });
      expect(await totals()).toEqual(before);
    });

    it("a replay returns the ORIGINAL result even after response tracking was turned off", async () => {
      router = covering(rn);
      const clientId = randomUUID();
      const first = await send(app, nurse, { client_message_id: clientId });
      expect(first.statusCode, first.body).toBe(201);
      const before = await totals();
      const again = await send(untrackedApp, nurse, { client_message_id: clientId });
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toMatchObject({
        created: false,
        role: "rn",
        message_id: first.json().message_id,
        recipient_user_id: rn,
      });
      expect(await totals()).toEqual(before);
    });

    it("a client id already used for a person-send or another role is a typed 409, never echoed as this role", async () => {
      router = covering(rn);
      const personClientId = randomUUID();
      const named = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${channel}/urgent-messages`,
        headers: as(nurse, ORG_A, randomUUID()),
        payload: { body_doc: sbarDoc(), recipient_user_id: rn, client_message_id: personClientId },
      });
      expect(named.statusCode, named.body).toBe(201);
      const before = await totals();
      const reused = await send(app, nurse, { client_message_id: personClientId });
      expect(reused.statusCode, reused.body).toBe(409);
      expect(errorCode(reused)).toBe("ROLE_SEND_CLIENT_ID_REUSED");
      // A role send under id R, then the same id with ANOTHER role: also refused.
      const roleClientId = randomUUID();
      expect((await send(app, nurse, { client_message_id: roleClientId })).statusCode).toBe(201);
      const otherRole = await send(app, nurse, {
        client_message_id: roleClientId,
        role: "physician",
      });
      expect(otherRole.statusCode, otherRole.body).toBe(409);
      expect(errorCode(otherRole)).toBe("ROLE_SEND_CLIENT_ID_REUSED");
      expect((await totals())[0]).toBe((before[0] ?? 0) + 1);
    });
  });

  describe("refusals write nothing", () => {
    it("a changed resolution is a 409", async () => {
      router = covering(rn2);
      const before = await totals();
      const res = await send(app, nurse, { recipient_user_id: rn });
      expect(res.statusCode, res.body).toBe(409);
      expect(errorCode(res)).toBe("ROLE_SEND_RESOLUTION_CHANGED");
      expect(await totals()).toEqual(before);
    });

    it("a coverage gap and the real deny-stub are 422 with the telephone procedure", async () => {
      for (const unavailable of [gap, escalationRouterDenyStub]) {
        router = unavailable;
        const before = await totals();
        const res = await send(app, nurse);
        expect(res.statusCode, res.body).toBe(422);
        expect(errorCode(res)).toBe("ROLE_SEND_NO_COVERAGE");
        expect(res.json().error.message).toContain("telephone procedure");
        expect(await totals()).toEqual(before);
      }
      router = escalationRouterDenyStub;
      expect((await resolve(app, nurse)).json()).toMatchObject({
        status: "roster_not_connected",
        people: [],
      });
    });

    it("the tenant flag off is the uniform 404; response tracking off is a 503; nothing is written", async () => {
      router = covering(rn);
      const before = await totals();
      expect((await send(offApp, nurse)).statusCode).toBe(404);
      expect((await resolve(offApp, nurse)).statusCode).toBe(404);
      const untracked = await send(untrackedApp, nurse);
      expect(untracked.statusCode, untracked.body).toBe(503);
      expect(errorCode(untracked)).toBe("ROLE_SEND_UNAVAILABLE");
      expect(await totals()).toEqual(before);
    });

    it("needs messaging.oncall.send (403), refuses another patient than the conversation's (404) and another organisation (403)", async () => {
      router = covering(rn);
      const before = await totals();
      expect((await send(app, noKey)).statusCode).toBe(403);
      expect((await send(app, nurse, { patient_id: OTHER_PATIENT })).statusCode).toBe(404);
      const cross = await send(app, orgBUser, {}, { org: ORG_B });
      // channel_visibility is the existing (sibling-urgent-route) deny: an invisible channel is a 403 here.
      expect(cross.statusCode, cross.body).toBe(403);
      expect((await send(app, nurse, { role: "admin" })).statusCode).toBe(422);
      expect(await totals()).toEqual(before);
    });
  });

  describe("migration 1129 backstops", () => {
    it("the role is a closed set, is immutable even for a superuser, and a person-named request has none", async () => {
      router = covering(rn);
      const made = (await send(app, nurse)).json();
      const request = await requestOf(made.message_id);
      expect(
        await asAdmin(
          "UPDATE message_acknowledgment_request SET addressed_role='physician' WHERE id=$1",
          [request?.id],
        ),
      ).toMatch(/message_ack_request_role_immutable/);
      expect(
        await asAdmin(
          "UPDATE message_acknowledgment_request SET addressed_role='admin' WHERE id=$1",
          [request?.id],
        ),
      ).toMatch(/message_ack_request_addressed_role|role_immutable/);
      expect((await requestOf(made.message_id))?.addressed_role).toBe("rn");
      // The ordinary urgent send (a named person, no role) leaves the column null.
      const named = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${channel}/urgent-messages`,
        headers: as(nurse, ORG_A, randomUUID()),
        payload: { body_doc: sbarDoc(), recipient_user_id: rn, client_message_id: randomUUID() },
      });
      expect(named.statusCode, named.body).toBe(201);
      expect((await requestOf(named.json().message_id))?.addressed_role).toBeNull();
    });

    it("tenancy: another organisation sees no request row as the app role", async () => {
      await kit.appConn.query("BEGIN");
      try {
        await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
        const res = await kit.appConn.query(
          "SELECT count(*)::int AS n FROM message_acknowledgment_request",
        );
        expect(res.rows[0].n).toBe(0);
      } finally {
        await kit.appConn.query("ROLLBACK");
      }
    });
  });
});
