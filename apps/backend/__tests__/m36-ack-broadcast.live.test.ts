/**
 * M36 WP 6.8 (ADR-0097) - acknowledge-required broadcast, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * The real route stack (Authorization Contract, the real flag path, the DB service, the guard triggers of migration 1200).
 *
 *   1. FLAG        off (and absent) is a uniform 404 for a permitted user, even for a malformed request; nothing is written.
 *   2. CREATE      only the AUTHOR of a live announcement may require acknowledgment; the audience is every active member but the author;
 *                  a repeat is 200 and does not touch the frozen audience.
 *   3. NOT BY OPEN opening (read receipt) never acknowledges; only the explicit POST does; idempotent, original instant stands.
 *   4. CREATOR     only the broadcast creator (not any other messaging.announce holder) reads detail/list; sees EVERY non-acknowledger (opened or not), exact counts, paged; acknowledged people leave the pending list.
 *   5. INELIGIBLE  an offboarded recipient is listed as ineligible, not as a silent non-reader; a later joiner is counted outside the audience.
 *   6. NO PROXY    the author and a non-audience member get the uniform 404 on acknowledge; a user id in the body is ignored; the database
 *                  refuses a forged recipient write (someone else's row, a withdrawn or re-stamped acknowledgment, a delete).
 *   7. ACCESS      401 / 403 without the permission; tenancy: org B sees nothing of org A.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:ack-broadcast:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { createAckBroadcastService } from "../src/modules/36-messaging/ack-broadcast/ack-broadcast-service";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { type LiveKit, as, bootLiveKit, headerAuth } from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a680001";
const ORG_B = "22222222-2222-4222-8222-22220a680002";
const FLAG = "messaging.ack_broadcast";
const READ_KEYS = ["messaging.read", "messaging.send"];
const ANNOUNCE_KEYS = [...READ_KEYS, "messaging.announce"];

describe.skipIf(!DB_URL)("M36 WP 6.8 acknowledge-required broadcast - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  const flags: Record<string, boolean> = { [FLAG]: true };
  let author: string;
  let supervisor: string;
  let alice: string;
  let bob: string;
  let carol: string;
  let dave: string;
  let noKeys: string;
  let userB: string;
  let channel: string;
  let messageId: string;

  const url = (id: string, tail: string) => `/api/v1/messaging/announcements/${id}/${tail}`;
  const call = (method: "GET" | "POST", path: string, user: string | null, org = ORG_A, payload?: unknown) =>
    app.inject({
      method,
      url: path,
      headers: user ? as(user, org) : {},
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  const announcement = async (by: string): Promise<string> => {
    const sent = await kit.service.sendMessage(ORG_A, {
      channelId: channel,
      authorUserId: by,
      body: "Office closed Friday for weather",
    });
    return sent.messageId;
  };
  const detail = async (id: string, qs = "") =>
    (await call("GET", `${url(id, "ack-broadcast")}${qs}`, author)).json();

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp68");
    author = await kit.seedUser("author", ORG_A, ANNOUNCE_KEYS);
    supervisor = await kit.seedUser("supervisor", ORG_A, ANNOUNCE_KEYS);
    alice = await kit.seedUser("alice", ORG_A, READ_KEYS);
    bob = await kit.seedUser("bob", ORG_A, READ_KEYS);
    carol = await kit.seedUser("carol", ORG_A, READ_KEYS);
    noKeys = await kit.seedUser("nokeys", ORG_A, []);
    userB = await kit.seedUser("userb", ORG_B, ANNOUNCE_KEYS);
    channel = (
      await kit.one<{ id: string }>(
        `INSERT INTO channel (organization_id, channel_kind, title, retention_class)
         VALUES ($1,'announcement','Announcements','operational') RETURNING id`,
        [ORG_A],
      )
    )[0]!.id;

    app = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(kit.handle.db),
    });
    const { tasks, handoffs } = kit.build(true);
    registerMessagingRoutes(app, {
      service: kit.service,
      announcements: createDbAnnouncementService(kit.handle.db),
      tasks,
      handoffs,
      ackBroadcast: {
        service: createAckBroadcastService({
          db: kit.handle.db,
          flags: { forOrg: async () => flags },
        }),
      },
    });
    await app.ready();
    messageId = await announcement(author);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await kit?.close();
  });

  it("flag off or absent is a uniform 404 for a permitted user, before the request is parsed, and writes nothing", async () => {
    flags[FLAG] = false;
    try {
      const create = await call("POST", url(messageId, "ack-broadcast"), author);
      const malformed = await call("POST", url("not-a-uuid", "ack-broadcast"), author);
      const badQuery = await call("GET", `${url(messageId, "ack-broadcast")}?limit=-9&filter=zz`, supervisor);
      const mine = await call("GET", "/api/v1/messaging/ack-broadcasts/mine", alice);
      const ack = await call("POST", url(messageId, "ack"), alice);
      for (const res of [create, malformed, badQuery, mine, ack]) expect(res.statusCode).toBe(404);
      const shape = (r: { json(): { error: Record<string, unknown> } }) => ({ ...r.json().error, correlationId: 0 });
      expect(shape(malformed)).toEqual(shape(create));
      expect(await kit.count(`SELECT count(*)::int AS n FROM message_ack_broadcast`)).toBe(0);
      delete flags[FLAG];
      expect((await call("POST", url(messageId, "ack-broadcast"), author)).statusCode).toBe(404);
    } finally {
      flags[FLAG] = true;
    }
  });

  it("access: 401 without a session, 403 without the permission", async () => {
    expect((await call("POST", url(messageId, "ack-broadcast"), null)).statusCode).toBe(401);
    expect((await call("POST", url(messageId, "ack-broadcast"), alice)).statusCode).toBe(403);
    expect((await call("GET", url(messageId, "ack-broadcast"), alice)).statusCode).toBe(403);
    expect((await call("GET", "/api/v1/messaging/ack-broadcasts", alice)).statusCode).toBe(403);
    expect((await call("POST", url(messageId, "ack"), noKeys)).statusCode).toBe(403);
  });

  it("only the AUTHOR of a live announcement can require acknowledgment (one 404 for every other case)", async () => {
    const others = await announcement(supervisor);
    expect((await call("POST", url(others, "ack-broadcast"), author)).statusCode).toBe(404);
    expect((await call("POST", url(randomUUID(), "ack-broadcast"), author)).statusCode).toBe(404);
    expect(await kit.count(`SELECT count(*)::int AS n FROM message_ack_broadcast`)).toBe(0);
  });

  it("creates a frozen audience of every active member but the author; a repeat does not touch it", async () => {
    const first = await call("POST", url(messageId, "ack-broadcast"), author);
    expect(first.statusCode).toBe(201);
    // author, supervisor, alice, bob, carol, noKeys are in org A: 5 recipients (everyone but the author)
    expect(first.json().counts).toMatchObject({ audience: 5, acknowledged: 0, pending: 5, ineligible: 0, outsideAudience: 0 });
    dave = await kit.seedUser("dave", ORG_A, READ_KEYS); // joins AFTER publish
    const again = await call("POST", url(messageId, "ack-broadcast"), author);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false });
    expect(again.json().counts).toMatchObject({ audience: 5, outsideAudience: 1 });
    expect(
      await kit.count(
        `SELECT count(*)::int AS n FROM message_ack_broadcast_recipient WHERE user_id=$1`,
        [author],
      ),
    ).toBe(0);
  });

  it("opening never acknowledges: a read receipt moves the person to 'opened', still pending", async () => {
    const read = await call("POST", `/api/v1/messaging/messages/${messageId}/read`, alice);
    expect(read.statusCode).toBeLessThan(300);
    expect(
      await kit.count(
        `SELECT count(*)::int AS n FROM message_receipt WHERE message_id=$1 AND user_id=$2 AND status='read'`,
        [messageId, alice],
      ),
    ).toBe(1);
    expect(
      await kit.count(
        `SELECT count(*)::int AS n FROM message_ack_broadcast_recipient WHERE user_id=$1 AND acknowledged_at IS NOT NULL`,
        [alice],
      ),
    ).toBe(0);
    const body = await detail(messageId);
    expect(body.counts).toMatchObject({ acknowledged: 0, pending: 5, opened: 1, notOpened: 4 });
    expect(body.people.find((p: { userId: string }) => p.userId === alice).state).toBe("opened");
  });

  it("an explicit acknowledgment is per person, idempotent, on the database clock, and leaves the pending list", async () => {
    const first = await call("POST", url(messageId, "ack"), alice, ORG_A, { userId: bob });
    expect(first.statusCode).toBe(200);
    expect(first.json().already).toBe(false);
    const second = await call("POST", url(messageId, "ack"), alice);
    expect(second.json()).toMatchObject({ already: true, acknowledgedAt: first.json().acknowledgedAt });
    // the body's userId was ignored: bob did not acknowledge
    expect(
      await kit.count(
        `SELECT count(*)::int AS n FROM message_ack_broadcast_recipient WHERE user_id=$1 AND acknowledged_at IS NOT NULL`,
        [bob],
      ),
    ).toBe(0);
    const stamp = await kit.one<{ same: boolean }>(
      `SELECT (acknowledged_at BETWEEN now() - interval '1 minute' AND now()) AS same
         FROM message_ack_broadcast_recipient WHERE user_id=$1`,
      [alice],
    );
    expect(stamp[0]?.same).toBe(true);
    const pending = await detail(messageId, "?filter=pending");
    expect(pending.counts).toMatchObject({ acknowledged: 1, pending: 4 });
    expect(pending.people.map((p: { userId: string }) => p.userId)).not.toContain(alice);
    expect(pending.people.map((p: { userId: string }) => p.userId).sort()).toEqual(
      [supervisor, bob, carol, noKeys].sort(),
    );
    const mine = (await call("GET", "/api/v1/messaging/ack-broadcasts/mine", alice)).json();
    expect(mine.items[0]).toMatchObject({ messageId, acknowledgedAt: first.json().acknowledgedAt });
    expect((await call("GET", "/api/v1/messaging/ack-broadcasts/mine", bob)).json().items[0].acknowledgedAt).toBeNull();
  });

  it("the author and a non-audience member cannot acknowledge (the uniform 404); the database refuses a forged write", async () => {
    expect((await call("POST", url(messageId, "ack"), author)).statusCode).toBe(404);
    expect((await call("POST", url(messageId, "ack"), dave)).statusCode).toBe(404); // joined later
    expect((await call("POST", url(randomUUID(), "ack"), alice)).statusCode).toBe(404);
    expect((await call("POST", url(messageId, "ack"), userB, ORG_B)).statusCode).toBe(404);
    // As chartwarden_app with bob's identity: another person's row, withdrawing, re-stamping, deleting, forging an audience row.
    const app1 = kit.appConn;
    const asUser = async (user: string, sqlText: string) => {
      await app1.query("BEGIN");
      try {
        await app1.query(`SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`, [ORG_A, user]);
        return await app1.query(sqlText);
      } finally {
        await app1.query("ROLLBACK");
      }
    };
    await expect(
      asUser(bob, `UPDATE message_ack_broadcast_recipient SET acknowledged_at = now() WHERE user_id = '${carol}'`),
    ).rejects.toThrow(/message_ack_broadcast_recipient_self/);
    await expect(
      asUser(alice, `UPDATE message_ack_broadcast_recipient SET acknowledged_at = NULL WHERE user_id = '${alice}'`),
    ).rejects.toThrow(/once/);
    await expect(
      asUser(alice, `UPDATE message_ack_broadcast_recipient SET acknowledged_at = now() WHERE user_id = '${alice}'`),
    ).rejects.toThrow(/once/);
    await expect(asUser(alice, `DELETE FROM message_ack_broadcast_recipient`)).rejects.toThrow(/permission denied/);
    await expect(asUser(alice, `UPDATE message_ack_broadcast SET created_by = '${alice}'`)).rejects.toThrow(/permission denied/);
    await expect(
      asUser(
        alice,
        `INSERT INTO message_ack_broadcast_recipient (organization_id, broadcast_id, user_id)
         SELECT organization_id, id, '${dave}' FROM message_ack_broadcast`,
      ),
    ).rejects.toThrow(/audience/);
    await expect(
      asUser(
        alice,
        `INSERT INTO message_ack_broadcast (organization_id, message_id, channel_id, created_by)
         VALUES ('${ORG_A}', '${messageId}', '${channel}', '${alice}')`,
      ),
    ).rejects.toThrow(/message_ack_broadcast/);
  });

  it("an offboarded recipient is listed as ineligible, never as a silent non-reader; a later joiner is outside the audience", async () => {
    await kit.admin.query(`UPDATE membership SET status='suspended' WHERE user_id=$1`, [carol]);
    const body = await detail(messageId, "?filter=all");
    expect(body.people.find((p: { userId: string }) => p.userId === carol).state).toBe("ineligible");
    expect(body.counts).toMatchObject({ ineligible: 1, pending: 3, acknowledged: 1, audience: 5, outsideAudience: 1 });
    const pending = await detail(messageId, "?filter=pending");
    expect(pending.people.map((p: { userId: string }) => p.userId)).not.toContain(carol);
    const ineligible = await detail(messageId, "?filter=ineligible");
    expect(ineligible.people.map((p: { userId: string }) => p.userId)).toEqual([carol]);
    expect((await call("POST", url(messageId, "ack"), carol)).statusCode).toBe(404);
  });

  it("paging is exact: every non-acknowledger is reachable, none is cut", async () => {
    const seen: string[] = [];
    for (let offset = 0; ; offset += 2) {
      const page = await detail(messageId, `?filter=all&limit=2&offset=${offset}`);
      seen.push(...page.people.map((p: { userId: string }) => p.userId));
      if (!page.hasMore) break;
    }
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
  });

  it("tenancy: org B sees nothing of org A's broadcast, by id or by list", async () => {
    expect((await call("GET", url(messageId, "ack-broadcast"), userB, ORG_B)).statusCode).toBe(404);
    expect((await call("GET", "/api/v1/messaging/ack-broadcasts", userB, ORG_B)).json().broadcasts).toEqual([]);
    const list = (await call("GET", "/api/v1/messaging/ack-broadcasts", author)).json();
    expect(list.broadcasts).toHaveLength(1);
    // RLS as chartwarden_app: with org B's GUC, org A's rows are invisible.
    await kit.appConn.query("BEGIN");
    await kit.appConn.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_B]);
    const seen = await kit.appConn.query(`SELECT (SELECT count(*) FROM message_ack_broadcast)::int AS a, (SELECT count(*) FROM message_ack_broadcast_recipient)::int AS b`);
    await kit.appConn.query("ROLLBACK");
    expect(seen.rows[0]).toEqual({ a: 0, b: 0 });
  });

  it("another messaging.announce holder gets the uniform 404 on detail and an empty list (creator-only)", async () => {
    const stranger = await call("GET", url(messageId, "ack-broadcast"), supervisor);
    const unknown = await call("GET", url(randomUUID(), "ack-broadcast"), supervisor);
    expect(stranger.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    const shape = (r: { json(): { error: Record<string, unknown> } }) => ({ ...r.json().error, correlationId: 0 });
    expect(shape(stranger)).toEqual(shape(unknown));
    expect((await call("GET", "/api/v1/messaging/ack-broadcasts", supervisor)).json().broadcasts).toEqual([]);
  });

  it("list counts for several broadcasts are exact and per broadcast (one aggregate)", async () => {
    const second = await announcement(author);
    expect((await call("POST", url(second, "ack-broadcast"), author)).statusCode).toBe(201);
    expect((await call("POST", url(second, "ack"), bob)).statusCode).toBe(200);
    const list = (await call("GET", "/api/v1/messaging/ack-broadcasts", author)).json().broadcasts;
    const by = (id: string) => list.find((b: { messageId: string }) => b.messageId === id).counts;
    expect(by(second)).toMatchObject({ audience: 5, acknowledged: 1, pending: 4, outsideAudience: 0 });
    const first = await detail(messageId);
    expect(by(messageId)).toEqual(first.counts);
  });

  it("a soft-deleted announcement leaves mine, cannot be acknowledged, and its detail is a 404", async () => {
    const gone = await announcement(author);
    expect((await call("POST", url(gone, "ack-broadcast"), author)).statusCode).toBe(201);
    const before = (await call("GET", "/api/v1/messaging/ack-broadcasts/mine", bob)).json().items;
    expect(before.map((i: { messageId: string }) => i.messageId)).toContain(gone);
    await kit.admin.query(`UPDATE message SET status='deleted', deleted_at = now() WHERE id = $1`, [gone]);
    const after = (await call("GET", "/api/v1/messaging/ack-broadcasts/mine", bob)).json().items;
    expect(after.map((i: { messageId: string }) => i.messageId)).not.toContain(gone);
    expect((await call("POST", url(gone, "ack"), bob)).statusCode).toBe(404);
    expect((await call("GET", url(gone, "ack-broadcast"), author)).statusCode).toBe(404);
  });

  it("the audit trail carries ids and instants only", async () => {
    const rows = await kit.one<{ after: unknown }>(
      `SELECT after FROM audit_event WHERE resource_kind IN ('message_ack_broadcast','message_ack_broadcast_recipient')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/weather|Office closed|@x\.test/);
  });
});

// ---- Wave 4 follow-ups: deadline (ADR-0097 D13) and withdrawal (D12), migration 1202 ----
describe.skipIf(!DB_URL)("M36 WP 6.8 withdraw and deadline - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  const flags: Record<string, boolean> = { [FLAG]: true };
  let author: string;
  let other: string;
  let alice: string;
  let bob: string;
  let channel: string;

  const url = (id: string, tail: string) => `/api/v1/messaging/announcements/${id}/${tail}`;
  const call = (method: "GET" | "POST", path: string, user: string | null, payload?: unknown) =>
    app.inject({
      method,
      url: path,
      headers: user ? as(user, ORG_A) : {},
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const announcement = async (by: string): Promise<string> =>
    (await kit.service.sendMessage(ORG_A, { channelId: channel, authorUserId: by, body: "Policy change" })).messageId;
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const listed = async (id: string) =>
    (await call("GET", "/api/v1/messaging/ack-broadcasts", author)).json().broadcasts.find((b: { messageId: string }) => b.messageId === id);
  const asUser = async (user: string, sqlText: string) => {
    await kit.appConn.query("BEGIN");
    try {
      await kit.appConn.query(`SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`, [ORG_A, user]);
      return await kit.appConn.query(sqlText);
    } finally {
      await kit.appConn.query("ROLLBACK");
    }
  };

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp68w");
    author = await kit.seedUser("author", ORG_A, ANNOUNCE_KEYS);
    other = await kit.seedUser("other", ORG_A, ANNOUNCE_KEYS);
    alice = await kit.seedUser("alice", ORG_A, READ_KEYS);
    bob = await kit.seedUser("bob", ORG_A, READ_KEYS);
    channel = (
      await kit.one<{ id: string }>(
        `INSERT INTO channel (organization_id, channel_kind, title, retention_class)
         VALUES ($1,'announcement','Announcements','operational') RETURNING id`,
        [ORG_A],
      )
    )[0]!.id;
    app = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(kit.handle.db),
    });
    const { tasks, handoffs } = kit.build(true);
    registerMessagingRoutes(app, {
      service: kit.service,
      announcements: createDbAnnouncementService(kit.handle.db),
      tasks,
      handoffs,
      ackBroadcast: { service: createAckBroadcastService({ db: kit.handle.db, flags: { forOrg: async () => flags } }) },
    });
    await app.ready();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await kit?.close();
  });

  it("a deadline set at creation is shown to the author and the recipients; a bad one is a typed 422 and writes nothing", async () => {
    const id = await announcement(author);
    for (const deadlineAt of ["soon", inHours(-1), inHours(24 * 91)]) {
      const bad = await call("POST", url(id, "ack-broadcast"), author, { deadlineAt });
      expect(bad.statusCode).toBe(422);
      expect(bad.json().error.code).toBe("ACK_BROADCAST_DEADLINE_INVALID");
    }
    expect((await call("POST", url(id, "ack-broadcast"), author, { deadlineAt: inHours(24), extra: 1 })).statusCode).toBe(422);
    expect(await kit.count(`SELECT count(*)::int AS n FROM message_ack_broadcast WHERE message_id=$1`, [id])).toBe(0);
    const deadlineAt = inHours(24);
    const ok = await call("POST", url(id, "ack-broadcast"), author, { deadlineAt });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ withdrawnAt: null, pastDeadline: false });
    expect(new Date(ok.json().deadlineAt).getTime()).toBe(new Date(deadlineAt).getTime());
    const mine = (await call("GET", "/api/v1/messaging/ack-broadcasts/mine", alice)).json().items;
    expect(mine.find((i: { messageId: string }) => i.messageId === id).deadlineAt).toBe(ok.json().deadlineAt);
    // A repeat never edits the broadcast: the deadline stands.
    const again = await call("POST", url(id, "ack-broadcast"), author, { deadlineAt: inHours(48) });
    expect(again.json()).toMatchObject({ created: false, deadlineAt: ok.json().deadlineAt });
  });

  it("past the deadline is a marker on the author's list only; late acknowledgments are still taken and clear it", async () => {
    const id = await announcement(author);
    expect((await call("POST", url(id, "ack-broadcast"), author, { deadlineAt: inHours(1) })).statusCode).toBe(201);
    await kit.admin.query(`ALTER TABLE message_ack_broadcast DISABLE TRIGGER trg_message_ack_broadcast_guard`);
    try {
      await kit.admin.query(`UPDATE message_ack_broadcast SET deadline_at = created_at + interval '1 millisecond' WHERE message_id=$1`, [id]);
    } finally {
      await kit.admin.query(`ALTER TABLE message_ack_broadcast ENABLE TRIGGER trg_message_ack_broadcast_guard`);
    }
    expect((await listed(id)).pastDeadline).toBe(true);
    for (const u of [alice, bob, other]) expect((await call("POST", url(id, "ack"), u)).statusCode).toBe(200);
    expect((await listed(id)).pastDeadline).toBe(false);
  });

  it("withdraw: only the creator; flag-first; idempotent on the database clock; recorded acknowledgments are kept", async () => {
    const id = await announcement(author);
    expect((await call("POST", url(id, "ack-broadcast"), author)).statusCode).toBe(201);
    expect((await call("POST", url(id, "ack"), alice)).statusCode).toBe(200);
    const withdrawUrl = url(id, "ack-broadcast/withdraw");
    expect((await call("POST", withdrawUrl, null)).statusCode).toBe(401);
    expect((await call("POST", withdrawUrl, alice)).statusCode).toBe(403);
    const stranger = await call("POST", withdrawUrl, other);
    const unknown = await call("POST", url(randomUUID(), "ack-broadcast/withdraw"), other);
    expect([stranger.statusCode, unknown.statusCode]).toEqual([404, 404]);
    flags[FLAG] = false;
    try {
      expect((await call("POST", url("not-a-uuid", "ack-broadcast/withdraw"), author)).statusCode).toBe(404);
    } finally {
      flags[FLAG] = true;
    }
    expect((await listed(id)).withdrawnAt).toBeNull();

    const first = await call("POST", withdrawUrl, author, { userId: other });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ already: false, pastDeadline: false });
    expect(first.json().withdrawnAt).toEqual(expect.any(String));
    const stamp = await kit.one<{ ok: boolean }>(
      `SELECT (withdrawn_at BETWEEN now() - interval '1 minute' AND now()) AS ok FROM message_ack_broadcast WHERE message_id=$1`,
      [id],
    );
    expect(stamp[0]?.ok).toBe(true);
    const second = await call("POST", withdrawUrl, author);
    expect(second.json()).toMatchObject({ already: true, withdrawnAt: first.json().withdrawnAt });
    // A retry by someone who already acknowledged is still an idempotent success after the withdrawal.
    const retry = await call("POST", url(id, "ack"), alice);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ already: true, acknowledgedAt: expect.any(String) });

    for (const u of [alice, bob]) {
      const items = (await call("GET", "/api/v1/messaging/ack-broadcasts/mine", u)).json().items;
      expect(items.map((i: { messageId: string }) => i.messageId)).not.toContain(id);
    }
    expect((await call("POST", url(id, "ack"), bob)).statusCode).toBe(404);
    const row = await listed(id);
    expect(row.withdrawnAt).toBe(first.json().withdrawnAt);
    expect(row.counts).toMatchObject({ acknowledged: 1 });
    const detail = (await call("GET", url(id, "ack-broadcast"), author)).json();
    expect(detail.withdrawnAt).toBe(first.json().withdrawnAt);
    expect(detail.counts.acknowledged).toBe(1);
    const revive = await call("POST", url(id, "ack-broadcast"), author);
    expect(revive.json()).toMatchObject({ created: false, withdrawnAt: first.json().withdrawnAt });
    expect(
      await kit.count(
        `SELECT count(*)::int AS n FROM message_ack_broadcast_recipient r JOIN message_ack_broadcast b ON b.id=r.broadcast_id WHERE b.message_id=$1`,
        [id],
      ),
    ).toBe(3);
  });

  it("the database itself refuses: a non-creator or repeated withdrawal, an edited broadcast, a past deadline, a born-withdrawn insert, an ack after withdrawal", async () => {
    const id = await announcement(author);
    expect((await call("POST", url(id, "ack-broadcast"), author)).statusCode).toBe(201);
    const bc = `message_id = '${id}'`;
    await expect(asUser(other, `UPDATE message_ack_broadcast SET withdrawn_at = now() WHERE ${bc}`)).rejects.toThrow(/withdraw_actor/);
    await expect(asUser(author, `UPDATE message_ack_broadcast SET deadline_at = now() + interval '1 day' WHERE ${bc}`)).rejects.toThrow(/permission denied/);
    await expect(asUser(author, `UPDATE message_ack_broadcast SET withdrawn_at = NULL WHERE ${bc}`)).rejects.toThrow(/withdraw_once/);
    await expect(asUser(author, `DELETE FROM message_ack_broadcast WHERE ${bc}`)).rejects.toThrow(/permission denied/);
    const fresh = await announcement(author);
    await expect(
      asUser(author, `INSERT INTO message_ack_broadcast (organization_id, message_id, channel_id, created_by, deadline_at) VALUES ('${ORG_A}','${fresh}','${channel}','${author}', now() - interval '1 hour')`),
    ).rejects.toThrow(/deadline/);
    await expect(
      asUser(author, `INSERT INTO message_ack_broadcast (organization_id, message_id, channel_id, created_by, withdrawn_at) VALUES ('${ORG_A}','${fresh}','${channel}','${author}', now())`),
    ).rejects.toThrow(/born_open/);
    expect((await call("POST", url(id, "ack-broadcast/withdraw"), author)).statusCode).toBe(200);
    await expect(
      asUser(
        alice,
        `UPDATE message_ack_broadcast_recipient SET acknowledged_at = now()
          WHERE user_id = '${alice}' AND broadcast_id = (SELECT id FROM message_ack_broadcast WHERE ${bc})`,
      ),
    ).rejects.toThrow(/recipient_withdrawn/);
    await expect(asUser(author, `UPDATE message_ack_broadcast SET withdrawn_at = now() WHERE ${bc}`)).rejects.toThrow(/withdraw_once/);
  });

  it("the audit trail of a withdrawal carries ids and instants only", async () => {
    const rows = await kit.one<{ after: unknown }>(
      `SELECT after FROM audit_event WHERE resource_kind = 'message_ack_broadcast' AND event_type = 'message_ack_broadcast.update'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/Policy change|@x\.test/);
  });
});
