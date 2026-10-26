/**
 * WP 2.6 - scheduled send, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Acceptance (spec): a discharged patient (channel closed) or a revoked member -> the send is BLOCKED and the sender is
 * notified. Proves: the body is sealed at rest and private to its owner (service, raw SQL as a colleague, other tenant);
 * the window / cap / archived rules; cancel and reschedule (idempotent, owner-only); the dispatcher sends exactly once
 * (retry and concurrent ticks), through the real write core, the real catalog-validating outbox publisher and the
 * `client_message_id` backstop; every dispatch-time re-check (membership, messaging.send, archived channel, announcement
 * policy, dead parent) blocks WITHOUT sending and emits one PHI-free `m36.message.schedule_blocked` event; a row whose
 * send keeps failing is blocked after the attempt limit; audit rows carry no body; the tenant erase and a channel's
 * removal delete scheduled rows.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m36:scheduled-send:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient, schema } from "@chartwarden/db";
import {
  MESSAGING_JOB_SCHEDULES,
  MESSAGING_QUEUES,
  eraseTenantMessaging,
} from "@chartwarden/messaging";
import type { ScheduledSendService } from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { NotFoundError } from "@chartwarden/types";
import { Queue } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { BodyKeyUnavailableError } from "../src/modules/36-messaging/body-key-ring";
import { createDbDraftService } from "../src/modules/36-messaging/drafts/draft-service-db";
import { createDrizzleMessagingEraseStore } from "../src/modules/36-messaging/erasers/messaging-eraser";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import {
  type ScheduledSendDispatcher,
  createScheduledSendDispatcher,
} from "../src/modules/36-messaging/scheduled/scheduled-send-dispatcher";
import { createDbScheduledSendService } from "../src/modules/36-messaging/scheduled/scheduled-send-service-db";
import {
  registerM36ScheduledSendWorker,
  scheduleM36ScheduledSendJobs,
} from "../src/modules/36-messaging/scheduled/scheduled-send-worker";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const KEK = randomBytes(32);
const SECRET = "Mrs Quillfeather asked about the morphine titration";
const MINUTE = 60_000;
const REDIS_URL = process.env.CHARTWARDEN_TEST_REDIS_URL;
// This suite OBLITERATES the scheduled-send queue: refuse unless the Redis is local.
const REDIS_IS_LOCAL =
  !!REDIS_URL && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(REDIS_URL).hostname);

describe.skipIf(!DB_URL)("WP 2.6 - scheduled send - LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let destroyer: { db: DbClient; close: () => Promise<void> };
  let service: ScheduledSendService;
  let dispatcher: ScheduledSendDispatcher;
  let router: ReturnType<typeof createDbMessagingRouteService>;
  let cipher: ReturnType<typeof createMessageBodyCipher>;
  let orgA: string;
  let orgB: string;
  let alice: string;
  let bob: string;
  let carol: string; // org B
  let dm: string; // alice + bob
  let announcement: string;
  /** Mutable permission table the dispatcher consults (stands in for the M3 resolver). */
  const grants = new Map<string, Set<string>>();
  let failOpenFor: string | null = null;
  let failOpenAsKeyOutage = false;
  /** Per-user resolver fault injection (null = healthy). */
  let resolverFault: ((userId: string) => Error | null) | null = null;
  let erin: string; // a third sender, for outage patterns across distinct users

  async function applyMigrations() {
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
  const seedOrg = async (slug: string) =>
    (
      await admin.query(
        "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,$1,$1) RETURNING id",
        [slug],
      )
    ).rows[0].id as string;
  const seedUser = async (email: string, orgId: string) => {
    const id = (
      await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$1) RETURNING id`, [email])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, orgId],
    );
    grants.set(`${orgId}:${id}`, new Set(["messaging.read", "messaging.send"]));
    return id;
  };
  const seedAnnouncement = async (orgId: string) =>
    (
      await admin.query(
        `INSERT INTO channel (organization_id, channel_kind, title, retention_class)
         VALUES ($1,'announcement','news','operational') RETURNING id`,
        [orgId],
      )
    ).rows[0].id as string;
  const rows = async (orgId = orgA) =>
    (await admin.query("SELECT * FROM scheduled_message WHERE organization_id=$1", [orgId])).rows;
  const messagesIn = async (channelId: string) =>
    (
      await admin.query("SELECT * FROM message WHERE channel_id=$1 ORDER BY created_at", [
        channelId,
      ])
    ).rows;
  const eventsOf = async (eventType: string) =>
    (await admin.query("SELECT payload FROM outbox_event WHERE event_type=$1", [eventType])).rows;
  const wipe = async () => {
    await admin.query("DELETE FROM scheduled_message");
    await admin.query("DELETE FROM outbox_event WHERE event_type='m36.message.schedule_blocked'");
  };
  const inFuture = (ms = 10 * MINUTE) => new Date(Date.now() + ms).toISOString();
  const schedule = (
    userId: string,
    over: Partial<Parameters<ScheduledSendService["create"]>[1]> = {},
  ) =>
    service.create(orgA, {
      userId,
      channelId: dm,
      body: SECRET,
      scheduledFor: inFuture(),
      timeZone: "America/Chicago",
      ...over,
    });
  /** Make a row due (the API refuses a past time, as it should; time travel is the admin's). */
  const makeDue = (id: string) =>
    admin.query(
      "UPDATE scheduled_message SET scheduled_for = now() - interval '1 second' WHERE id=$1",
      [id],
    );
  const tick = () => dispatcher.dispatchDueForOrg(orgA);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    await applyMigrations();
    orgA = await seedOrg("wp26a");
    orgB = await seedOrg("wp26b");
    alice = await seedUser("wp26-alice@x.test", orgA);
    bob = await seedUser("wp26-bob@x.test", orgA);
    erin = await seedUser("wp26-erin@x.test", orgA);
    carol = await seedUser("wp26-carol@x.test", orgB);
    announcement = await seedAnnouncement(orgA);
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wp26_destroyer') THEN
         CREATE ROLE wp26_destroyer LOGIN PASSWORD 'wp26_destroyer_pw' IN ROLE chartwarden_destruction; END IF; END $$;`,
    );
    const destroyerUrl = new URL(DB_URL as string);
    destroyerUrl.username = "wp26_destroyer";
    destroyerUrl.password = "wp26_destroyer_pw";
    destroyer = createDbClient({ connectionString: destroyerUrl.toString() });

    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
    };
    router = createDbMessagingRouteService(handle.db, { kek: KEK, outbox: outbox as never });
    dm = (await router.openDm(orgA, alice, bob)).channelId;
    cipher = createMessageBodyCipher({ kek: KEK });
    service = createDbScheduledSendService({
      db: handle.db,
      cipher,
      maxPerUser: 3,
      canViewChannel: router.canViewChannel,
    });
    dispatcher = createScheduledSendDispatcher({
      db: handle.db,
      cipher: {
        seal: (org, text) => cipher.seal(org, text),
        sealRing: (org, text) => cipher.sealRing(org, text),
        open: async (org, bytes) => {
          if (failOpenFor && failOpenAsKeyOutage)
            throw new BodyKeyUnavailableError(new Error("simulated key outage"));
          if (failOpenFor) throw new Error("simulated unseal failure");
          return cipher.open(org, bytes);
        },
      },
      outbox,
      canViewChannel: router.canViewChannel,
      permissionsFor: async (org, user) => {
        const fault = resolverFault?.(user);
        if (fault) throw fault;
        return grants.get(`${org}:${user}`) ?? new Set<string>();
      },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await destroyer?.close();
    if (admin) await admin.end();
  });

  describe("storage and privacy", () => {
    it("seals the body at rest and returns it only to its owner", async () => {
      await wipe();
      const created = await schedule(alice);
      expect(created).toMatchObject({ status: "pending", blockedReason: null, body: SECRET });
      const [row] = await rows();
      expect(Buffer.from(row.body_cipher).toString("utf8")).not.toContain("morphine");
      expect(await service.listMine(orgA, { userId: alice })).toHaveLength(1);
      expect(await service.listMine(orgA, { userId: bob })).toHaveLength(0);
    });

    it("is invisible to a colleague (raw SQL as the colleague) and to another tenant", async () => {
      await wipe();
      await schedule(alice);
      const asBob = await withOrgContext(handle.db, { organizationId: orgA, userId: bob }, (tx) =>
        tx.select().from(schema.scheduledMessages),
      );
      expect(asBob).toHaveLength(0);
      const asCarol = await withOrgContext(
        handle.db,
        { organizationId: orgB, userId: carol },
        (tx) => tx.select().from(schema.scheduledMessages),
      );
      expect(asCarol).toHaveLength(0);
      // another tenant cannot write into org A either
      await expect(
        withOrgContext(handle.db, { organizationId: orgB, userId: carol }, (tx) =>
          tx.insert(schema.scheduledMessages).values({
            organizationId: orgA,
            channelId: dm,
            userId: alice,
            bodyCipher: Buffer.from("x"),
            scheduledFor: new Date(Date.now() + 10 * MINUTE),
          }),
        ),
      ).rejects.toThrow();
    });

    it("does not let the app role rewrite the owner or the sealed body", async () => {
      await wipe();
      const created = await schedule(alice);
      await expect(
        withOrgContext(handle.db, { organizationId: orgA, userId: alice }, (tx) =>
          tx
            .update(schema.scheduledMessages)
            .set({ userId: bob })
            .where(eq(schema.scheduledMessages.id, created.id)),
        ),
      ).rejects.toThrow();
      await expect(
        withOrgContext(handle.db, { organizationId: orgA, userId: alice }, (tx) =>
          tx
            .update(schema.scheduledMessages)
            .set({ bodyCipher: Buffer.from("tampered") })
            .where(eq(schema.scheduledMessages.id, created.id)),
        ),
      ).rejects.toThrow();
    });

    it("audits create and delete with no body or cipher", async () => {
      await wipe();
      await admin.query("DELETE FROM audit_event WHERE resource_kind='scheduled_message'");
      const created = await schedule(alice);
      await service.cancel(orgA, { userId: alice, id: created.id });
      const audit = (
        await admin.query(
          "SELECT event_type, before, after, actor_user_id FROM audit_event WHERE resource_kind='scheduled_message' ORDER BY created_at",
        )
      ).rows;
      expect(audit.map((a) => a.event_type)).toEqual([
        "scheduled_message.insert",
        "scheduled_message.delete",
      ]);
      expect(audit[0].actor_user_id).toBe(alice);
      expect(JSON.stringify(audit)).not.toContain("morphine");
      expect(audit[0].after.body_cipher).toBe("<changed>");
    });
  });

  describe("creating", () => {
    it("enforces the window: at least one minute ahead, at most 30 days", async () => {
      await wipe();
      await expect(schedule(alice, { scheduledFor: inFuture(30_000) })).rejects.toMatchObject({
        code: "SCHEDULE_TOO_SOON",
      });
      await expect(
        schedule(alice, { scheduledFor: inFuture(31 * 24 * 60 * MINUTE) }),
      ).rejects.toMatchObject({ code: "SCHEDULE_TOO_FAR" });
      expect(await rows()).toHaveLength(0);
    });

    it("refuses a blank body, an unknown channel and an archived channel", async () => {
      await wipe();
      await expect(schedule(alice, { body: "   " })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
      await expect(
        schedule(alice, { channelId: "00000000-0000-4000-8000-000000000000" }),
      ).rejects.toMatchObject({ statusCode: 404 });
      const archived = await seedAnnouncement(orgA);
      await admin.query("UPDATE channel SET is_archived=true WHERE id=$1", [archived]);
      await expect(schedule(alice, { channelId: archived })).rejects.toMatchObject({
        code: "CHANNEL_ARCHIVED",
        statusCode: 410,
      });
    });

    it("scheduling takes the sender's own draft for that slot, like a send does (Tranche C), and nothing else", async () => {
      await wipe();
      await admin.query("DELETE FROM message_draft");
      const drafts = createDbDraftService({ db: handle.db, cipher });
      const save = (userId: string, channelId: string) =>
        drafts.saveDraft(orgA, {
          userId,
          channelId,
          body: SECRET,
          deviceId: "d1",
          baseRevision: 0,
        });
      await save(alice, dm);
      await save(alice, announcement);
      await save(bob, dm);
      await schedule(alice);
      expect(await drafts.getDraft(orgA, { userId: alice, channelId: dm })).toBeNull();
      expect(
        await drafts.getDraft(orgA, { userId: alice, channelId: announcement }),
      ).not.toBeNull();
      expect(await drafts.getDraft(orgA, { userId: bob, channelId: dm })).not.toBeNull();
      await admin.query("DELETE FROM message_draft");
    });

    it("caps a user at the limit with 409 SCHEDULE_LIMIT_REACHED, also under concurrency", async () => {
      await wipe();
      const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map(() => schedule(alice)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
      const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(refused.every((r) => r.reason.code === "SCHEDULE_LIMIT_REACHED")).toBe(true);
      expect(await rows()).toHaveLength(3);
      // another user is unaffected by alice's cap
      await expect(schedule(bob)).resolves.toBeDefined();
    });

    it("a repeat with the same client message id returns the first row, not a second; another user's id is independent", async () => {
      await wipe();
      const clientMessageId = "7c1d6b0e-3f0a-4c58-9d0e-2b6f4a1e8c33";
      const first = await schedule(alice, { clientMessageId });
      const again = await schedule(alice, { clientMessageId, body: "a different body" });
      expect(again.id).toBe(first.id);
      expect(again.body).toBe(SECRET);
      expect(await rows()).toHaveLength(1);
      const bobs = await schedule(bob, { clientMessageId });
      expect(bobs.id).not.toBe(first.id);
      // concurrent repeats collapse to one row too, and a replay at the cap is not refused
      const raced = await Promise.all([1, 2, 3].map(() => schedule(alice, { clientMessageId })));
      expect(new Set(raced.map((r) => r.id))).toEqual(new Set([first.id]));
      expect(await rows()).toHaveLength(2);
    });

    it("binds a scheduled reply to a live thread root in its own channel", async () => {
      await wipe();
      const root = await router.sendMessage(orgA, {
        channelId: dm,
        authorUserId: bob,
        body: "root",
        bodyKind: "plain",
      });
      await expect(schedule(alice, { parentMessageId: root.messageId })).resolves.toMatchObject({
        parentMessageId: root.messageId,
      });
      await expect(
        schedule(alice, { parentMessageId: "00000000-0000-4000-8000-000000000000" }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("cancel and reschedule", () => {
    it("cancels before dispatch, idempotently, and never lets a colleague cancel", async () => {
      await wipe();
      const before = (await messagesIn(dm)).length;
      const created = await schedule(alice);
      expect(await service.cancel(orgA, { userId: bob, id: created.id })).toEqual({
        cancelled: false,
      });
      expect(await rows()).toHaveLength(1);
      expect(await service.cancel(orgA, { userId: alice, id: created.id })).toEqual({
        cancelled: true,
      });
      expect(await service.cancel(orgA, { userId: alice, id: created.id })).toEqual({
        cancelled: false,
      });
      await makeDue(created.id);
      expect(await tick()).toMatchObject({ sent: 0, blocked: 0 });
      expect((await messagesIn(dm)).length).toBe(before);
    });

    it("reschedules within the same window rules; a colleague gets a 404", async () => {
      await wipe();
      const created = await schedule(alice);
      const later = inFuture(2 * 60 * MINUTE);
      const moved = await service.reschedule(orgA, {
        userId: alice,
        id: created.id,
        scheduledFor: later,
      });
      expect(moved.scheduledFor).toBe(later);
      await expect(
        service.reschedule(orgA, { userId: alice, id: created.id, scheduledFor: inFuture(1000) }),
      ).rejects.toMatchObject({ code: "SCHEDULE_TOO_SOON" });
      await expect(
        service.reschedule(orgA, { userId: bob, id: created.id, scheduledFor: later }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("dispatch", () => {
    it("does nothing until the row is due", async () => {
      await wipe();
      await schedule(alice);
      expect(await tick()).toMatchObject({ sent: 0, blocked: 0 });
      expect(await rows()).toHaveLength(1);
    });

    it("sends a due message once, as the sender, through the write core, and removes the row", async () => {
      await wipe();
      const before = (await messagesIn(dm)).length;
      const created = await schedule(alice);
      await makeDue(created.id);
      expect(await tick()).toMatchObject({ sent: 1, blocked: 0, failed: 0 });
      const all = await messagesIn(dm);
      expect(all).toHaveLength(before + 1);
      const sent = all.filter((m) => m.client_message_id === created.id);
      expect(sent).toHaveLength(1);
      expect(sent[0].author_user_id).toBe(alice);
      expect(await cipher.open(orgA, sent[0].body_cipher)).toBe(SECRET);
      expect(await rows()).toHaveLength(0);
      const hints = await eventsOf("m36.message.sent");
      expect(hints.some((e) => e.payload.messageId === sent[0].id)).toBe(true);
      // the next tick finds nothing: never a second send
      expect(await tick()).toMatchObject({ sent: 0 });
      expect(await messagesIn(dm)).toHaveLength(before + 1);
    });

    it("two overlapping ticks send exactly once", async () => {
      await wipe();
      const before = (await messagesIn(dm)).length;
      const created = await schedule(alice);
      await makeDue(created.id);
      const [a, b] = await Promise.all([tick(), tick()]);
      expect(a.sent + b.sent).toBe(1);
      expect((await messagesIn(dm)).length).toBe(before + 1);
    });

    it("a crash after the send committed but before the row went away still cannot double-send", async () => {
      await wipe();
      const before = (await messagesIn(dm)).length;
      const created = await schedule(alice);
      await makeDue(created.id);
      // simulate the lost half: the message exists (same client_message_id) while the row survives
      await router.sendMessage(orgA, {
        channelId: dm,
        authorUserId: alice,
        body: SECRET,
        bodyKind: "plain",
        clientMessageId: created.id,
      });
      expect(await tick()).toMatchObject({ failed: 0 });
      expect((await messagesIn(dm)).length).toBe(before + 1);
      expect(await rows()).toHaveLength(0);
    });

    it("sends a scheduled thread reply under its root", async () => {
      await wipe();
      const root = await router.sendMessage(orgA, {
        channelId: dm,
        authorUserId: bob,
        body: "root",
        bodyKind: "plain",
      });
      const created = await schedule(alice, { parentMessageId: root.messageId });
      await makeDue(created.id);
      await tick();
      const reply = (await messagesIn(dm)).find((m) => m.client_message_id === created.id);
      expect(reply?.parent_message_id).toBe(root.messageId);
    });
  });

  describe("dispatch-time re-checks (the acceptance)", () => {
    const blockCase = async (
      arrange: () => Promise<() => Promise<void>>,
      reason: string,
      channelId = dm,
    ) => {
      await wipe();
      const before = (await messagesIn(channelId)).length;
      const created = await schedule(alice, { channelId });
      const undo = await arrange();
      await makeDue(created.id);
      expect(await tick()).toMatchObject({ sent: 0, blocked: 1 });
      expect((await messagesIn(channelId)).length).toBe(before); // NOT sent
      const [row] = await rows();
      expect(row).toMatchObject({ status: "blocked", blocked_reason: reason });
      const events = await eventsOf("m36.message.schedule_blocked");
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        organizationId: orgA,
        scheduledMessageId: created.id,
        channelId,
        senderUserId: alice,
        reason,
      });
      expect(JSON.stringify(events)).not.toContain("morphine"); // ids and a code only
      // a blocked row is never swept again (no second event, no send)
      expect(await tick()).toMatchObject({ sent: 0, blocked: 0 });
      expect(await eventsOf("m36.message.schedule_blocked")).toHaveLength(1);
      await undo();
      return created;
    };

    it("revoked member: blocked with not_member", async () => {
      await blockCase(async () => {
        await admin.query(
          "UPDATE channel_member SET removed_at=now() WHERE channel_id=$1 AND user_id=$2",
          [dm, alice],
        );
        return async () => {
          await admin.query(
            "UPDATE channel_member SET removed_at=NULL WHERE channel_id=$1 AND user_id=$2",
            [dm, alice],
          );
        };
      }, "not_member");
    });

    it("discharged patient (the channel is archived by the episode's close): blocked with channel_archived", async () => {
      await blockCase(async () => {
        await admin.query("UPDATE channel SET is_archived=true WHERE id=$1", [dm]);
        return async () => {
          await admin.query("UPDATE channel SET is_archived=false WHERE id=$1", [dm]);
        };
      }, "channel_archived");
    });

    it("revoked messaging.send: blocked with permission_revoked", async () => {
      await blockCase(async () => {
        grants.set(`${orgA}:${alice}`, new Set(["messaging.read"]));
        return async () => {
          grants.set(`${orgA}:${alice}`, new Set(["messaging.read", "messaging.send"]));
        };
      }, "permission_revoked");
    });

    it("announcement channel without messaging.announce: blocked; with it, sent", async () => {
      await blockCase(
        async () => async () => undefined,
        "announcement_not_permitted",
        announcement,
      );
      grants.set(
        `${orgA}:${alice}`,
        new Set(["messaging.read", "messaging.send", "messaging.announce"]),
      );
      const [row] = await rows();
      await service.reschedule(orgA, { userId: alice, id: row.id, scheduledFor: inFuture() });
      await makeDue(row.id);
      expect(await tick()).toMatchObject({ sent: 1 });
      grants.set(`${orgA}:${alice}`, new Set(["messaging.read", "messaging.send"]));
    });

    it("a blocked message can be rescheduled and then sends once access is back", async () => {
      const created = await blockCase(async () => {
        await admin.query("UPDATE channel SET is_archived=true WHERE id=$1", [dm]);
        return async () => {
          await admin.query("UPDATE channel SET is_archived=false WHERE id=$1", [dm]);
        };
      }, "channel_archived");
      const moved = await service.reschedule(orgA, {
        userId: alice,
        id: created.id,
        scheduledFor: inFuture(),
      });
      expect(moved).toMatchObject({ status: "pending", blockedReason: null });
      await makeDue(created.id);
      expect(await tick()).toMatchObject({ sent: 1 });
    });

    it("a reply whose root was deleted is blocked with parent_unavailable", async () => {
      await wipe();
      const root = await router.sendMessage(orgA, {
        channelId: dm,
        authorUserId: bob,
        body: "root",
        bodyKind: "plain",
      });
      const created = await schedule(alice, { parentMessageId: root.messageId });
      await router.deleteMessage(orgA, { userId: bob, messageId: root.messageId });
      await makeDue(created.id);
      expect(await tick()).toMatchObject({ blocked: 1 });
      const [row] = await rows();
      expect(row.blocked_reason).toBe("parent_unavailable");
    });

    it("a key-provider outage retries the row without counting an attempt or blocking it (never dispatch_failed)", async () => {
      await wipe();
      const created = await schedule(alice);
      await makeDue(created.id);
      failOpenFor = created.id;
      failOpenAsKeyOutage = true;
      try {
        for (let i = 0; i < 4; i += 1)
          expect(await tick()).toMatchObject({ sent: 0, blocked: 0, failed: 0 });
        expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 0 });
      } finally {
        failOpenFor = null;
        failOpenAsKeyOutage = false;
      }
      expect(await tick()).toMatchObject({ sent: 1 }); // the outage ended: it is delivered
      expect(await eventsOf("m36.message.schedule_blocked")).toHaveLength(0);
    });

    it("a send that keeps failing is blocked as dispatch_failed after three tries", async () => {
      await wipe();
      const created = await schedule(alice);
      await makeDue(created.id);
      failOpenFor = created.id;
      try {
        expect(await tick()).toMatchObject({ sent: 0, failed: 1 });
        expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 1 });
        await tick();
        expect(await tick()).toMatchObject({ blocked: 1 });
      } finally {
        failOpenFor = null;
      }
      expect((await rows())[0]).toMatchObject({
        status: "blocked",
        blocked_reason: "dispatch_failed",
      });
      expect(await eventsOf("m36.message.schedule_blocked")).toHaveLength(1);
    });
  });

  // Phase 2 gate "scheduled recheck" (docs/messaging-hub/03-phases-0-to-3.md): the remaining dispatch-time clauses -
  // a deactivated author, the Part 2 / patient-consent gate - plus the author-visible outcome and "no content leaks".
  describe("gate: re-check at delivery, author-visible outcome, nothing delivered or leaked", () => {
    const gateWarnings: string[] = [];
    let part2: "allow" | "deny" | "throw" = "allow";
    let careTeam: string;
    let gated: ReturnType<typeof createDbMessagingRouteService>;
    let gatedDispatcher: ScheduledSendDispatcher;
    let gatedService: ScheduledSendService;
    const patientId = "9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a";

    // The gate flag is shared mutable state: no test may inherit another's `deny`/`throw`, even after a failure.
    beforeEach(() => {
      part2 = "allow";
    });

    beforeAll(async () => {
      careTeam = (
        await admin.query(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
           VALUES ($1,'care_team',$2,'gate care team','care_related') RETURNING id`,
          [orgA, patientId],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
         VALUES ($1,$2,$3,'member','manual')`,
        [orgA, careTeam, alice],
      );
      const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
      const outbox = {
        publish: (tx: unknown, e: Record<string, unknown>) =>
          publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
      };
      const gatedPart2 = {
        allowedUserIds: async ({ userIds }: { userIds: readonly string[] }) => {
          if (part2 === "throw") throw new Error("M39 consent evaluator unavailable");
          return new Set(part2 === "allow" ? userIds : []);
        },
      };
      gated = createDbMessagingRouteService(handle.db, {
        kek: KEK,
        outbox: outbox as never,
        warn: (m) => gateWarnings.push(m),
        part2Gate: gatedPart2,
      });
      gatedService = createDbScheduledSendService({
        db: handle.db,
        cipher,
        maxPerUser: 3,
        canViewChannel: gated.canViewChannel,
      });
      // The dispatcher's own instance: an unreadable seam THROWS (retry) instead of reading as "cannot view" (block).
      const gatedStrict = createDbMessagingRouteService(handle.db, {
        kek: KEK,
        outbox: outbox as never,
        warn: (m) => gateWarnings.push(m),
        throwOnSeamUnavailable: true,
        part2Gate: gatedPart2,
      });
      gatedDispatcher = createScheduledSendDispatcher({
        db: handle.db,
        cipher,
        outbox,
        canViewChannel: gatedStrict.canViewChannel,
        permissionsFor: async (org, user) => grants.get(`${org}:${user}`) ?? new Set<string>(),
      });
    });

    const sentHints = async () => (await eventsOf("m36.message.sent")).length;

    /** Not delivered, no content in any event, the author sees `blocked` + reason, a colleague sees nothing. */
    async function expectRefused(
      id: string,
      channelId: string,
      reason: string,
      hintsBefore: number,
    ) {
      const msgs = (await messagesIn(channelId)).filter((m) => m.client_message_id === id);
      expect(msgs).toHaveLength(0);
      expect(await sentHints()).toBe(hintsBefore);
      const blockedEvents = await eventsOf("m36.message.schedule_blocked");
      expect(blockedEvents).toHaveLength(1);
      expect(blockedEvents[0].payload).toMatchObject({ scheduledMessageId: id, reason });
      expect(JSON.stringify(blockedEvents)).not.toContain("morphine");
      const mine = await gatedService.listMine(orgA, { userId: alice });
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ id, status: "blocked", blockedReason: reason });
      expect(await gatedService.listMine(orgA, { userId: bob })).toHaveLength(0);
    }

    it("a deactivated author: blocked with not_member, nothing delivered, author sees the state", async () => {
      await wipe();
      const hints = await sentHints();
      const created = await schedule(alice);
      await admin.query(`UPDATE "user" SET status='suspended' WHERE id=$1`, [alice]);
      try {
        await makeDue(created.id);
        expect(await gatedDispatcher.dispatchDueForOrg(orgA)).toMatchObject({
          sent: 0,
          blocked: 1,
        });
        await expectRefused(created.id, dm, "not_member", hints);
      } finally {
        await admin.query(`UPDATE "user" SET status='active' WHERE id=$1`, [alice]);
      }
    });

    it("a revoked organization membership: blocked with not_member, nothing delivered", async () => {
      await wipe();
      const hints = await sentHints();
      const created = await schedule(alice);
      await admin.query(
        `UPDATE membership SET status='revoked' WHERE user_id=$1 AND organization_id=$2`,
        [alice, orgA],
      );
      try {
        await makeDue(created.id);
        expect(await gatedDispatcher.dispatchDueForOrg(orgA)).toMatchObject({
          sent: 0,
          blocked: 1,
        });
        await expectRefused(created.id, dm, "not_member", hints);
      } finally {
        await admin.query(
          `UPDATE membership SET status='active' WHERE user_id=$1 AND organization_id=$2`,
          [alice, orgA],
        );
      }
    });

    it("a Part 2 / consent gate that now denies: blocked, nothing delivered; the same row sends once the gate admits", async () => {
      await wipe();
      const hints = await sentHints();
      part2 = "allow";
      const created = await gatedService.create(orgA, {
        userId: alice,
        channelId: careTeam,
        body: SECRET,
        scheduledFor: inFuture(),
        timeZone: "America/Chicago",
      });
      part2 = "deny"; // consent revoked / SUD flag raised between scheduling and send time
      await makeDue(created.id);
      expect(await gatedDispatcher.dispatchDueForOrg(orgA)).toMatchObject({ sent: 0, blocked: 1 });
      await expectRefused(created.id, careTeam, "not_member", hints);
      // a blocked row is not swept again
      expect(await gatedDispatcher.dispatchDueForOrg(orgA)).toMatchObject({ sent: 0, blocked: 0 });
      expect(await eventsOf("m36.message.schedule_blocked")).toHaveLength(1);

      // access restored: reschedule delivers exactly once, and a retried tick cannot repeat it
      part2 = "allow";
      await gatedService.reschedule(orgA, {
        userId: alice,
        id: created.id,
        scheduledFor: inFuture(),
      });
      await makeDue(created.id);
      const [a, b] = await Promise.all([
        gatedDispatcher.dispatchDueForOrg(orgA),
        gatedDispatcher.dispatchDueForOrg(orgA),
      ]);
      expect(a.sent + b.sent).toBe(1);
      expect(await gatedDispatcher.dispatchDueForOrg(orgA)).toMatchObject({ sent: 0 });
      const delivered = (await messagesIn(careTeam)).filter(
        (m) => m.client_message_id === created.id,
      );
      expect(delivered).toHaveLength(1);
      expect(await cipher.open(orgA, delivered[0].body_cipher)).toBe(SECRET);
      expect(await rows()).toHaveLength(0);
    });

    // An unreadable consent seam is an OUTAGE, not a verdict: never sent while consent is unknown (fail closed for the
    // send), but the row is not blocked for good either; later ticks retry it, bounded by the overdue window.
    const pendingRow = async () => (await rows())[0];
    const ago = (id: string, interval: string) =>
      admin.query(
        `UPDATE scheduled_message SET scheduled_for = now() - interval '${interval}' WHERE id=$1`,
        [id],
      );

    it("an unreadable consent seam never sends and does not block: the row stays pending, the outage is logged", async () => {
      await wipe();
      gateWarnings.length = 0; // earlier tests may have logged the same line; only THIS dispatch may satisfy the assertion
      const hints = await sentHints();
      const created = await gatedService.create(orgA, {
        userId: alice,
        channelId: careTeam,
        body: SECRET,
        scheduledFor: inFuture(),
      });
      part2 = "throw";
      await makeDue(created.id);
      expect(await gatedDispatcher.dispatchDueForOrg(orgA)).toMatchObject({
        sent: 0,
        blocked: 0,
        failed: 0,
      });
      expect(gateWarnings.some((w) => /denying access/.test(w))).toBe(true);
      expect(await pendingRow()).toMatchObject({ id: created.id, status: "pending", attempts: 0 });
      expect(
        (await messagesIn(careTeam)).filter((m) => m.client_message_id === created.id),
      ).toHaveLength(0);
      expect(await sentHints()).toBe(hints);
      expect(await eventsOf("m36.message.schedule_blocked")).toHaveLength(0);
    });

    it("an explicit consent denial still blocks at once (not_member): only an outage is retried", async () => {
      await wipe();
      const hints = await sentHints();
      const created = await gatedService.create(orgA, {
        userId: alice,
        channelId: careTeam,
        body: SECRET,
        scheduledFor: inFuture(),
      });
      part2 = "deny";
      await makeDue(created.id);
      expect(await gatedDispatcher.dispatchDueForOrg(orgA)).toMatchObject({ sent: 0, blocked: 1 });
      await expectRefused(created.id, careTeam, "not_member", hints);
    });

    it("a consent outage that outlasts the overdue window ends blocked (dispatch_failed) with one notice, nothing delivered", async () => {
      await wipe();
      const hints = await sentHints();
      const created = await gatedService.create(orgA, {
        userId: alice,
        channelId: careTeam,
        body: SECRET,
        scheduledFor: inFuture(),
      });
      part2 = "throw";
      await ago(created.id, "30 minutes"); // past OVERDUE_COUNTS_AS_ATTEMPT_MS: each failing tick is a real attempt
      expect(await gatedDispatcher.dispatchDueForOrg(orgA)).toMatchObject({
        blocked: 0,
        failed: 1,
      });
      expect(await pendingRow()).toMatchObject({ status: "pending", attempts: 1 });
      await gatedDispatcher.dispatchDueForOrg(orgA);
      expect(await gatedDispatcher.dispatchDueForOrg(orgA)).toMatchObject({ blocked: 1 });
      await expectRefused(created.id, careTeam, "dispatch_failed", hints);
    });

    it("a consent outage that clears sends the same row exactly once on a later tick", async () => {
      await wipe();
      const created = await gatedService.create(orgA, {
        userId: alice,
        channelId: careTeam,
        body: SECRET,
        scheduledFor: inFuture(),
      });
      part2 = "throw";
      await makeDue(created.id);
      await gatedDispatcher.dispatchDueForOrg(orgA);
      await gatedDispatcher.dispatchDueForOrg(orgA);
      expect(await pendingRow()).toMatchObject({ status: "pending" });
      part2 = "allow"; // consent service is back
      const [a, b] = await Promise.all([
        gatedDispatcher.dispatchDueForOrg(orgA),
        gatedDispatcher.dispatchDueForOrg(orgA),
      ]);
      expect(a.sent + b.sent).toBe(1);
      expect(await gatedDispatcher.dispatchDueForOrg(orgA)).toMatchObject({ sent: 0 });
      const delivered = (await messagesIn(careTeam)).filter(
        (m) => m.client_message_id === created.id,
      );
      expect(delivered).toHaveLength(1);
      expect(await cipher.open(orgA, delivered[0].body_cipher)).toBe(SECRET);
      expect(await rows()).toHaveLength(0);
      expect(await eventsOf("m36.message.schedule_blocked")).toHaveLength(0);
    });

    it("a still-valid scheduled message through the same gated path is delivered exactly once", async () => {
      await wipe();
      const created = await gatedService.create(orgA, {
        userId: alice,
        channelId: careTeam,
        body: SECRET,
        scheduledFor: inFuture(),
      });
      await makeDue(created.id);
      expect(await gatedDispatcher.dispatchDueForOrg(orgA)).toMatchObject({ sent: 1, blocked: 0 });
      expect(await gatedDispatcher.dispatchDueForOrg(orgA)).toMatchObject({ sent: 0, blocked: 0 });
      expect(
        (await messagesIn(careTeam)).filter((m) => m.client_message_id === created.id),
      ).toHaveLength(1);
      expect(await eventsOf("m36.message.schedule_blocked")).toHaveLength(0);
    });
  });

  describe("a request-less (no user) context (fix round 1, M4)", () => {
    it("can neither read a sealed body nor update nor delete anyone's row", async () => {
      await wipe();
      await schedule(alice);
      await schedule(bob);
      const asSystem = <T>(fn: (tx: any) => Promise<T>) =>
        withOrgContext(handle.db, systemOrgContext(orgA), fn);
      expect(await asSystem((tx) => tx.select().from(schema.scheduledMessages))).toHaveLength(0);
      await asSystem((tx) => tx.update(schema.scheduledMessages).set({ attempts: 2 }));
      await asSystem((tx) => tx.delete(schema.scheduledMessages));
      const left = await rows();
      expect(left).toHaveLength(2);
      expect(left.every((row) => row.attempts === 0)).toBe(true);
    });

    it("the sweep's narrow lister still sees due rows, and only id/owner/channel, only for its own org", async () => {
      await wipe();
      const created = await schedule(alice);
      await makeDue(created.id);
      const list = (org: string, ctx: string) =>
        withOrgContext(handle.db, systemOrgContext(ctx), (tx) =>
          tx.execute(sql`SELECT * FROM scheduled_message_due(${org}::uuid, 10)`),
        );
      const own = (await list(orgA, orgA)).rows as Array<Record<string, unknown>>;
      expect(own).toHaveLength(1);
      expect(Object.keys(own[0]!).sort()).toEqual(["channel_id", "id", "scheduled_for", "user_id"]);
      // Naming another org while bound to this one yields nothing.
      expect((await list(orgB, orgA)).rows).toHaveLength(0);
    });
  });

  describe("rescheduling a blocked row re-verifies access (fix round 3)", () => {
    it("refuses with a 404 once the sender lost the channel, and leaves the row blocked", async () => {
      await wipe();
      const created = await schedule(alice);
      await makeDue(created.id);
      await admin.query(
        "UPDATE channel_member SET removed_at=now() WHERE channel_id=$1 AND user_id=$2",
        [dm, alice],
      );
      try {
        expect(await tick()).toMatchObject({ blocked: 1 });
        await expect(
          service.reschedule(orgA, { userId: alice, id: created.id, scheduledFor: inFuture() }),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect((await rows())[0]).toMatchObject({
          status: "blocked",
          blocked_reason: "not_member",
        });
      } finally {
        await admin.query(
          "UPDATE channel_member SET removed_at=NULL WHERE channel_id=$1 AND user_id=$2",
          [dm, alice],
        );
      }
    });
  });

  describe("dependency failures vs. a stuck head of queue (fix round 2, S1)", () => {
    const makeDueAgo = (id: string, interval: string) =>
      admin.query(
        `UPDATE scheduled_message SET scheduled_for = now() - interval '${interval}' WHERE id=$1`,
        [id],
      );
    const gone = (userId: string) => (id: string) =>
      id === userId ? new NotFoundError("user", id) : null;

    it("three permanently failing head rows are blocked WITH a notice and do not starve a later good row", async () => {
      await wipe();
      const head = [await schedule(alice), await schedule(alice), await schedule(alice)];
      for (const row of head) await makeDueAgo(row.id, "5 minutes");
      const good = await schedule(bob);
      await makeDue(good.id);
      const before = (await messagesIn(dm)).length;
      resolverFault = gone(alice);
      try {
        expect(await tick()).toMatchObject({ sent: 1, blocked: 3 });
      } finally {
        resolverFault = null;
      }
      expect(await messagesIn(dm)).toHaveLength(before + 1);
      expect(await rows()).toHaveLength(3);
      expect((await rows()).every((row) => row.status === "blocked")).toBe(true);
      expect(await eventsOf("m36.message.schedule_blocked")).toHaveLength(3);
    });

    it("three head rows from ONE user failing transiently do not end the tick either", async () => {
      await wipe();
      const head = [await schedule(alice), await schedule(alice), await schedule(alice)];
      for (const row of head) await makeDueAgo(row.id, "5 minutes");
      const good = await schedule(bob);
      await makeDue(good.id);
      resolverFault = (id) => (id === alice ? new Error("flaky resolver for one user") : null);
      try {
        expect(await tick()).toMatchObject({ sent: 1, blocked: 0 });
      } finally {
        resolverFault = null;
      }
      expect((await rows()).filter((row) => row.status === "pending")).toHaveLength(3);
      expect((await rows()).every((row) => row.attempts === 0)).toBe(true);
    });

    it("a row overdue past the threshold counts the failure as a real attempt and ends up blocked with a notice", async () => {
      await wipe();
      const stuck = await schedule(alice);
      await makeDueAgo(stuck.id, "30 minutes");
      resolverFault = () => new Error("resolver keeps failing for this sender");
      try {
        await tick();
        expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 1 });
        await tick();
        expect(await tick()).toMatchObject({ blocked: 1 });
      } finally {
        resolverFault = null;
      }
      expect((await rows())[0]).toMatchObject({
        status: "blocked",
        blocked_reason: "dispatch_failed",
      });
      expect(await eventsOf("m36.message.schedule_blocked")).toHaveLength(1);
    });

    it("a long outage across distinct users burns no attempts even for rows far past the overdue threshold", async () => {
      await wipe();
      const created = [await schedule(alice), await schedule(bob), await schedule(erin)];
      for (const row of created) await makeDueAgo(row.id, "40 minutes");
      resolverFault = () => new Error("M3 resolver down for a long time");
      try {
        for (let i = 0; i < 4; i += 1) await tick();
      } finally {
        resolverFault = null;
      }
      expect((await rows()).every((row) => row.status === "pending" && row.attempts === 0)).toBe(
        true,
      );
      expect(await eventsOf("m36.message.schedule_blocked")).toHaveLength(0);
    });

    it("poison rows 90 minutes overdue behind a tripped tick still reach the attempt limit and block WITH notices", async () => {
      await wipe();
      const created = [await schedule(alice), await schedule(bob), await schedule(erin)];
      for (const row of created) await makeDueAgo(row.id, "90 minutes");
      resolverFault = () => new Error("deterministic failure for every sender");
      try {
        for (let i = 0; i < 3; i += 1) await tick();
      } finally {
        resolverFault = null;
      }
      const left = await rows();
      expect(left.every((row) => row.status === "blocked")).toBe(true);
      expect(left.every((row) => row.blocked_reason === "dispatch_failed")).toBe(true);
      expect(await eventsOf("m36.message.schedule_blocked")).toHaveLength(3);
    });

    it("rows overdue by 15-60 minutes behind a tripped tick are NOT counted (only past the hard cap)", async () => {
      await wipe();
      const created = [await schedule(alice), await schedule(bob), await schedule(erin)];
      for (const row of created) await makeDueAgo(row.id, "30 minutes");
      resolverFault = () => new Error("outage");
      try {
        for (let i = 0; i < 4; i += 1) await tick();
      } finally {
        resolverFault = null;
      }
      expect((await rows()).every((row) => row.status === "pending" && row.attempts === 0)).toBe(
        true,
      );
    });

    it("a genuine outage across distinct users burns no attempts for fresh rows and ends the tick early", async () => {
      await wipe();
      const created = [await schedule(alice), await schedule(bob), await schedule(erin)];
      for (const row of created) await makeDue(row.id);
      resolverFault = () => new Error("M3 resolver down");
      try {
        for (let i = 0; i < 4; i += 1) await tick();
      } finally {
        resolverFault = null;
      }
      expect((await rows()).every((row) => row.status === "pending" && row.attempts === 0)).toBe(
        true,
      );
    });
  });

  describe("dependency outages (fix round 1, M1)", () => {
    it("a resolver outage never burns the row's attempts; it sends once the dependency recovers", async () => {
      await wipe();
      const created = await schedule(alice);
      await makeDue(created.id);
      const before = (await messagesIn(dm)).length;
      resolverFault = () => new Error("simulated M3 resolver outage");
      try {
        for (let i = 0; i < 5; i += 1) await tick();
      } finally {
        resolverFault = null;
      }
      expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 0 });
      expect(await eventsOf("m36.message.schedule_blocked")).toHaveLength(0);
      expect(await tick()).toMatchObject({ sent: 1 });
      expect(await messagesIn(dm)).toHaveLength(before + 1);
      expect(await rows()).toHaveLength(0);
    });
  });

  describe("erase", () => {
    it("is removed with its channel and with the tenant erase", async () => {
      await wipe();
      const orgC = await seedOrg("wp26c");
      const dave = await seedUser("wp26-dave@x.test", orgC);
      const chanC = await seedAnnouncement(orgC);
      const chanC2 = await seedAnnouncement(orgC);
      for (const channelId of [chanC, chanC2]) {
        await createDbScheduledSendService({
          db: handle.db,
          cipher,
          canViewChannel: router.canViewChannel,
        }).create(orgC, {
          userId: dave,
          channelId,
          body: "c",
          scheduledFor: inFuture(),
        });
      }
      await schedule(alice);
      expect(await rows(orgC)).toHaveLength(2);
      await admin.query("DELETE FROM channel WHERE id=$1", [chanC2]);
      expect(await rows(orgC)).toHaveLength(1);
      const store = createDrizzleMessagingEraseStore(destroyer.db, {
        soleTenantUserIds: async () => [],
      });
      await eraseTenantMessaging(orgC, store);
      expect(await rows(orgC)).toHaveLength(0);
      expect(await rows(orgA)).toHaveLength(1); // org A survives org C's erase
    });
  });

  // Bound is not computing: the SAME Worker the composition root registers must pick a job off a real queue and send.
  describe.skipIf(!REDIS_IS_LOCAL)("on real BullMQ (CHARTWARDEN_TEST_REDIS_URL, local only)", () => {
    const url = new URL(REDIS_URL ?? "redis://localhost:6379");
    const connection = { host: url.hostname, port: Number(url.port || 6379) };
    const wipeQueue = async () => {
      const q = new Queue(MESSAGING_QUEUES.scheduledSend, { connection });
      await q.obliterate({ force: true }).catch(() => undefined);
      await q.close();
    };
    beforeAll(wipeQueue);
    afterAll(wipeQueue);

    it("registers one per-minute repeatable and the worker sends a due message when a tick runs", async () => {
      await wipe();
      const created = await schedule(alice);
      await makeDue(created.id);
      const before = (await messagesIn(dm)).length;
      const queues = await scheduleM36ScheduledSendJobs(connection);
      const repeatables = await queues[0]!.getRepeatableJobs();
      expect(repeatables).toHaveLength(1);
      expect(repeatables[0]?.pattern).toBe(MESSAGING_JOB_SCHEDULES.scheduledSend);
      const workers = registerM36ScheduledSendWorker({
        connection,
        dispatcher,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: orgA }] },
      });
      try {
        await queues[0]!.add("run-now", {});
        const deadline = Date.now() + 15_000;
        while ((await rows()).length > 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        expect(await rows()).toHaveLength(0);
        expect((await messagesIn(dm)).length).toBe(before + 1);
      } finally {
        await Promise.all(workers.map((w) => w.close()));
        await Promise.all(queues.map((q) => q.close()));
      }
    });
  });
});
