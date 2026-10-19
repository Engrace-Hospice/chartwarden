// WP 4.9 (ADR-0076) - the supervisor's unacknowledged queue: the route over the REAL Authorization Contract, the service's
// visibility/restricted-row rules with fakes, and the cursor codec. The SQL half is the live suite (m36-unacknowledged.live.test.ts).
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  requirePermission,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { AckQueueResponse } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { AckRow } from "../src/modules/36-messaging/ack-requests/ack-types";
import {
  type QueuePage,
  type QueueQuery,
  decodeQueueCursor,
  encodeQueueCursor,
} from "../src/modules/36-messaging/ack-requests/unacknowledged-reader-db";
import { createUnacknowledgedService } from "../src/modules/36-messaging/ack-requests/unacknowledged-service";
import { registerUnacknowledgedRoutes } from "../src/modules/36-messaging/routes/unacknowledged-routes";

type Handler = (r: FastifyRequest, p: FastifyReply) => Promise<void>;

const ORG = "org_a";
const NOW = new Date("2026-10-18T12:00:00.000Z");
const VISIBLE_CH = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const HIDDEN_CH = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const HIDDEN_MSG = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";
const HIDDEN_PATIENT = "99999999-9999-4999-8999-000000000002";
const HIDDEN_ASSIGNEE = "dddddddd-dddd-4ddd-8ddd-000000000002";
const HIDDEN_REQUEST = "cccccccc-cccc-4ccc-8ccc-000000000002";
const TIE = "a".repeat(64);

const row = (over: Partial<AckRow> & { id: string; channelId: string }): AckRow => ({
  organizationId: ORG,
  messageId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
  patientId: "99999999-9999-4999-8999-000000000001",
  ackClass: "urgent",
  status: "pending",
  requesterUserId: "dddddddd-dddd-4ddd-8ddd-0000000000aa",
  assignedUserId: "dddddddd-dddd-4ddd-8ddd-000000000001",
  requestedAt: new Date("2026-10-18T11:30:00.000Z"),
  windowStartedAt: new Date("2026-10-18T11:30:00.000Z"),
  deadlineAt: new Date("2026-10-18T11:45:00.000Z"),
  currentTier: 0,
  acknowledgedAt: null,
  acknowledgedByUserId: null,
  resolvedAt: null,
  resolvedByUserId: null,
  cancelledAt: null,
  version: 0,
  ...over,
});

const COUNTS = { unfiltered: 3, matching: 3, overdue: 2, failed_unreachable: 1 };
let queries: QueueQuery[] = [];
let page: QueuePage;
let viewable: Set<string>;
let viewThrows: Set<string>;

const service = createUnacknowledgedService({
  now: () => NOW,
  read: async (_org, _user, q) => {
    queries.push(q);
    return page;
  },
  canViewChannel: async (_o, _u, channelId) => {
    if (viewThrows.has(channelId)) throw new Error("gate down");
    return viewable.has(channelId);
  },
  displayName: async (_o, id) => (id.endsWith("001") ? "Nina Nurse" : "Someone Else"),
});

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
}

function makeServer() {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "nurse",
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["messaging.read"] },
        ],
      },
      {
        orgId: ORG,
        userId: "supervisor",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["messaging.read", "messaging.review"],
          },
        ],
      },
    ]).store,
  );
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerUnacknowledgedRoutes(
    app,
    { service },
    { read: requirePermission("messaging.read") as Handler },
  );
  return app;
}

const get = (app: ReturnType<typeof makeServer>, user: string | null, qs = "") =>
  app.inject({
    method: "GET",
    url: `/api/v1/messaging/escalations/unacknowledged${qs}`,
    headers: user ? { "x-test-user": user } : {},
  });

beforeEach(() => {
  queries = [];
  viewable = new Set([VISIBLE_CH]);
  viewThrows = new Set();
  page = {
    rows: [
      {
        row: row({ id: "cccccccc-cccc-4ccc-8ccc-000000000001", channelId: VISIBLE_CH }),
        note: "route_unavailable",
      },
      {
        row: row({
          id: HIDDEN_REQUEST,
          channelId: HIDDEN_CH,
          messageId: HIDDEN_MSG,
          patientId: HIDDEN_PATIENT,
          assignedUserId: HIDDEN_ASSIGNEE,
          currentTier: 2,
          status: "escalated",
        }),
        note: "ladder_exhausted",
      },
      {
        row: row({
          id: "cccccccc-cccc-4ccc-8ccc-000000000003",
          channelId: VISIBLE_CH,
          status: "failed_unreachable",
          deadlineAt: new Date("2026-10-18T12:30:00.000Z"),
        }),
        note: null,
      },
    ],
    nextCursor: null,
    counts: COUNTS,
  };
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("GET /escalations/unacknowledged - access", () => {
  it("is 401 without a session and 403 for a clinician without messaging.review (the service is never reached)", async () => {
    const app = makeServer();
    expect((await get(app, null)).statusCode).toBe(401);
    expect((await get(app, "nurse")).statusCode).toBe(403);
    expect((await get(app, "nobody")).statusCode).toBe(403);
    expect(queries).toEqual([]);
    await app.close();
  });

  it("answers a supervisor with the whole default view and no filter", async () => {
    const app = makeServer();
    const res = await get(app, "supervisor");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as AckQueueResponse;
    expect(body.items).toHaveLength(3);
    expect(body.complete).toBe(true);
    expect(body.filtered).toBe(false);
    expect(body.audit_request_id).toBe("cccccccc-cccc-4ccc-8ccc-000000000001");
    expect(body.counts).toEqual(COUNTS);
    expect(queries[0]).toMatchObject({ status: null, overdueOnly: false, cursor: null, limit: 50 });
    await app.close();
  });

  it("rejects an unknown query key, a bad status, an out-of-range limit and a non-boolean overdue instead of ignoring them", async () => {
    const app = makeServer();
    for (const qs of [
      "?channel_id=x",
      "?status=acknowledged",
      "?status=resolved",
      "?limit=0",
      "?limit=101",
      "?overdue=maybe",
      "?limit=abc",
    ]) {
      expect((await get(app, "supervisor", qs)).statusCode, qs).toBe(422);
    }
    expect(queries).toEqual([]);
    await app.close();
  });

  it("passes the narrowing filters through and says the list is filtered", async () => {
    const app = makeServer();
    const res = await get(app, "supervisor", "?status=failed_unreachable&overdue=true&limit=10");
    const body = res.json() as AckQueueResponse;
    expect(body.filtered).toBe(true);
    expect(queries[0]).toMatchObject({
      status: "failed_unreachable",
      overdueOnly: true,
      limit: 10,
    });
    expect(body.counts.unfiltered).toBe(COUNTS.unfiltered);
    await app.close();
  });
});

describe("unacknowledged service - what the viewer is shown", () => {
  const actor = { orgId: ORG, userId: "supervisor" };

  it("lists a channel the viewer cannot open as a restricted row that withholds every id but keeps what is needed to chase it, and never drops it", async () => {
    const out = await service.list(actor, {});
    expect(out.items).toHaveLength(3);
    expect(out.items[1]).toMatchObject({
      restricted: true,
      id: null,
      channel_id: null,
      message_id: null,
      patient_id: null,
      assigned_user_id: null,
      assigned_display_name: "Someone Else",
      ack_class: "urgent",
      current_tier: 2,
      escalation_note: "ladder_exhausted",
      status: "escalated",
      overdue: true,
    });
    const wire = JSON.stringify(out);
    for (const secret of [HIDDEN_CH, HIDDEN_MSG, HIDDEN_PATIENT, HIDDEN_ASSIGNEE, HIDDEN_REQUEST]) {
      expect(wire).not.toContain(secret);
    }
  });

  it("withholds (restricted) rather than drops an item whose visibility check throws", async () => {
    viewThrows.add(VISIBLE_CH);
    const out = await service.list(actor, {});
    expect(out.items).toHaveLength(3);
    expect(out.items.every((i) => i.restricted)).toBe(true);
    expect(out.audit_request_id).toBeNull();
  });

  it("shows a visible row's ids, assignee name, overdue seconds, tier note and failure flag - and no text or patient label", async () => {
    const out = await service.list(actor, {});
    const [first, , failed] = out.items;
    expect(first).toMatchObject({
      restricted: false,
      id: "cccccccc-cccc-4ccc-8ccc-000000000001",
      channel_id: VISIBLE_CH,
      assigned_display_name: "Nina Nurse",
      overdue: true,
      overdue_seconds: 15 * 60,
      escalation_note: "route_unavailable",
      delivery_failed: false,
    });
    expect(failed).toMatchObject({ delivery_failed: true, overdue: false, overdue_seconds: 0 });
    expect(Object.keys(first ?? {}).sort()).toEqual(
      [
        "ack_class",
        "assigned_display_name",
        "assigned_user_id",
        "channel_id",
        "current_tier",
        "deadline_at",
        "delivery_failed",
        "escalation_note",
        "id",
        "message_id",
        "overdue",
        "overdue_seconds",
        "patient_id",
        "requested_at",
        "restricted",
        "status",
      ].sort(),
    );
  });

  it("states complete only when there is no next cursor, and clamps the limit", async () => {
    page = { ...page, nextCursor: encodeQueueCursor("2026-10-18 11:45:00+00", TIE) };
    const out = await service.list(actor, { limit: 5000 });
    expect(out.complete).toBe(false);
    expect(out.next_cursor).not.toBeNull();
    expect(queries[0]?.limit).toBe(100);
    await service.list(actor, { limit: 0 });
    expect(queries[1]?.limit).toBe(1);
  });
});

describe("queue cursor", () => {
  it("round-trips and never carries a request id", () => {
    const cursor = encodeQueueCursor("2026-10-18 11:45:00.123456+00", TIE);
    expect(decodeQueueCursor(cursor)).toEqual({
      deadlineAt: "2026-10-18 11:45:00.123456+00",
      tie: TIE,
    });
    expect(Buffer.from(cursor, "base64url").toString("utf8")).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-/,
    );
  });

  const b64 = (text: string) => Buffer.from(text).toString("base64url");
  it.each([
    ["empty", ""],
    ["one part", b64("2026-10-18 11:45:00+00")],
    ["three parts", b64(`2026-10-18 11:45:00+00|${TIE}|x`)],
    ["a sql-ish time", b64(`2026'; drop table x;--|${TIE}`)],
    ["a short tie", b64("2026-10-18 11:45:00+00|abc")],
    ["an uppercase tie", b64(`2026-10-18 11:45:00+00|${"A".repeat(64)}`)],
    ["a uuid instead of a tie", b64("2026-10-18 11:45:00+00|aaaaaaaa-aaaa-4aaa-8aaa-000000000001")],
  ])("refuses %s with a 400, never a first page", (_name, cursor) => {
    expect(() => decodeQueueCursor(cursor)).toThrowError(
      expect.objectContaining({ statusCode: 400, code: "INVALID_CURSOR" }),
    );
  });
});
