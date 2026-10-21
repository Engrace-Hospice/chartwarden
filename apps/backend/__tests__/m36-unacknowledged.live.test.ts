/**
 * M36 WP 4.9 (ADR-0076) - the supervisor's unacknowledged queue, LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * The real route stack (Authorization Contract, `messaging.read` + `messaging.review`, the DB reader, the DB channel check, the
 * Part 2 gate seam, read-audit) over requests seeded through the real insert guard, then moved through the legal transitions.
 *
 *   1. EVERYTHING     the default view lists every waiting request in the organisation (pending, escalated, failed_unreachable;
 *                     overdue or not) and nothing else: acknowledged, resolved and cancelled are absent; another tenant's never appear.
 *   2. NONE HIDDEN    status and overdue filters only narrow (subset, nothing outside it is missing), the unfiltered total never moves,
 *                     and paging at any size reproduces the default list exactly - including requests that share a deadline.
 *   3. SCOPE          a request in a channel the supervisor is not a member of, or whose Part 2 gate denies them, is a restricted row
 *                     with no request, channel, message, patient or assignee id; it is still listed and counted.
 *   4. ACCESS         401 without a session, 403 for a clinician without messaging.review, a malformed cursor is a 400.
 *   5. NO BODY        no message text, no patient name; read-only (no row, event or outbox row changes); one read-audit row per patient.
 *   6. OPS NUMBERS    the per-org stats reader the gauges and the notice use, under RLS.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:unacknowledged:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the wardenx_* roles.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AckQueueItemDto, AckQueueResponse } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbAckQueueStatsReader } from "../src/modules/36-messaging/ack-requests/ack-queue-stats-db";
import {
  createDbUnacknowledgedReader,
  queueFilters,
  queueRowsQuery,
} from "../src/modules/36-messaging/ack-requests/unacknowledged-reader-db";
import { createUnacknowledgedService } from "../src/modules/36-messaging/ack-requests/unacknowledged-service";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { createMentionActorNameResolver } from "../src/modules/36-messaging/mention-non-member-service-db";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import {
  type LiveKit,
  STAFF_KEYS,
  as,
  bootLiveKit,
  catalogOutbox,
  headerAuth,
  mkChannel,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a490001";
const ORG_B = "22222222-2222-4222-8222-22220a490002";
const PATIENT_1 = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a49a1";
const PATIENT_2 = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a49a2";
const PATIENT_B = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a49b1";
const SECRET = "Okafor MRN 88421 morphine";
const URL_OF = "/api/v1/messaging/escalations/unacknowledged";
const SUPERVISOR_KEYS = [...STAFF_KEYS, "messaging.review"];
const HOUR_MS = 3_600_000;

describe.skipIf(!DB_URL)("M36 WP 4.9 unacknowledged queue - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  let nurse: string;
  let rn: string;
  let supervisor: string;
  let plainClinician: string;
  let supervisorB: string;
  let memberChannel: string;
  let otherChannel: string;
  let channelB: string;
  /** Milliseconds the service clock runs ahead of the database clock: deadlines fall behind it, so requests become overdue. */
  let skewMs = 0;
  let part2Denied = false;

  const ids: Record<string, string> = {};

  const audit = (user: string) =>
    kit.count(
      "SELECT count(*)::int AS n FROM audit_event WHERE actor_user_id=$1 AND event_type LIKE 'message_acknowledgment_request.%'",
      [user],
    );
  const list = (user: string, org: string, qs = "") =>
    app.inject({ method: "GET", url: `${URL_OF}${qs}`, headers: as(user, org) });
  const body = (res: { body: string }) => JSON.parse(res.body) as AckQueueResponse;

  /** Walk every page at `limit`, returning the items in order and the number of pages. */
  const walk = async (user: string, org: string, limit: number, qs = "") => {
    const items: AckQueueItemDto[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await list(
        user,
        org,
        `?limit=${limit}${qs}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(res.statusCode, res.body).toBe(200);
      const page = body(res);
      items.push(...page.items);
      cursor = page.next_cursor;
      pages += 1;
      expect(page.complete).toBe(cursor === null);
      expect(pages).toBeLessThan(50);
    } while (cursor);
    return { items, pages };
  };
  const key = (i: AckQueueItemDto) =>
    `${i.deadline_at}|${i.status}|${i.assigned_display_name}|${i.id}`;

  const newMessage = async (channel: string, org = ORG_A, author = nurse) =>
    (await kit.service.sendMessage(org, { channelId: channel, authorUserId: author, body: SECRET }))
      .messageId;

  /** A request is BORN pending (the insert guard), so every other state is reached by the legal transition, as the timer or a person would. */
  const born = async (
    name: string,
    channel: string,
    patient: string,
    over: {
      requester?: string;
      assignee?: string;
      org?: string;
      minutes?: number;
      role?: "rn" | "physician";
    } = {},
  ): Promise<string> => {
    const org = over.org ?? ORG_A;
    const requester = over.requester ?? nurse;
    const messageId = await newMessage(channel, org, requester);
    const id = (
      await kit.admin.query(
        `INSERT INTO message_acknowledgment_request
           (organization_id, message_id, channel_id, patient_id, ack_class, requester_user_id, assigned_user_id, requested_at, window_started_at, deadline_at, addressed_role)
         VALUES ($1,$2,$3,$4,'important',$5,$6,now(),now(), now() + make_interval(mins => $7), $8) RETURNING id`,
        [
          org,
          messageId,
          channel,
          patient,
          requester,
          over.assignee ?? rn,
          over.minutes ?? 60,
          over.role ?? null,
        ],
      )
    ).rows[0].id as string;
    ids[name] = id;
    return id;
  };
  const transition = (id: string, set: string, params: unknown[] = []) =>
    kit.admin.query(
      `UPDATE message_acknowledgment_request SET ${set}, version=version+1 WHERE id=$1`,
      [id, ...params],
    );
  const escalate = (id: string) =>
    transition(
      id,
      "status='escalated', current_tier=1, window_started_at=now(), deadline_at=now() + interval '30 minutes'",
    );
  const unreachable = (id: string) => transition(id, "status='failed_unreachable'");
  /** The assignee's own act: the guard demands the session's actor (`app.user_id`) be the assignee. */
  const acknowledge = async (id: string, set = "") => {
    const owner = (
      await kit.one<{ assigned_user_id: string }>(
        "SELECT assigned_user_id FROM message_acknowledgment_request WHERE id=$1",
        [id],
      )
    )[0]?.assigned_user_id as string;
    await kit.admin.query("BEGIN");
    try {
      await kit.admin.query("SELECT set_config('app.user_id', $1, true)", [owner]);
      await transition(
        id,
        `${set || "status='acknowledged'"}, acknowledged_at=coalesce(acknowledged_at, now()), acknowledged_by_user_id=assigned_user_id`,
      );
      await kit.admin.query("COMMIT");
    } catch (error) {
      await kit.admin.query("ROLLBACK");
      throw error;
    }
  };

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp49");
    nurse = await kit.seedUser("nurse", ORG_A, STAFF_KEYS);
    rn = await kit.seedUser("rn", ORG_A, STAFF_KEYS);
    supervisor = await kit.seedUser("supervisor", ORG_A, SUPERVISOR_KEYS);
    plainClinician = await kit.seedUser("plain", ORG_A, STAFF_KEYS);
    supervisorB = await kit.seedUser("supervisorb", ORG_B, SUPERVISOR_KEYS);
    const nurseB = await kit.seedUser("nurseb", ORG_B, STAFF_KEYS);
    const rnB = await kit.seedUser("rnb", ORG_B, STAFF_KEYS);

    // The supervisor is a member of one patient channel, NOT of the second (an ordinary supervisor), and of a third whose Part 2 gate
    // is switched off for them in some tests.
    memberChannel = await mkChannel(kit, "care_team", PATIENT_1, [nurse, rn, supervisor]);
    otherChannel = await mkChannel(kit, "care_team", PATIENT_2, [nurse, rn]);
    channelB = (
      await kit.admin.query(
        `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
         VALUES ($1,'care_team',$2,'wp49-b','care_related') RETURNING id`,
        [ORG_B, PATIENT_B],
      )
    ).rows[0].id as string;
    for (const u of [nurseB, rnB, supervisorB]) {
      await kit.admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source) VALUES ($1,$2,$3,'member','manual')`,
        [ORG_B, channelB, u],
      );
    }

    // org A: seven requests. Three share one deadline (one transaction => one now()).
    await born("pending_visible", memberChannel, PATIENT_1, { minutes: 10, role: "rn" });
    await born("pending_restricted", otherChannel, PATIENT_2, { minutes: 20, role: "physician" });
    await born("to_escalate", memberChannel, PATIENT_1, { minutes: 5 });
    await escalate(ids.to_escalate as string);
    await born("to_fail", otherChannel, PATIENT_2, { minutes: 90 });
    await unreachable(ids.to_fail as string);
    await kit.admin.query("BEGIN");
    for (const n of ["tie_1", "tie_2", "tie_3"])
      await born(n, memberChannel, PATIENT_1, { minutes: 40 });
    await kit.admin.query("COMMIT");
    // closed or owned: never in the queue.
    await born("acknowledged", memberChannel, PATIENT_1, { minutes: 15 });
    await acknowledge(ids.acknowledged as string);
    await born("resolved", memberChannel, PATIENT_1, { minutes: 16 });
    await acknowledge(ids.resolved as string);
    await acknowledge(
      ids.resolved as string,
      "status='resolved', resolved_at=now(), resolved_by_user_id=assigned_user_id",
    );
    await born("cancelled", otherChannel, PATIENT_2, { minutes: 17 });
    await transition(ids.cancelled as string, "status='cancelled', cancelled_at=now()");
    // another tenant's, waiting and failed.
    await born("b_pending", channelB, PATIENT_B, {
      org: ORG_B,
      requester: nurseB,
      assignee: rnB,
      minutes: 5,
    });

    // Part 2: a second route service whose gate denies everyone, used as the queue's visibility check on demand.
    const gated = createDbMessagingRouteService(kit.handle.db, {
      kek: randomBytes(32),
      outbox: catalogOutbox() as never,
      part2Gate: {
        allowedUserIds: async ({ userIds }) => (part2Denied ? new Set() : new Set(userIds)),
      },
    });
    app = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    registerMessagingRoutes(app, {
      service: kit.service,
      announcements: createDbAnnouncementService(kit.handle.db),
      unacknowledged: {
        service: createUnacknowledgedService({
          read: createDbUnacknowledgedReader(kit.handle.db),
          canViewChannel: gated.canViewChannel,
          displayName: createMentionActorNameResolver(kit.handle.db),
          now: () => new Date(Date.now() + skewMs),
        }),
      },
    });
    await app.ready();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await kit?.close();
  });

  describe("everything in scope, nothing else", () => {
    it("lists every waiting request of the organisation - visible and restricted - and only those", async () => {
      skewMs = 0;
      const res = await list(supervisor, ORG_A);
      expect(res.statusCode, res.body).toBe(200);
      const out = body(res);
      // 7 waiting: pending_visible, pending_restricted, to_escalate, to_fail, tie x3. (acknowledged, resolved, cancelled, org B: not.)
      expect(out.items).toHaveLength(7);
      expect(out.counts).toEqual({ unfiltered: 7, matching: 7, overdue: 0, failed_unreachable: 1 });
      expect(out.complete).toBe(true);
      expect(out.filtered).toBe(false);
      const shown = out.items.filter((i) => !i.restricted).map((i) => i.id);
      for (const name of ["pending_visible", "to_escalate", "tie_1", "tie_2", "tie_3"]) {
        expect(shown, name).toContain(ids[name]);
      }
      for (const name of ["acknowledged", "resolved", "cancelled", "b_pending"]) {
        expect(JSON.stringify(out), name).not.toContain(ids[name] as string);
      }
      // oldest deadline first.
      const deadlines = out.items.map((i) => Date.parse(i.deadline_at));
      expect([...deadlines].sort((a, b) => a - b)).toEqual(deadlines);
    });

    it("marks what is overdue and what could not be delivered, and counts them", async () => {
      skewMs = 25 * 60_000; // the 5 and 10 minute deadlines (and the escalated one's 30) are behind the service clock by now
      const out = body(await list(supervisor, ORG_A));
      skewMs = 0;
      const byId = new Map(out.items.map((i) => [i.id, i]));
      expect(byId.get(ids.pending_visible as string)).toMatchObject({
        overdue: true,
        status: "pending",
      });
      expect(byId.get(ids.pending_visible as string)?.overdue_seconds).toBeGreaterThan(14 * 60);
      expect(byId.get(ids.to_escalate as string)).toMatchObject({
        status: "escalated",
        current_tier: 1,
        overdue: false,
      });
      expect(out.counts.overdue).toBe(out.items.filter((i) => i.overdue).length);
      const failed = out.items.find((i) => i.delivery_failed);
      expect(failed).toMatchObject({ status: "failed_unreachable", restricted: true });
      expect(out.counts.failed_unreachable).toBe(1);
    });

    it("shows a failed_unreachable request even though no filter was asked for", async () => {
      const out = body(await list(supervisor, ORG_A));
      expect(out.items.some((i) => i.status === "failed_unreachable")).toBe(true);
    });

    it("is empty and complete for an organisation with nothing waiting once the filter excludes its only request", async () => {
      const out = body(await list(supervisorB, ORG_B, "?status=failed_unreachable"));
      expect(out.items).toEqual([]);
      expect(out.complete).toBe(true);
      expect(out.filtered).toBe(true);
      expect(out.counts).toMatchObject({ unfiltered: 1, matching: 0 });
    });

    it("never lets one tenant see or count another's", async () => {
      const a = body(await list(supervisor, ORG_A));
      const b = body(await list(supervisorB, ORG_B));
      expect(b.items).toHaveLength(1);
      expect(b.counts.unfiltered).toBe(1);
      expect(JSON.stringify(b)).not.toContain(ids.pending_visible as string);
      expect(JSON.stringify(a)).not.toContain(ids.b_pending as string);
      // a header pointing a user at the other tenant is the tenant guard's, not this route's: the user has no membership there.
      const crossed = await list(supervisor, ORG_B);
      expect(crossed.statusCode).toBeGreaterThanOrEqual(400);
      expect(crossed.body).not.toContain(ids.b_pending as string);
    });
  });

  describe("filters never hide, paging never loses", () => {
    it("a filter returns exactly the matching subset of the default view, and the unfiltered total does not move", async () => {
      skewMs = 25 * 60_000;
      const all = body(await list(supervisor, ORG_A, "?limit=100"));
      for (const [qs, match] of [
        ["?status=pending", (i: AckQueueItemDto) => i.status === "pending"],
        ["?status=escalated", (i: AckQueueItemDto) => i.status === "escalated"],
        ["?status=failed_unreachable", (i: AckQueueItemDto) => i.status === "failed_unreachable"],
        ["?overdue=true", (i: AckQueueItemDto) => i.overdue],
        [
          "?status=pending&overdue=true",
          (i: AckQueueItemDto) => i.status === "pending" && i.overdue,
        ],
      ] as const) {
        const narrowed = body(await list(supervisor, ORG_A, `${qs}&limit=100`));
        expect(narrowed.filtered, qs).toBe(true);
        expect(narrowed.counts.unfiltered, qs).toBe(all.counts.unfiltered);
        expect(narrowed.counts.matching, qs).toBe(narrowed.items.length);
        expect(narrowed.items.map(key), qs).toEqual(all.items.filter(match).map(key));
      }
      skewMs = 0;
    });

    it.each([1, 2, 3, 7, 100])(
      "paging at limit %i reproduces the default list exactly (ties on one deadline included)",
      async (limit) => {
        const all = body(await list(supervisor, ORG_A, "?limit=100")).items;
        const walked = await walk(supervisor, ORG_A, limit);
        expect(walked.items.map(key)).toEqual(all.map(key));
        expect(new Set(walked.items.map(key)).size).toBe(all.length);
        expect(walked.pages).toBe(Math.ceil(all.length / limit));
      },
    );

    it("a request that appears between two pages is not lost and not repeated for the part already read", async () => {
      const first = body(await list(supervisor, ORG_A, "?limit=3"));
      const late = await born("late_arrival", memberChannel, PATIENT_1, { minutes: 100 });
      const rest = await walk(supervisor, ORG_A, 3, "");
      const seen = new Set(first.items.map(key));
      const fromCursor = body(
        await list(
          supervisor,
          ORG_A,
          `?limit=100&cursor=${encodeURIComponent(first.next_cursor as string)}`,
        ),
      );
      expect(fromCursor.items.some((i) => i.id === late)).toBe(true);
      expect(fromCursor.items.some((i) => seen.has(key(i)))).toBe(false);
      expect(rest.items.some((i) => i.id === late)).toBe(true);
      await acknowledge(late);
    });

    it("the cursor carries no request id, and a tampered or foreign-shaped cursor is a 400 and never a first page", async () => {
      const first = body(await list(supervisor, ORG_A, "?limit=2"));
      const decoded = Buffer.from(first.next_cursor as string, "base64url").toString("utf8");
      expect(decoded).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
      for (const bad of [
        "garbage",
        Buffer.from("x|y").toString("base64url"),
        Buffer.from(`2026-01-01 00:00:00+00|${ids.pending_visible}`).toString("base64url"),
        // well-shaped but not a real instant: a 400, never a timestamptz cast error (500)
        Buffer.from(`2026-13-45 99:99:99+00|${"a".repeat(64)}`).toString("base64url"),
        Buffer.from(`2026-02-30 10:00:00+00|${"a".repeat(64)}`).toString("base64url"),
        Buffer.from(
          `2026-01-01'; DROP TABLE message_acknowledgment_request;--|${"a".repeat(64)}`,
        ).toString("base64url"),
      ]) {
        const res = await list(supervisor, ORG_A, `?cursor=${encodeURIComponent(bad)}`);
        expect(res.statusCode, bad).toBe(400);
      }
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message_acknowledgment_request WHERE organization_id=$1",
          [ORG_A],
        ),
      ).toBeGreaterThan(0);
    });

    it("rejects a filter it does not know instead of ignoring it", async () => {
      for (const qs of [
        `?channel_id=${memberChannel}`,
        `?assignee=${rn}`,
        "?status=acknowledged",
        "?overdue=2",
        "?limit=101",
      ]) {
        expect((await list(supervisor, ORG_A, qs)).statusCode, qs).toBe(422);
      }
    });
  });

  describe("scope: what the viewer cannot open is withheld, not hidden", () => {
    it("lists a request in a channel the supervisor is not a member of as a restricted row with no ids", async () => {
      const out = body(await list(supervisor, ORG_A));
      const restricted = out.items.filter((i) => i.restricted);
      expect(restricted.length).toBeGreaterThanOrEqual(2); // pending_restricted and to_fail
      for (const r of restricted) {
        expect(r).toMatchObject({
          id: null,
          channel_id: null,
          message_id: null,
          patient_id: null,
          assigned_user_id: null,
        });
        expect(r.assigned_display_name).toEqual(expect.any(String)); // chase-able
        // ADR-0078: the sender's name and the supervisor handle stay on a restricted row.
        expect(r.requester_display_name).toEqual(expect.any(String));
        expect([ids.pending_restricted, ids.to_fail]).toContain(r.request_ref);
      }
      const wire = JSON.stringify(out);
      for (const secret of [otherChannel, PATIENT_2, SECRET]) {
        expect(wire).not.toContain(secret as string);
      }
      // The request id appears only as the opaque `request_ref`, never as `id`.
      for (const id of [ids.pending_restricted, ids.to_fail]) {
        expect(wire).not.toContain(`"id":"${id}"`);
      }
    });

    it("turns every row restricted when the Part 2 gate denies the supervisor, and still lists and counts all of them", async () => {
      part2Denied = true;
      try {
        const out = body(await list(supervisor, ORG_A, "?limit=100"));
        expect(out.items.every((i) => i.restricted)).toBe(true);
        expect(out.items.length).toBe(out.counts.unfiltered);
        expect(JSON.stringify(out)).not.toContain(PATIENT_1);
        expect(JSON.stringify(out)).not.toContain(memberChannel);
      } finally {
        part2Denied = false;
      }
    });

    it("a supervisor who has since left the channel stops getting its ids but the request stays listed", async () => {
      await kit.admin.query(
        "UPDATE channel_member SET removed_at=now() WHERE channel_id=$1 AND user_id=$2",
        [memberChannel, supervisor],
      );
      try {
        const out = body(await list(supervisor, ORG_A, "?limit=100"));
        expect(out.items.filter((i) => !i.restricted)).toEqual([]);
        expect(out.items.length).toBe(out.counts.unfiltered);
      } finally {
        await kit.admin.query(
          "UPDATE channel_member SET removed_at=NULL WHERE channel_id=$1 AND user_id=$2",
          [memberChannel, supervisor],
        );
      }
    });
  });

  describe("access", () => {
    it("is 401 without a session and 403 for a clinician who lacks messaging.review (no data in either answer)", async () => {
      expect((await app.inject({ method: "GET", url: URL_OF })).statusCode).toBe(401);
      const denied = await list(plainClinician, ORG_A);
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain(ids.pending_visible as string);
      // the nurse who WROTE the requests is not a supervisor either: she keeps the per-channel read she always had.
      expect((await list(nurse, ORG_A)).statusCode).toBe(403);
    });
  });

  describe("what the read discloses and what it changes", () => {
    it("carries no message text and no patient name; ids and enums only", async () => {
      const res = await list(supervisor, ORG_A, "?limit=100");
      expect(res.body).not.toContain(SECRET);
      expect(res.body).not.toMatch(/okafor|morphine|mrn/i);
      const visible = body(res).items.find((i) => !i.restricted) as AckQueueItemDto;
      expect(visible).toMatchObject({ channel_id: memberChannel, patient_id: PATIENT_1 });
      // ADR-0081 follow-on: the addressed role is a closed enum on an open row and (a non-patient attribute) on a restricted one.
      expect(visible.addressed_role).toBe("rn");
      const hidden = body(res).items.find((i) => i.request_ref === ids.pending_restricted);
      expect(hidden).toMatchObject({ restricted: true, addressed_role: "physician" });
      expect(Object.keys(visible).sort()).toEqual(
        [
          "ack_class",
          "addressed_role",
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
          "request_ref",
          "requested_at",
          "requester_display_name",
          "restricted",
          "status",
        ].sort(),
      );
    });

    it("writes nothing: no request row, event or outbox row changes", async () => {
      const snap = async () => [
        await kit.count("SELECT count(*)::int AS n FROM message_acknowledgment_event"),
        await kit.count("SELECT count(*)::int AS n FROM outbox_event"),
        await kit.count(
          "SELECT coalesce(sum(version),0)::int AS n FROM message_acknowledgment_request",
        ),
        await kit.count(
          "SELECT count(*)::int AS n FROM message_acknowledgment_request WHERE status IN ('acknowledged','resolved')",
        ),
      ];
      const before = await snap();
      await list(supervisor, ORG_A, "?limit=100");
      await walk(supervisor, ORG_A, 2);
      expect(await snap()).toEqual(before);
    });

    it("a page with two visible patients writes exactly one audit row per patient, both against the single audit_request_id", async () => {
      const PATIENT_3 = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a49a3";
      const third = await mkChannel(kit, "care_team", PATIENT_3, [nurse, rn, supervisor]);
      const extra = await born("second_visible_patient", third, PATIENT_3, { minutes: 30 });
      try {
        const before = await audit(supervisor);
        const out = body(await list(supervisor, ORG_A, "?limit=100"));
        const patients = new Set(out.items.map((i) => i.patient_id).filter(Boolean));
        expect(patients).toEqual(new Set([PATIENT_1, PATIENT_3]));
        expect(await audit(supervisor)).toBe(before + 2);
        // the two newest rows of this actor are this read's: one per patient, each against the one request id the response names.
        const rows = await kit.one<{ resource_id: string }>(
          `SELECT resource_id FROM audit_event WHERE actor_user_id=$1 AND event_type='message_acknowledgment_request.viewed'
            ORDER BY created_at DESC LIMIT 2`,
          [supervisor],
        );
        expect(rows.map((r) => r.resource_id)).toEqual([
          out.audit_request_id,
          out.audit_request_id,
        ]);
        expect(rows.length).toBe(2);
      } finally {
        await acknowledge(extra);
      }
    });

    it("lands one read-audit row per distinct patient disclosed, against the first item's id; a refusal and an all-restricted page land none", async () => {
      const before = await audit(supervisor);
      const res = await list(supervisor, ORG_A, "?limit=100");
      const out = body(res);
      const patients = new Set(out.items.map((i) => i.patient_id).filter(Boolean));
      const rows = await kit.one<{
        event_type: string;
        resource_kind: string;
        resource_id: string;
      }>(
        `SELECT event_type, resource_kind, resource_id FROM audit_event
          WHERE actor_user_id=$1 AND event_type LIKE 'message_acknowledgment_request.%' AND resource_id=$2`,
        [supervisor, out.audit_request_id],
      );
      expect(patients.size).toBe(1);
      expect(await audit(supervisor)).toBe(before + patients.size);
      expect(rows[0]).toMatchObject({
        event_type: "message_acknowledgment_request.viewed",
        resource_kind: "message_acknowledgment_request",
      });
      expect(rows[0]?.resource_id).toBe(out.audit_request_id);
      expect(out.audit_request_id).toBe(out.items.find((i) => !i.restricted)?.id);

      const afterRead = await audit(supervisor);
      part2Denied = true;
      try {
        expect((await list(supervisor, ORG_A, "?limit=100")).statusCode).toBe(200);
      } finally {
        part2Denied = false;
      }
      expect((await list(plainClinician, ORG_A)).statusCode).toBe(403);
      expect(await audit(supervisor)).toBe(afterRead);
      expect(await audit(plainClinician)).toBe(0);
    });
  });

  describe("the status predicate uses the partial index under a generic plan", () => {
    it("plans the queue's order and predicate on message_ack_request_open_deadline_idx with a bound organisation", async () => {
      await kit.admin.query("BEGIN");
      try {
        await kit.admin.query("SET LOCAL plan_cache_mode = force_generic_plan");
        await kit.admin.query("SET LOCAL enable_seqscan = off");
        await kit.admin.query("SET LOCAL enable_bitmapscan = off");
        // The reader's REAL page statement (built by the same function it runs), prepared with untyped parameters.
        const built = queueRowsQuery(
          kit.handle.db,
          queueFilters(ORG_A, { status: null, overdueOnly: false, now: new Date() }),
          null,
          50,
        ).toSQL();
        await kit.admin.query(`PREPARE q AS ${built.sql}`);
        const args = built.params.map((_, i) => `$${i + 1}`);
        expect(args.length).toBeGreaterThan(0);
        const literal = (v: unknown) =>
          `'${String(v instanceof Date ? v.toISOString() : v).replace(/'/g, "''")}'`;
        const plan = (
          await kit.admin.query(`EXPLAIN EXECUTE q(${built.params.map(literal).join(", ")})`)
        ).rows
          .map((r) => r["QUERY PLAN"] as string)
          .join("\n");
        expect(plan).toContain("message_ack_request_open_deadline_idx");
      } finally {
        await kit.admin.query("ROLLBACK");
      }
    });
  });

  describe("a restricted request that is the OLDEST must not blind the audit trail", () => {
    it("still records the read against the first request shown in full when the first row is restricted", async () => {
      const early = await born("early_restricted", otherChannel, PATIENT_2, { minutes: 1 });
      try {
        const before = await audit(supervisor);
        const out = body(await list(supervisor, ORG_A, "?limit=100"));
        expect(out.items[0]).toMatchObject({ restricted: true, id: null });
        expect(out.audit_request_id).not.toBeNull();
        expect(await audit(supervisor)).toBe(before + 1);
      } finally {
        await acknowledge(early);
      }
    });
  });

  describe("ops numbers (the gauges and the notice read these)", () => {
    it("counts overdue, failed and the oldest overdue per organisation under RLS, and the acknowledgment latency", async () => {
      const read = createDbAckQueueStatsReader(kit.handle.db);
      const later = new Date(Date.now() + 3 * HOUR_MS);
      const a = await read(ORG_A, later);
      expect(a.overdue).toBeGreaterThanOrEqual(7);
      expect(a.failedUnreachable).toBe(1);
      expect(a.oldestOverdueSeconds).toBeGreaterThan(60 * 60);
      expect(a.ackedCount).toBe(5); // acknowledged, resolved, late_arrival, early_restricted, second_visible_patient: all acknowledged within the window
      expect(a.ackLatencySumSeconds).toBeGreaterThanOrEqual(0);
      const b = await read(ORG_B, later);
      expect(b).toMatchObject({ overdue: 1, failedUnreachable: 0, ackedCount: 0 });
      const now = await read(ORG_A, new Date());
      expect(now.overdue).toBe(0);
      expect(now.oldestOverdueSeconds).toBe(0);
    });

    it("reads nothing when the organisation does not exist (zeros, never another tenant's numbers)", async () => {
      const ghost = await createDbAckQueueStatsReader(kit.handle.db)(
        randomUUID(),
        new Date(Date.now() + 3 * HOUR_MS),
      );
      expect(ghost).toMatchObject({ overdue: 0, failedUnreachable: 0, ackedCount: 0 });
    });
  });
});
